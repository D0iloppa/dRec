// 스플랜더 엔진 — 서버 권위 보석 경제 보드게임. 공개 정보(예약 카드 내용만 소유자 한정).
// 턴 = 한 행동: 보석3(서로 다른 3색) / 같은색2(더미 ≥4) / 예약(+골드) / 구매(보너스 할인·골드 충당).
//   보석을 가져온 뒤 10개 초과 보유 시 'discard'로 10개까지 반납해야 턴이 넘어간다.
//   구매 후 귀족 방문 자동 판정(+3). 어떤 플레이어가 15점에 도달하면 그 라운드를 끝까지 진행 후 승자 판정.
import { GameEngine, Room, type GameResult } from '@dopl/core';
import type { GameAction, PlayerView } from '@dopl/protocol';

// 보석 색: emerald=초록, sapphire=파랑, ruby=빨강, diamond=흰색, onyx=검정. gold=만능(와일드).
export type Color = 'emerald' | 'sapphire' | 'ruby' | 'diamond' | 'onyx';
type Token = Color | 'gold';
type ColorMap = Record<Color, number>;

const COLORS: Color[] = ['emerald', 'sapphire', 'ruby', 'diamond', 'onyx'];

const TURN_SECONDS = 90;
const WIN_PRESTIGE = 15;
const TOKEN_LIMIT = 10;
const MAX_RESERVED = 3;

// 승리 보상 (IQ는 economy 체감식이 다시 보정)
const WIN_REWARD = { iq: 12, coins: 40 };
const LOSE_REWARD = { iq: 2, coins: 5 };

interface Card {
  id: number;
  tier: 1 | 2 | 3;
  cost: Partial<ColorMap>;
  bonus: Color;
  points: number;
}

interface Noble {
  id: number;
  requirement: Partial<ColorMap>;
  points: number;
}

interface PlayerState {
  tokens: Record<Token, number>;
  bonuses: ColorMap; // 보유 개발카드 색별 개수(=영구 할인)
  prestige: number;
  cards: Card[]; // 구매한 개발카드(테이블로)
  reserved: Card[]; // 예약 카드(내용은 소유자만 view)
  noblesCount: number;
}

