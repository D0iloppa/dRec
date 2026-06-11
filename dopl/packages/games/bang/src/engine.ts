// 뱅! 엔진 — 서부극 카드 게임. 시스템이 딜러를 대신한다.
// 진행: 자리(참가 순서)를 원형으로, 현재 차례 플레이어가 (1)드로우2 (2)카드 플레이 (3)손패 정리 후 턴 종료.
//       BANG!/Gatling/Indians/Duel 등은 대상이 Missed!/BANG!로 반응하는 pending 서브상태로 턴을 잠근다.
// 역할은 보안관만 전체 공개, 나머지는 사망/종료 시 공개. 보안관+부하 vs 무법자, 그리고 배신자.
// 보류: Barrel/Scope/Mustang/Jail/Dynamite, 캐릭터 고유 능력, 죽음 시 Beer 셀프 세이브.
import { GameEngine, Room, type GameResult } from '@dopl/core';
import type { GameAction, PlayerView } from '@dopl/protocol';

export type Role = 'sheriff' | 'deputy' | 'outlaw' | 'renegade';
type Team = 'law' | 'outlaw' | 'renegade';
type TurnPhase = 'draw' | 'play' | 'discard';

// 카드 식별자 (덱/손패는 코드 배열로 보유)
type CardCode =
  | 'bang' | 'missed' | 'beer' | 'saloon' | 'stagecoach' | 'wellsfargo'
  | 'panic' | 'catbalou' | 'gatling' | 'indians' | 'duel' | 'generalstore'
  | 'volcanic' | 'schofield' | 'remington' | 'revcarabine' | 'winchester';

const TURN_SECONDS = 90;
const REACT_SECONDS = 20;
const MAX_LIFE_BONUS = 0; // 최대 체력 = 시작 체력 (캐릭터 보너스 보류)

const ROLE_LABEL: Record<Role, string> = { sheriff: '보안관', deputy: '부보안관', outlaw: '무법자', renegade: '배신자' };
const ROLE_ICON: Record<Role, string> = { sheriff: '⭐', deputy: '🎖️', outlaw: '🐴', renegade: '🃏' };

const CARD_LABEL: Record<CardCode, string> = {
  bang: 'BANG!', missed: '빗나감!', beer: '맥주', saloon: '술집', stagecoach: '역마차', wellsfargo: '웰스파고',
  panic: '비상!', catbalou: '캣발루', gatling: '개틀링', indians: '인디언!', duel: '결투', generalstore: '잡화점',
  volcanic: '볼캐닉', schofield: '스코필드', remington: '레밍턴', revcarabine: '리볼빙카빈', winchester: '윈체스터',
};

// 무기 → 사거리 (콜트45는 카드가 아닌 기본 무기, 사거리 1)
const WEAPON_RANGE: Partial<Record<CardCode, number>> = {
  volcanic: 1, schofield: 2, remington: 3, revcarabine: 4, winchester: 5,
};

// 승리 보상 (마피아 체감식 크기 미러)
const WIN = { iq: 12, coins: 40 };
const LOSE_IQ = -3;

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// 대표 덱(~50장) — 위 카드의 합리적 배수 + 무기.
function buildDeck(): CardCode[] {
  const deck: CardCode[] = [];
  const add = (c: CardCode, n: number) => { for (let i = 0; i < n; i++) deck.push(c); };
  add('bang', 18);
  add('missed', 10);
  add('beer', 5);
  add('panic', 3);
  add('catbalou', 3);
  add('stagecoach', 2);
  add('wellsfargo', 1);
  add('saloon', 1);
  add('gatling', 1);
  add('indians', 2);
  add('duel', 2);
  add('generalstore', 1);
  add('volcanic', 1);
  add('schofield', 2);
  add('remington', 1);
  add('revcarabine', 1);
  add('winchester', 1);
  return shuffle(deck);
}

// pending 반응 서브상태. 턴을 잠그고 대상의 응답을 기다린다.
interface Pending {
  kind: 'bang' | 'gatling' | 'indians' | 'duel' | 'generalstore';
  sourceId: string; // 효과를 건 플레이어
  // bang/gatling/indians: 응답 대기 중인 플레이어들 (순서대로)
  waiting: string[];
  // duel: 현재 BANG!을 내야 하는 사람 (없으면 -1 데미지)
  duelTurn?: string;
  // generalstore: 공개된 카드 풀 + 픽 순서
  pool?: CardCode[];
  pickOrder?: string[];
  pickIndex?: number;
  // gatling/indians 응답 결과 누적(이미 응답한 사람)
  responded?: Set<string>;
}

export class BangEngine extends GameEngine {
  private order: string[] = []; // 자리 원형(참가 순서)
  private turnIdx = 0;
  private turnPhase: TurnPhase | null = null;
  private bangUsedThisTurn = false;

  private deck: CardCode[] = [];
  private discard: CardCode[] = [];
  private hands = new Map<string, CardCode[]>(); // playerId → 손패
  private pending: Pending | null = null;

  private winner: Team | null = null;
  private log: string[] = [];
  private finalBoard: { name: string; iqDelta: number; coinsDelta: number; won: boolean }[] = [];

  constructor(private room: Room) {
    super();
  }

  // ── 헬퍼 ────────────────────────────────────────────────────
  private alive() {
    return this.order.map((id) => this.room.player(id)!).filter((p) => p && p.alive !== false);
  }
  private aliveIds(): string[] {
    return this.alive().map((p) => p.playerId);
  }
  private role(p: { [key: string]: unknown }): Role {
    return p.role as Role;
  }
  private team(r: Role): Team {
    return r === 'sheriff' || r === 'deputy' ? 'law' : r === 'renegade' ? 'renegade' : 'outlaw';
  }
  private hand(id: string): CardCode[] {
    return this.hands.get(id) ?? [];
  }
  private say(text: string) {
    this.log.push(text);
  }
  private weaponOf(p: { [key: string]: unknown }): CardCode | null {
    return (p.weapon as CardCode | null) ?? null;
  }
  private rangeOf(p: { [key: string]: unknown }): number {
    const w = this.weaponOf(p);
    return w ? WEAPON_RANGE[w] ?? 1 : 1;
  }
  private maxLifeOf(p: { [key: string]: unknown }): number {
    return ((p.maxLife as number) ?? 4) + MAX_LIFE_BONUS;
  }

  // 생존자 원형에서 a→b 거리 (양방향 최소 스텝)
  private distance(aId: string, bId: string): number {
    const ring = this.aliveIds();
    const ia = ring.indexOf(aId);
    const ib = ring.indexOf(bId);
    if (ia < 0 || ib < 0) return Infinity;
    const n = ring.length;
    const cw = (ib - ia + n) % n;
    const ccw = (ia - ib + n) % n;
    return Math.min(cw, ccw);
  }

  // 덱에서 n장 드로우 (소진 시 버린 더미 셔플 재투입)
  private draw(n: number): CardCode[] {
    const out: CardCode[] = [];
    for (let i = 0; i < n; i++) {
      if (this.deck.length === 0) {
        if (this.discard.length === 0) break;
        this.deck = shuffle(this.discard);
        this.discard = [];
        this.say('🔁 덱이 떨어져 버린 더미를 섞어 다시 채웁니다.');
      }
      const c = this.deck.pop();
      if (c) out.push(c);
    }
    return out;
  }

  // 손패에서 카드 1장 제거 (인덱스). 성공 시 카드 코드 반환.
  private takeFromHand(id: string, idx: number): CardCode | null {
    const h = this.hand(id);
    if (idx < 0 || idx >= h.length) return null;
    const [c] = h.splice(idx, 1);
    return c ?? null;
  }

  // ── 시작/배정 ───────────────────────────────────────────────
  start(requesterId: string): void {
    if (!this.room.isHost(requesterId)) throw new Error('호스트만 시작할 수 있습니다.');
    if (this.room.phase !== 'lobby') throw new Error('이미 시작된 게임입니다.');
    const players = this.room.list();
    const n = players.length;
    if (n < 4 || n > 7) throw new Error('뱅!은 4~7명이 필요합니다.');

    const roles = this.rolesFor(n);
    const shuffled = shuffle(roles);

    this.order = players.map((p) => p.playerId);
    this.deck = buildDeck();
    this.discard = [];
    this.hands.clear();

    players.forEach((p, i) => {
      const role = shuffled[i]!;
      p.role = role;
      p.alive = true;
      const maxLife = role === 'sheriff' ? 5 : 4;
      p.maxLife = maxLife;
      p.life = maxLife;
      p.weapon = null; // 콜트45(사거리1, 카드 아님)
      p.iqDelta = 0;
      p.coinsDelta = 0;
      this.hands.set(p.playerId, this.draw(maxLife)); // 시작 손패 = 체력만큼
    });

    this.room.phase = 'playing';
    this.winner = null;
    const counts = roles.reduce<Record<Role, number>>((m, r) => ((m[r] = (m[r] ?? 0) + 1), m), {} as Record<Role, number>);
    this.say(`🤠 뱅! 시작! (${n}명 — 보안관 ${counts.sheriff ?? 0} · 부보안관 ${counts.deputy ?? 0} · 무법자 ${counts.outlaw ?? 0} · 배신자 ${counts.renegade ?? 0})`);
    this.say('보안관만 정체가 공개됩니다. 보안관을 노리는 자는 누구일까요?');

    // 보안관부터 시작
    this.turnIdx = this.order.findIndex((id) => this.role(this.room.player(id)!) === 'sheriff');
    if (this.turnIdx < 0) this.turnIdx = 0;
    this.beginTurn();
  }