function zeroColors(): ColorMap {
  return { emerald: 0, sapphire: 0, ruby: 0, diamond: 0, onyx: 0 };
}
function zeroTokens(): Record<Token, number> {
  return { emerald: 0, sapphire: 0, ruby: 0, diamond: 0, onyx: 0, gold: 0 };
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// ── 카드 정의 ──────────────────────────────────────────────────
// 1차: 실제 카드의 대표 부분집합. tier1 저가·저점, tier3 고가·고점.
let CARD_ID = 0;
function card(tier: 1 | 2 | 3, bonus: Color, points: number, cost: Partial<ColorMap>): Card {
  return { id: ++CARD_ID, tier, cost, bonus, points };
}

// 각 tier 카드 풀(셔플 후 4장씩 공개). e/s/r/d/o = 색 축약.
const TIER1: Card[] = [
  card(1, 'emerald', 0, { sapphire: 1, ruby: 1, diamond: 1, onyx: 1 }),
  card(1, 'emerald', 0, { ruby: 2, onyx: 1 }),
  card(1, 'emerald', 0, { diamond: 2, sapphire: 1 }),
  card(1, 'sapphire', 0, { emerald: 1, ruby: 1, diamond: 1, onyx: 1 }),
  card(1, 'sapphire', 0, { emerald: 2, onyx: 1 }),
  card(1, 'sapphire', 1, { diamond: 4 }),
  card(1, 'ruby', 0, { emerald: 1, sapphire: 1, diamond: 1, onyx: 1 }),
  card(1, 'ruby', 0, { diamond: 2, onyx: 2 }),
  card(1, 'ruby', 0, { sapphire: 1, ruby: 2 }),
  card(1, 'diamond', 0, { emerald: 1, sapphire: 1, ruby: 1, onyx: 1 }),
  card(1, 'diamond', 0, { sapphire: 2, ruby: 2 }),
  card(1, 'diamond', 1, { onyx: 4 }),
  card(1, 'onyx', 0, { emerald: 1, sapphire: 1, ruby: 1, diamond: 1 }),
  card(1, 'onyx', 0, { emerald: 2, diamond: 1 }),
  card(1, 'onyx', 1, { ruby: 4 }),
];

const TIER2: Card[] = [
  card(2, 'emerald', 1, { sapphire: 3, emerald: 2, diamond: 2 }),
  card(2, 'emerald', 2, { sapphire: 5 }),
  card(2, 'emerald', 3, { emerald: 6 }),
  card(2, 'sapphire', 1, { sapphire: 2, diamond: 2, onyx: 3 }),
  card(2, 'sapphire', 2, { onyx: 5 }),
  card(2, 'sapphire', 3, { sapphire: 6 }),
  card(2, 'ruby', 1, { ruby: 2, onyx: 2, diamond: 3 }),
  card(2, 'ruby', 2, { diamond: 5 }),
  card(2, 'ruby', 3, { ruby: 6 }),
  card(2, 'diamond', 1, { emerald: 3, ruby: 2, diamond: 2 }),
  card(2, 'diamond', 2, { ruby: 5 }),
  card(2, 'diamond', 3, { diamond: 6 }),
  card(2, 'onyx', 1, { emerald: 2, ruby: 3, onyx: 2 }),
  card(2, 'onyx', 2, { emerald: 5 }),
  card(2, 'onyx', 3, { onyx: 6 }),
];

const TIER3: Card[] = [
  card(3, 'emerald', 4, { sapphire: 7 }),
  card(3, 'emerald', 4, { emerald: 3, sapphire: 6, diamond: 3 }),
  card(3, 'emerald', 5, { emerald: 3, sapphire: 7 }),
  card(3, 'sapphire', 4, { diamond: 7 }),
  card(3, 'sapphire', 4, { sapphire: 3, diamond: 3, onyx: 6 }),
  card(3, 'sapphire', 5, { sapphire: 3, diamond: 7 }),
  card(3, 'ruby', 4, { onyx: 7 }),
  card(3, 'ruby', 4, { ruby: 3, diamond: 6, onyx: 3 }),
  card(3, 'ruby', 5, { ruby: 3, onyx: 7 }),
  card(3, 'diamond', 4, { ruby: 7 }),
  card(3, 'diamond', 4, { emerald: 6, ruby: 3, diamond: 3 }),
  card(3, 'diamond', 5, { ruby: 7, diamond: 3 }),
  card(3, 'onyx', 4, { emerald: 7 }),
  card(3, 'onyx', 4, { emerald: 3, ruby: 6, onyx: 3 }),
  card(3, 'onyx', 5, { emerald: 7, onyx: 3 }),
];

let NOBLE_ID = 0;
function noble(requirement: Partial<ColorMap>): Noble {
  return { id: ++NOBLE_ID, requirement, points: 3 };
}
const NOBLE_POOL: Noble[] = [
  noble({ emerald: 4, ruby: 4 }),
  noble({ diamond: 4, onyx: 4 }),
  noble({ sapphire: 4, diamond: 4 }),
  noble({ emerald: 3, sapphire: 3, ruby: 3 }),
  noble({ ruby: 3, onyx: 3, diamond: 3 }),
];

export class SplendorEngine extends GameEngine {
  private order: string[] = []; // 턴 순서(playerId)
  private turnIdx = 0;
  private round = 0;
  private states = new Map<string, PlayerState>();

  private pool: Record<Token, number> = zeroTokens(); // 공용 토큰 풀
  private decks: Record<1 | 2 | 3, Card[]> = { 1: [], 2: [], 3: [] };
  private board: Record<1 | 2 | 3, (Card | null)[]> = { 1: [], 2: [], 3: [] };
  private nobles: Noble[] = [];

  private endTriggered = false; // 누군가 15점 도달 → 현재 라운드 끝까지
  private winnerId: string | null = null;
  private log: string[] = [];
  private finalBoard: { name: string; score: number; iqDelta: number; coinsDelta: number; won: boolean }[] = [];

  constructor(private room: Room) {
    super();
  }

  private say(text: string): void {
    this.log.push(text);
  }
  private cur(): string {
    return this.order[this.turnIdx]!;
  }
  private st(id: string): PlayerState {
    return this.states.get(id)!;
  }
  private name(id: string): string {
    return this.room.player(id)?.name ?? '???';
  }

  // ── 시작/세팅 ───────────────────────────────────────────────
  async start(requesterId: string): Promise<void> {
    if (!this.room.isHost(requesterId)) throw new Error('호스트만 시작할 수 있습니다.');
    if (this.room.phase !== 'lobby') throw new Error('이미 시작된 게임입니다.');
    const players = this.room.list();
    const n = players.length;
    if (n < 2 || n > 4) throw new Error('스플랜더는 2~4명이 필요합니다.');

    // 토큰 공급: 2p→4, 3p→5, 4p→7 (각 색), 골드는 항상 5
    const perColor = n === 2 ? 4 : n === 3 ? 5 : 7;
    this.pool = zeroTokens();
    for (const c of COLORS) this.pool[c] = perColor;
    this.pool.gold = 5;

    // 덱 셔플 + 4장씩 공개
    for (const tier of [1, 2, 3] as const) {
      const deck = shuffle(tier === 1 ? TIER1 : tier === 2 ? TIER2 : TIER3);
      this.board[tier] = deck.splice(0, 4);
      this.decks[tier] = deck;
    }

    // 귀족 = playerCount + 1
    this.nobles = shuffle(NOBLE_POOL).slice(0, n + 1);

    this.states.clear();
    for (const p of players) {
      this.states.set(p.playerId, {
        tokens: zeroTokens(),
        bonuses: zeroColors(),
        prestige: 0,
        cards: [],
        reserved: [],
        noblesCount: 0,
      });
      p.iqDelta = 0;
      p.coinsDelta = 0;
    }

    this.order = shuffle(players.map((p) => p.playerId));
    this.turnIdx = 0;
    this.round = 1;
    this.endTriggered = false;
    this.winnerId = null;
    this.room.phase = 'playing';
    this.say(`💎 스플랜더 시작! (${n}명) — 먼저 15점에 도달하면 그 라운드를 끝으로 승부가 가려집니다.`);
    this.say(`${this.name(this.cur())}님의 차례입니다.`);
    this.room.startTimer(TURN_SECONDS, () => this.onTimeout());
  }

  // ── 턴 진행 ─────────────────────────────────────────────────
  private onTimeout(): void {
    // 타임아웃 = 패스(행동 없이 턴 넘김). 토큰 초과 상태였다면 무작위 반납.
    const me = this.st(this.cur());
    if (this.tokenCount(me) > TOKEN_LIMIT) {
      while (this.tokenCount(me) > TOKEN_LIMIT) {
        const t = (['gold', ...COLORS] as Token[]).find((x) => me.tokens[x] > 0)!;
        me.tokens[t] -= 1;
        this.pool[t] += 1;
      }
    }
    this.say(`⏳ ${this.name(this.cur())}님이 시간 초과로 턴을 넘겼습니다.`);
    this.advance();
  }

  private advance(): void {
    this.room.clearTimer();
    // 종료 트리거가 켜졌고, 한 라운드를 모두 돌아 첫 시작 플레이어로 돌아오면 게임 끝.
    const wasLast = this.turnIdx === this.order.length - 1;
    this.turnIdx = (this.turnIdx + 1) % this.order.length;
    if (wasLast) this.round += 1;
    if (this.endTriggered && wasLast) {
      this.end();
      return;
    }
    this.say(`${this.name(this.cur())}님의 차례입니다.`);
    this.room.startTimer(TURN_SECONDS, () => this.onTimeout());
  }

  private tokenCount(s: PlayerState): number {
    return (['gold', ...COLORS] as Token[]).reduce((sum, t) => sum + s.tokens[t], 0);
  }

  // ── 행동 ────────────────────────────────────────────────────
  onAction(playerId: string, action: GameAction): void {
    if (this.room.phase !== 'playing') throw new Error('게임이 진행 중이 아닙니다.');
    if (playerId !== this.cur()) throw new Error('당신의 차례가 아닙니다.');
    const me = this.st(playerId);
    const over = this.tokenCount(me) > TOKEN_LIMIT;

    // 토큰 초과 상태에서는 'discard'만 허용
    if (over && action.kind !== 'discard') throw new Error('보석이 10개를 넘었습니다. 먼저 반납하세요.');

    switch (action.kind) {
      case 'takeThree':
        this.takeThree(me, action);
        break;
      case 'takeTwo':
        this.takeTwo(me, action);
        break;
      case 'reserve':
        this.reserve(me, action);
        break;
      case 'buy':
        this.buy(me, action);
        break;
      case 'discard':
        this.discard(me, action);
        return; // discard는 턴을 넘기지 않음(아래 마무리 분기에서 처리)
      default:
        throw new Error('알 수 없는 행동입니다.');
    }

    // 행동 후 토큰 초과면 턴을 넘기지 않고 반납을 기다린다.
    if (this.tokenCount(me) > TOKEN_LIMIT) return;
    this.afterTurn(me, playerId);
  }

  // 보석 반납 처리 — 10개까지 내려간 뒤 비로소 턴 마무리.
  private discard(me: PlayerState, action: GameAction): void {
    const color = action.color as Token;
    if (!color || me.tokens[color] === undefined) throw new Error('반납할 색을 지정하세요.');
    if (me.tokens[color] <= 0) throw new Error('해당 보석이 없습니다.');
    if (this.tokenCount(me) <= TOKEN_LIMIT) throw new Error('반납할 필요가 없습니다.');
    me.tokens[color] -= 1;
    this.pool[color] += 1;
    if (this.tokenCount(me) <= TOKEN_LIMIT) {
      this.afterTurn(me, this.cur());
    }
  }

  // 턴 마무리 — 귀족 방문 판정 후 종료 트리거 확인, 다음 턴.
  private afterTurn(me: PlayerState, playerId: string): void {
    this.checkNoble(me, playerId);
    if (me.prestige >= WIN_PRESTIGE) this.endTriggered = true;
    this.advance();
  }

  private takeThree(me: PlayerState, action: GameAction): void {
    const colors = action.colors as Color[];
    if (!Array.isArray(colors) || colors.length !== 3) throw new Error('서로 다른 3색을 골라야 합니다.');
    if (new Set(colors).size !== 3) throw new Error('서로 다른 3색을 골라야 합니다.');
    for (const c of colors) {
      if (!COLORS.includes(c)) throw new Error('잘못된 보석 색입니다.');
      if (this.pool[c] < 1) throw new Error('남지 않은 보석을 선택했습니다.');
    }
    for (const c of colors) {
      this.pool[c] -= 1;
      me.tokens[c] += 1;
    }
    this.say(`${this.name(this.cur())}님이 보석 3개를 가져갔습니다.`);
  }

  private takeTwo(me: PlayerState, action: GameAction): void {
    const color = action.color as Color;
    if (!COLORS.includes(color)) throw new Error('잘못된 보석 색입니다.');
    if (this.pool[color] < 4) throw new Error('같은색 2개는 더미에 4개 이상 있을 때만 가능합니다.');
    this.pool[color] -= 2;
    me.tokens[color] += 2;
    this.say(`${this.name(this.cur())}님이 ${color} 2개를 가져갔습니다.`);
  }

  // 보드/덱에서 카드 찾기 — fromReserved면 예약 목록, blind면 덱 최상단.
  private reserve(me: PlayerState, action: GameAction): void {
    if (me.reserved.length >= MAX_RESERVED) throw new Error('예약은 최대 3장까지 가능합니다.');
    const tier = action.tier as 1 | 2 | 3;
    if (![1, 2, 3].includes(tier)) throw new Error('잘못된 티어입니다.');
    let picked: Card | null = null;
    if (action.cardId === 'top' || action.cardId === undefined) {
      // 블라인드: 덱 최상단
      picked = this.decks[tier].shift() ?? null;
      if (!picked) throw new Error('덱이 비어 예약할 수 없습니다.');
    } else {
      const slot = this.board[tier].findIndex((c) => c?.id === action.cardId);
      if (slot < 0) throw new Error('해당 카드를 찾을 수 없습니다.');
      picked = this.board[tier][slot]!;
      this.board[tier][slot] = this.decks[tier].shift() ?? null;
    }
    me.reserved.push(picked);
    if (this.pool.gold > 0) {
      this.pool.gold -= 1;
      me.tokens.gold += 1;
    }
    this.say(`${this.name(this.cur())}님이 티어${tier} 카드를 예약했습니다.`);
  }

  private buy(me: PlayerState, action: GameAction): void {
    const cardId = action.cardId as number;
    let from: 'board' | 'reserved' | null = null;
    let target: Card | null = null;
    let slot = -1;
    let tier: 1 | 2 | 3 = 1;

    const ri = me.reserved.findIndex((c) => c.id === cardId);
    if (ri >= 0) {
      from = 'reserved';
      target = me.reserved[ri]!;
    } else {
      for (const t of [1, 2, 3] as const) {
        const s = this.board[t].findIndex((c) => c?.id === cardId);
        if (s >= 0) {
          from = 'board';
          target = this.board[t][s]!;
          slot = s;
          tier = t;
          break;
        }
      }
    }
    if (!target) throw new Error('구매할 카드를 찾을 수 없습니다.');

    // 비용 = 카드 cost − 보너스. 부족분은 골드로 충당.
    const pay: Partial<Record<Token, number>> = {};
    let goldNeed = 0;
    for (const c of COLORS) {
      const cost = target.cost[c] ?? 0;
      const after = Math.max(0, cost - me.bonuses[c]);
      const have = me.tokens[c];
      if (have >= after) {
        if (after > 0) pay[c] = after;
      } else {
        if (have > 0) pay[c] = have;
        goldNeed += after - have;
      }
    }
    if (goldNeed > me.tokens.gold) throw new Error('보석(골드 포함)이 부족합니다.');

    // 지불 — 토큰은 풀로 반납.
    for (const c of COLORS) {
      const amt = pay[c] ?? 0;
      if (amt > 0) {
        me.tokens[c] -= amt;
        this.pool[c] += amt;
      }
    }
    if (goldNeed > 0) {
      me.tokens.gold -= goldNeed;
      this.pool.gold += goldNeed;
    }

    // 획득 — 테이블로에 추가, 보너스/점수 반영.
    me.cards.push(target);
    me.bonuses[target.bonus] += 1;
    me.prestige += target.points;

    if (from === 'reserved') {
      me.reserved.splice(ri, 1);
    } else {
      this.board[tier][slot] = this.decks[tier].shift() ?? null;
    }
    this.say(`${this.name(this.cur())}님이 ${target.bonus} 카드(${target.points}점)를 구매했습니다.`);
  }

  // 구매 후 귀족 방문 자동 판정 — 보너스가 요구를 충족하는 첫 귀족을 획득.
  private checkNoble(me: PlayerState, playerId: string): void {
    const idx = this.nobles.findIndex((nb) => COLORS.every((c) => me.bonuses[c] >= (nb.requirement[c] ?? 0)));
    if (idx < 0) return;
    const nb = this.nobles.splice(idx, 1)[0]!;
    me.prestige += nb.points;
    me.noblesCount += 1;
    this.say(`👑 ${this.name(playerId)}님이 귀족의 방문을 받았습니다! (+${nb.points}점)`);
  }

  // ── 종료/결과 ───────────────────────────────────────────────
  private end(): void {
    this.room.clearTimer();
    this.room.phase = 'ended';
    // 승자 = 최고 점수, 동률 시 개발카드 적은 쪽.
    const ranked = this.order
      .map((id) => ({ id, s: this.st(id) }))
      .sort((a, b) => b.s.prestige - a.s.prestige || a.s.cards.length - b.s.cards.length);
    this.winnerId = ranked[0]!.id;

    for (const { id, s } of ranked) {
      const p = this.room.player(id)!;
      const won = id === this.winnerId;
      p.iqDelta = won ? WIN_REWARD.iq : LOSE_REWARD.iq;
      p.coinsDelta = won ? WIN_REWARD.coins : LOSE_REWARD.coins;
    }
    this.finalBoard = ranked.map(({ id, s }) => ({
      name: this.name(id),
      score: s.prestige,
      iqDelta: (this.room.player(id)?.iqDelta as number) ?? 0,
      coinsDelta: (this.room.player(id)?.coinsDelta as number) ?? 0,
      won: id === this.winnerId,
    }));
    this.say(`🏁 게임 종료! 🏆 ${this.name(this.winnerId)}님이 ${ranked[0]!.s.prestige}점으로 승리했습니다!`);
  }

  // ── 직렬화 ──────────────────────────────────────────────────
  // 공개 정보: 각 플레이어 토큰/보너스/점수/예약 수(예약 내용은 소유자만).
  playerView(player: PlayerView, _viewerId: string): Record<string, unknown> {
    const p = player as unknown as { playerId: string };
    const s = this.states.get(p.playerId);
    if (!s) return {};
    return {
      tokens: s.tokens,
      bonuses: s.bonuses,
      prestige: s.prestige,
      cardCount: s.cards.length,
      reservedCount: s.reserved.length,
      noblesCount: s.noblesCount,
    };
  }

  viewFor(viewerId: string): unknown {
    const meState = this.states.get(viewerId);
    const players = this.order.map((id) => {
      const s = this.st(id);
      return {
        id,
        name: this.name(id),
        prestige: s.prestige,
        bonuses: s.bonuses,
        tokens: s.tokens,
        cardCount: s.cards.length,
        reservedCount: s.reserved.length,
        noblesCount: s.noblesCount,
      };
    });
    const v: Record<string, unknown> = {
      mode: 'splendor',
      log: this.log.slice(-40),
      tokenPool: this.pool,
      tiers: {
        tier1: this.board[1],
        tier2: this.board[2],
        tier3: this.board[3],
      },
      deckCounts: { tier1: this.decks[1].length, tier2: this.decks[2].length, tier3: this.decks[3].length },
      nobles: this.nobles,
      round: this.round,
      turnPlayerId: this.order.length ? this.cur() : null,
      isMyTurn: this.order.length > 0 && viewerId === this.cur(),
      mustDiscard: !!meState && viewerId === this.cur() && this.tokenCount(meState) > TOKEN_LIMIT,
      myReserved: meState ? meState.reserved : [],
      endTriggered: this.endTriggered,
      players,
    };
    if (this.room.phase === 'ended') {
      v.winnerId = this.winnerId;
      v.finalBoard = this.finalBoard;
    }
    return v;
  }

  results(): GameResult[] {
    return this.room.list().map((p) => ({
      userId: p.userId,
      iqDelta: (p.iqDelta as number) ?? 0,
      coinsDelta: (p.coinsDelta as number) ?? 0,
      won: this.winnerId !== null && p.playerId === this.winnerId,
    }));
  }
}