  private rolesFor(n: number): Role[] {
    switch (n) {
      case 4: return ['sheriff', 'renegade', 'outlaw', 'outlaw'];
      case 5: return ['sheriff', 'renegade', 'outlaw', 'outlaw', 'deputy'];
      case 6: return ['sheriff', 'renegade', 'outlaw', 'outlaw', 'outlaw', 'deputy'];
      case 7: return ['sheriff', 'renegade', 'outlaw', 'outlaw', 'outlaw', 'deputy', 'deputy'];
      default: throw new Error('뱅!은 4~7명이 필요합니다.');
    }
  }

  // ── 턴 진행 ─────────────────────────────────────────────────
  private currentId(): string {
    return this.order[this.turnIdx]!;
  }

  private beginTurn(): void {
    // 사망자 자리는 건너뛴다
    let guard = 0;
    while (this.room.player(this.currentId())?.alive === false && guard++ < this.order.length) {
      this.turnIdx = (this.turnIdx + 1) % this.order.length;
    }
    const me = this.room.player(this.currentId());
    if (!me) return;
    this.turnPhase = 'draw';
    this.bangUsedThisTurn = false;
    this.pending = null;
    this.say(`🎲 ${me.name}님의 차례입니다. (드로우 2장)`);
    this.room.startTimer(TURN_SECONDS, () => this.timeoutTurn());
  }

  private timeoutTurn(): void {
    // 시간 초과: 손패 정리 후 강제 턴 종료
    const id = this.currentId();
    if (this.turnPhase === 'draw') this.doDraw(id); // 드로우 안했으면 처리
    this.discardToLimit(id);
    this.say('⌛ 시간 초과로 턴이 넘어갑니다.');
    this.endTurn();
  }

  private doDraw(id: string): void {
    const drawn = this.draw(2);
    this.hand(id).push(...drawn);
    this.turnPhase = 'play';
    const me = this.room.player(id)!;
    this.say(`🃏 ${me.name}님이 2장을 뽑았습니다.`);
  }

  private discardToLimit(id: string): void {
    const me = this.room.player(id);
    if (!me) return;
    const limit = me.life as number;
    const h = this.hand(id);
    while (h.length > limit) {
      const c = h.pop()!;
      this.discard.push(c);
    }
  }

  private endTurn(): void {
    this.room.clearTimer();
    if (this.checkEnd()) return;
    this.turnIdx = (this.turnIdx + 1) % this.order.length;
    this.beginTurn();
  }

  // ── 데미지/사망 ─────────────────────────────────────────────
  private damage(targetId: string, amount: number, sourceId: string | null): void {
    const t = this.room.player(targetId);
    if (!t || t.alive === false) return;
    t.life = (t.life as number) - amount;
    if ((t.life as number) <= 0) {
      this.eliminate(targetId, sourceId);
    }
  }

  private eliminate(targetId: string, sourceId: string | null): void {
    const t = this.room.player(targetId);
    if (!t) return;
    t.alive = false;
    t.life = 0;
    const role = this.role(t);
    this.say(`☠️ ${t.name}님이 쓰러졌습니다. (정체: ${ROLE_ICON[role]} ${ROLE_LABEL[role]})`);
    // 버려진 손패는 버린 더미로
    const h = this.hand(targetId);
    this.discard.push(...h);
    this.hands.set(targetId, []);

    // 처치 보상/벌칙
    if (sourceId) {
      const killer = this.room.player(sourceId);
      if (killer && killer.alive !== false) {
        if (role === 'outlaw') {
          this.hand(sourceId).push(...this.draw(3)); // 무법자 처치 → 3장
          this.say(`💰 ${killer.name}님이 무법자를 처치해 3장을 보상으로 뽑습니다.`);
        } else if (role === 'deputy' && this.role(killer) === 'sheriff') {
          this.discard.push(...this.hand(sourceId)); // 보안관이 부하 사살 → 전 손패 폐기
          this.hands.set(sourceId, []);
          this.say(`😱 보안관이 부보안관을 쏘았습니다! 손패를 모두 버립니다.`);
        }
      }
    }
    // 보류: 죽음 직전 Beer 셀프 세이브(생존 3인+ 조건) — iteration-1 미구현
  }

  // ── 승리 판정 ───────────────────────────────────────────────
  private checkEnd(): boolean {
    const alive = this.alive();
    const sheriffAlive = alive.some((p) => this.role(p) === 'sheriff');
    const outlawsAlive = alive.some((p) => this.team(this.role(p)) === 'outlaw');
    const renegadeAlive = alive.some((p) => this.role(p) === 'renegade');

    if (!sheriffAlive) {
      // 보안관 사망: 배신자 단독 생존이면 배신자, 아니면 무법자
      if (alive.length === 1 && renegadeAlive) this.end('renegade');
      else this.end('outlaw');
      return true;
    }
    // 보안관 생존 + 무법자/배신자 전멸 → 법 진영 승리
    if (!outlawsAlive && !renegadeAlive) {
      this.end('law');
      return true;
    }
    return false;
  }

  private wins(role: Role, winner: Team): boolean {
    const team = this.team(role);
    if (winner === 'law') return team === 'law';
    if (winner === 'outlaw') return team === 'outlaw';
    return team === 'renegade'; // renegade
  }

  private end(winner: Team): void {
    this.room.clearTimer();
    this.turnPhase = null;
    this.pending = null;
    this.winner = winner;
    this.room.phase = 'ended';

    for (const p of this.room.list()) {
      const won = this.wins(this.role(p), winner);
      if (won) {
        p.iqDelta = WIN.iq;
        p.coinsDelta = WIN.coins;
      } else {
        p.iqDelta = LOSE_IQ;
        p.coinsDelta = 0;
      }
    }
    this.finalBoard = this.room
      .list()
      .map((p) => ({
        name: `${ROLE_ICON[this.role(p)]} ${p.name} · ${ROLE_LABEL[this.role(p)]}`,
        iqDelta: (p.iqDelta as number) ?? 0,
        coinsDelta: (p.coinsDelta as number) ?? 0,
        won: this.wins(this.role(p), winner),
      }))
      .sort((a, b) => Number(b.won) - Number(a.won));

    const label = winner === 'law' ? '⭐ 보안관 진영의 승리!' : winner === 'outlaw' ? '🐴 무법자의 승리!' : '🃏 배신자의 승리!';
    this.say(label);
  }

  // ── 행동 ────────────────────────────────────────────────────
  onAction(playerId: string, action: GameAction): void {
    if (this.room.phase !== 'playing') throw new Error('게임이 진행 중이 아닙니다.');
    const me = this.room.player(playerId);
    if (!me || me.alive === false) throw new Error('탈락하여 행동할 수 없습니다.');

    // pending 반응 처리 (현재 턴 플레이어가 아니어도 응답 가능)
    if (this.pending) {
      this.handleReaction(playerId, action);
      return;
    }

    if (playerId !== this.currentId()) throw new Error('당신의 차례가 아닙니다.');

    switch (action.kind) {
      case 'draw': {
        if (this.turnPhase !== 'draw') throw new Error('지금은 드로우 단계가 아닙니다.');
        this.doDraw(playerId);
        return;
      }
      case 'play': {
        if (this.turnPhase !== 'play') throw new Error('먼저 카드를 뽑으세요.');
        const idx = typeof action.cardIndex === 'number' ? action.cardIndex : -1;
        const targetId = typeof action.target === 'string' ? action.target : undefined;
        this.playCard(playerId, idx, targetId);
        return;
      }
      case 'discard': {
        // 손패 정리 단계 수동 버리기
        const idx = typeof action.cardIndex === 'number' ? action.cardIndex : -1;
        const c = this.takeFromHand(playerId, idx);
        if (!c) throw new Error('버릴 카드를 선택하세요.');
        this.discard.push(c);
        return;
      }
      case 'endTurn': {
        if (this.turnPhase === 'draw') throw new Error('먼저 카드를 뽑으세요.');
        const limit = me.life as number;
        if (this.hand(playerId).length > limit) throw new Error(`손패가 너무 많습니다. ${limit}장 이하로 버리세요.`);
        this.endTurn();
        return;
      }
      default:
        throw new Error('알 수 없는 행동입니다.');
    }
  }

  // 카드 플레이
  private playCard(playerId: string, idx: number, targetId?: string): void {
    const h = this.hand(playerId);
    if (idx < 0 || idx >= h.length) throw new Error('손패에서 카드를 선택하세요.');
    const card = h[idx]!;
    const me = this.room.player(playerId)!;
    const target = targetId ? this.room.player(targetId) : undefined;

    const needTarget = () => {
      if (!target || target.alive === false || target.playerId === playerId) throw new Error('유효한 대상을 지목하세요.');
    };

    switch (card) {
      case 'bang': {
        needTarget();
        if (this.bangUsedThisTurn && this.weaponOf(me) !== 'volcanic') throw new Error('한 턴에 BANG!은 한 번만 낼 수 있습니다. (볼캐닉 제외)');
        if (this.distance(playerId, target!.playerId) > this.rangeOf(me)) throw new Error('사거리 밖의 대상입니다.');
        this.takeFromHand(playerId, idx);
        this.discard.push(card);
        this.bangUsedThisTurn = true;
        this.say(`🔫 ${me.name} → ${target!.name} : BANG!`);
        this.openReaction({ kind: 'bang', sourceId: playerId, waiting: [target!.playerId] });
        return;
      }
      case 'missed':
        throw new Error('빗나감!은 반응 전용 카드입니다.');
      case 'beer': {
        if (this.alive().length <= 2) throw new Error('2명만 남았을 때는 맥주를 쓸 수 없습니다.');
        this.takeFromHand(playerId, idx);
        this.discard.push(card);
        this.healUpTo(playerId, 1);
        this.say(`🍺 ${me.name}님이 맥주로 체력을 1 회복합니다.`);
        return;
      }
      case 'saloon': {
        this.takeFromHand(playerId, idx);
        this.discard.push(card);
        for (const p of this.alive()) this.healUpTo(p.playerId, 1);
        this.say(`🍻 ${me.name}님이 술집! 모두 체력을 1 회복합니다.`);
        return;
      }
      case 'stagecoach': {
        this.takeFromHand(playerId, idx);
        this.discard.push(card);
        this.hand(playerId).push(...this.draw(2));
        this.say(`🚌 ${me.name}님이 역마차로 2장을 뽑습니다.`);
        return;
      }
      case 'wellsfargo': {
        this.takeFromHand(playerId, idx);
        this.discard.push(card);
        this.hand(playerId).push(...this.draw(3));
        this.say(`📦 ${me.name}님이 웰스파고로 3장을 뽑습니다.`);
        return;
      }
      case 'panic': {
        needTarget();
        if (this.distance(playerId, target!.playerId) !== 1) throw new Error('비상!은 거리 1의 대상에게만 씁니다.');
        this.takeFromHand(playerId, idx);
        this.discard.push(card);
        this.stealRandom(playerId, target!.playerId);
        this.say(`😱 ${me.name}님이 ${target!.name}님의 카드를 1장 빼앗습니다.`);
        return;
      }
      case 'catbalou': {
        needTarget();
        this.takeFromHand(playerId, idx);
        this.discard.push(card);
        const tHand = this.hand(target!.playerId);
        if (tHand.length > 0) {
          const ri = Math.floor(Math.random() * tHand.length);
          const [lost] = tHand.splice(ri, 1);
          if (lost) this.discard.push(lost);
        }
        this.say(`🐱 ${me.name}님이 ${target!.name}님의 카드 1장을 버리게 합니다.`);
        return;
      }
      case 'gatling': {
        this.takeFromHand(playerId, idx);
        this.discard.push(card);
        const others = this.aliveIds().filter((id) => id !== playerId);
        this.say(`🔫 ${me.name}님이 개틀링! 다른 모두가 빗나감!을 내야 합니다.`);
        this.openReaction({ kind: 'gatling', sourceId: playerId, waiting: others, responded: new Set() });
        return;
      }
      case 'indians': {
        this.takeFromHand(playerId, idx);
        this.discard.push(card);
        const others = this.aliveIds().filter((id) => id !== playerId);
        this.say(`🏹 ${me.name}님이 인디언! 다른 모두가 BANG!을 버려야 합니다.`);
        this.openReaction({ kind: 'indians', sourceId: playerId, waiting: others, responded: new Set() });
        return;
      }
      case 'duel': {
        needTarget();
        this.takeFromHand(playerId, idx);
        this.discard.push(card);
        this.say(`⚔️ ${me.name}님이 ${target!.name}님에게 결투를 신청합니다.`);
        // 대상부터 BANG!을 내야 한다
        this.openReaction({ kind: 'duel', sourceId: playerId, waiting: [target!.playerId], duelTurn: target!.playerId });
        return;
      }
      case 'generalstore': {
        this.takeFromHand(playerId, idx);
        this.discard.push(card);
        const order = this.aliveIds();
        // 현재 플레이어부터 시계방향 픽 순서
        const start = order.indexOf(playerId);
        const pickOrder = [...order.slice(start), ...order.slice(0, start)];
        const pool = this.draw(pickOrder.length);
        this.say(`🏪 ${me.name}님이 잡화점! ${pool.length}장이 공개됩니다.`);
        this.openReaction({ kind: 'generalstore', sourceId: playerId, waiting: [pickOrder[0]!], pool, pickOrder, pickIndex: 0 });
        return;
      }
      // 무기 장착 (1슬롯, 교체)
      case 'volcanic':
      case 'schofield':
      case 'remington':
      case 'revcarabine':
      case 'winchester': {
        this.takeFromHand(playerId, idx);
        const old = this.weaponOf(me);
        if (old) this.discard.push(old);
        me.weapon = card;
        this.say(`🔧 ${me.name}님이 ${CARD_LABEL[card]}(사거리 ${WEAPON_RANGE[card]})을 장착했습니다.`);
        return;
      }
      default:
        throw new Error('지금은 낼 수 없는 카드입니다.');
    }
  }

  private healUpTo(id: string, amount: number): void {
    const p = this.room.player(id);
    if (!p || p.alive === false) return;
    const max = this.maxLifeOf(p);
    p.life = Math.min(max, (p.life as number) + amount);
  }

  private stealRandom(thiefId: string, fromId: string): void {
    const from = this.hand(fromId);
    if (from.length === 0) return;
    const ri = Math.floor(Math.random() * from.length);
    const [c] = from.splice(ri, 1);
    if (c) this.hand(thiefId).push(c);
  }

  // ── 반응(pending) 처리 ──────────────────────────────────────
  private openReaction(p: Pending): void {
    this.pending = p;
    this.room.startTimer(REACT_SECONDS, () => this.timeoutReaction());
  }

  // 반응 대상이 더 이상 없으면 pending 종료 후 턴 재개
  private resolveReactionDone(): void {
    this.pending = null;
    this.room.clearTimer();
    if (this.checkEnd()) return;
    // 턴 타이머 재가동(턴 플레이어가 계속 플레이)
    this.room.startTimer(TURN_SECONDS, () => this.timeoutTurn());
  }

  private timeoutReaction(): void {
    const p = this.pending;
    if (!p) return;
    // 응답 못한 대기자 전원 자동 피격/실패 처리
    if (p.kind === 'bang' || p.kind === 'gatling') {
      for (const id of p.waiting) this.damage(id, 1, p.sourceId);
      this.pending = null;
      this.resolveReactionDone();
      return;
    }
    if (p.kind === 'indians') {
      for (const id of p.waiting) this.damage(id, 1, p.sourceId);
      this.pending = null;
      this.resolveReactionDone();
      return;
    }
    if (p.kind === 'duel') {
      // BANG!을 내야 하는 쪽이 시간 초과 → 패배(-1)
      const loserId = p.duelTurn!;
      this.damage(loserId, 1, p.sourceId === loserId ? null : p.sourceId);
      this.say('⌛ 결투 응답 시간 초과 — 패자가 피해를 입습니다.');
      this.pending = null;
      this.resolveReactionDone();
      return;
    }
    if (p.kind === 'generalstore') {
      // 남은 사람은 순서대로 첫 카드를 자동 획득
      this.autoPickRemaining(p);
      this.pending = null;
      this.resolveReactionDone();
      return;
    }
  }

  private autoPickRemaining(p: Pending): void {
    const order = p.pickOrder ?? [];
    let i = p.pickIndex ?? 0;
    while (i < order.length && (p.pool?.length ?? 0) > 0) {
      const picker = order[i]!;
      const c = p.pool!.shift()!;
      if (this.room.player(picker)?.alive !== false) this.hand(picker).push(c);
      i++;
    }
  }

  private handleReaction(playerId: string, action: GameAction): void {
    const p = this.pending!;
    switch (p.kind) {
      case 'bang':
      case 'gatling':
      case 'indians':
        return this.reactBangLike(playerId, action, p);
      case 'duel':
        return this.reactDuel(playerId, action, p);
      case 'generalstore':
        return this.reactGeneralStore(playerId, action, p);
    }
  }

  // bang/gatling은 Missed!로, indians는 BANG!으로 막는다. 'takeHit'으로 피격 수용.
  private reactBangLike(playerId: string, action: GameAction, p: Pending): void {
    if (!p.waiting.includes(playerId)) throw new Error('지금 반응할 대상이 아닙니다.');
    const needCard: CardCode = p.kind === 'indians' ? 'bang' : 'missed';

    if (action.kind === 'respond') {
      const idx = typeof action.cardIndex === 'number' ? action.cardIndex : this.hand(playerId).indexOf(needCard);
      const h = this.hand(playerId);
      if (idx < 0 || idx >= h.length || h[idx] !== needCard) {
        throw new Error(`${CARD_LABEL[needCard]} 카드를 내야 합니다.`);
      }
      this.takeFromHand(playerId, idx);
      this.discard.push(needCard);
      const me = this.room.player(playerId)!;
      this.say(`🛡️ ${me.name}님이 ${CARD_LABEL[needCard]}(으)로 막았습니다.`);
    } else if (action.kind === 'takeHit') {
      this.damage(playerId, 1, p.sourceId);
      const me = this.room.player(playerId);
      if (me) this.say(`💥 ${me.name}님이 피해를 입었습니다. (체력 ${me.life})`);
    } else {
      throw new Error('빗나감!을 내거나 피해를 받으세요.');
    }

    p.waiting = p.waiting.filter((id) => id !== playerId);
    if (p.waiting.length === 0) {
      this.pending = null;
      this.resolveReactionDone();
    } else {
      // 다음 대기자 응답을 위해 반응 타이머 갱신
      this.room.startTimer(REACT_SECONDS, () => this.timeoutReaction());
    }
  }

  // 결투: 대상부터 시작해 한 명씩 BANG!을 교대로 낸다. 못 내면 -1.
  private reactDuel(playerId: string, action: GameAction, p: Pending): void {
    if (playerId !== p.duelTurn) throw new Error('당신의 결투 차례가 아닙니다.');

    if (action.kind === 'respond') {
      const idx = typeof action.cardIndex === 'number' ? action.cardIndex : this.hand(playerId).indexOf('bang');
      const h = this.hand(playerId);
      if (idx < 0 || idx >= h.length || h[idx] !== 'bang') throw new Error('BANG! 카드를 내야 합니다.');
      this.takeFromHand(playerId, idx);
      this.discard.push('bang');
      const me = this.room.player(playerId)!;
      this.say(`⚔️ ${me.name}님이 BANG!으로 응수합니다.`);
      // 상대에게 차례 넘김
      const opponent = playerId === p.sourceId ? p.waiting[0]! : p.sourceId;
      p.duelTurn = opponent;
      this.room.startTimer(REACT_SECONDS, () => this.timeoutReaction());
      return;
    }
    if (action.kind === 'takeHit') {
      this.damage(playerId, 1, playerId === p.sourceId ? null : p.sourceId);
      const me = this.room.player(playerId);
      if (me) this.say(`💥 ${me.name}님이 결투에서 패배해 피해를 입습니다.`);
      this.pending = null;
      this.resolveReactionDone();
      return;
    }
    throw new Error('BANG!을 내거나 결투를 포기하세요.');
  }

  // 잡화점: 순서대로 풀에서 1장 픽
  private reactGeneralStore(playerId: string, action: GameAction, p: Pending): void {
    const order = p.pickOrder!;
    const i = p.pickIndex ?? 0;
    if (order[i] !== playerId) throw new Error('당신의 선택 차례가 아닙니다.');
    if (action.kind !== 'pick') throw new Error('공개된 카드 중 하나를 선택하세요.');
    const pi = typeof action.poolIndex === 'number' ? action.poolIndex : -1;
    const pool = p.pool!;
    if (pi < 0 || pi >= pool.length) throw new Error('유효한 카드를 선택하세요.');
    const [c] = pool.splice(pi, 1);
    if (c) this.hand(playerId).push(c);
    const me = this.room.player(playerId)!;
    this.say(`🏪 ${me.name}님이 카드를 한 장 가져갑니다.`);

    const nextIdx = i + 1;
    if (nextIdx >= order.length || pool.length === 0) {
      this.pending = null;
      this.resolveReactionDone();
      return;
    }
    p.pickIndex = nextIdx;
    p.waiting = [order[nextIdx]!];
    this.room.startTimer(REACT_SECONDS, () => this.timeoutReaction());
  }

  // ── 직렬화 ──────────────────────────────────────────────────
  playerView(player: PlayerView, viewerId: string): Record<string, unknown> {
    const p = player as unknown as { playerId: string; alive?: boolean; role?: Role; life?: number; weapon?: CardCode | null };
    const viewer = this.room.player(viewerId);
    const dead = p.alive === false;
    const ended = this.room.phase === 'ended';
    const isSheriff = p.role === 'sheriff';
    // 정체 공개: 보안관(항상) / 사망자 / 종료
    const showRole = isSheriff || dead || ended;
    return {
      alive: !dead,
      life: p.life ?? 0,
      handCount: this.hand(p.playerId).length, // 장수만(내용 비공개)
      weapon: p.weapon ?? null,
      range: this.rangeOf(p as never),
      role: showRole ? p.role : undefined,
      isTurn: this.room.phase === 'playing' && p.playerId === this.currentId(),
      // 뷰어와의 거리(생존자 한정) — 사거리 힌트
      distance: viewer && !dead && viewer.alive !== false ? this.distance(viewerId, p.playerId) : undefined,
    };
  }

  viewFor(viewerId: string): unknown {
    const me = this.room.player(viewerId);
    const myRole = me ? this.role(me) : undefined;
    const v: Record<string, unknown> = {
      mode: 'bang',
      log: this.log.slice(-40),
      turnPlayerId: this.room.phase === 'playing' ? this.currentId() : null,
      turnPhase: this.turnPhase,
      myRole,
      myHand: this.hand(viewerId),
      myWeaponRange: me ? this.rangeOf(me) : 1,
      bangUsedThisTurn: this.bangUsedThisTurn,
      deckCount: this.deck.length,
      discardCount: this.discard.length,
      pending: this.pendingViewFor(viewerId),
    };
    if (this.room.phase === 'ended') {
      v.winnerTeam = this.winner;
      v.finalBoard = this.finalBoard;
    }
    return v;
  }

  // 이 뷰어가 응답해야 하는 pending과, 응답에 쓸 수 있는 손패 카드 인덱스
  private pendingViewFor(viewerId: string): unknown {
    const p = this.pending;
    if (!p) return null;
    const h = this.hand(viewerId);
    let mustRespond = false;
    let eligible: number[] = [];
    let need: CardCode | null = null;

    if (p.kind === 'bang' || p.kind === 'gatling') {
      mustRespond = p.waiting.includes(viewerId);
      need = 'missed';
    } else if (p.kind === 'indians') {
      mustRespond = p.waiting.includes(viewerId);
      need = 'bang';
    } else if (p.kind === 'duel') {
      mustRespond = p.duelTurn === viewerId;
      need = 'bang';
    } else if (p.kind === 'generalstore') {
      const i = p.pickIndex ?? 0;
      mustRespond = p.pickOrder?.[i] === viewerId;
    }
    if (need) eligible = h.map((c, i) => (c === need ? i : -1)).filter((i) => i >= 0);

    return {
      kind: p.kind,
      sourceId: p.sourceId,
      mustRespond,
      need,
      eligible,
      pool: p.kind === 'generalstore' ? p.pool : undefined,
      duelTurn: p.duelTurn,
    };
  }

  results(): GameResult[] {
    return this.room.list().map((p) => ({
      userId: p.userId,
      iqDelta: (p.iqDelta as number) ?? 0,
      coinsDelta: (p.coinsDelta as number) ?? 0,
      won: this.winner !== null && this.wins(this.role(p), this.winner),
    }));
  }
}
