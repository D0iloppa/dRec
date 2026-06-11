// 원카드(One Card) 엔진 — 서버 권위. 한국식 원카드 흔한 변형(아래 규칙 확정).
//
// ── 규칙(이번 구현 확정) ──────────────────────────────────────────
// • 낼 수 있는 조건: 직전 카드와 "무늬(suit)" 또는 "숫자/문양(rank)"이 일치해야 한다.
//   (단 activeSuit는 7/조커로 바뀔 수 있어, 무늬 일치는 topCard가 아니라 activeSuit 기준.)
// • 특수 카드:
//   - 2  = 공격: 다음 사람 +2장. (2로 받아치기 가능 — 누적 후 넘김)
//   - A  = 공격: 다음 사람 +3장. (A로 받아치기 가능 — 누적 후 넘김)
//          ※ 공격 누적(pendingDraw)은 같은 종류로만 스택(2↔2, A↔A). 못 받으면 전량 먹고 턴 넘김.
//   - J(잭)   = 한 명 건너뛰기 (다음 차례 1명 skip)
//   - Q(퀸)   = 한 번 더 (낸 사람이 한 번 더 냄)
//   - K(킹)   = 방향 전환 (reverse; 2인전이면 사실상 한 번 더)
//   - 7       = 무늬 바꾸기 (chosenSuit로 activeSuit 선언; 카드 자체는 7로 남음)
//   - 조커    = 강공격: 다음 사람 +5 + 무늬 선언(wild). 조커끼리만 스택. (덱에 2장 포함)
// • 무늬 선언이 필요한 카드(7, 조커)는 같은 action에 chosenSuit를 담아야 한다(없으면 거부).
// • 승리: 손패를 가장 먼저 비운 사람. 덱 소진 시 버린 더미(top 제외) 셔플해 재생성.
// • "원카드!" 콜은 이번 이터레이션 생략.
import { GameEngine, Room, type GameResult } from '@dopl/core';
import type { GameAction, PlayerView } from '@dopl/protocol';

export type Suit = 'S' | 'H' | 'D' | 'C'; // ♠♥♦♣
export type Rank = 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'JOKER';
export interface Card {
  id: string;
  suit: Suit | null; // 조커는 무늬 없음
  rank: Rank;
}

const SUITS: Suit[] = ['S', 'H', 'D', 'C'];
const NUMBERS: Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUIT_LABEL: Record<Suit, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };

const TURN_SECONDS = 45;
const HAND_SIZE = 7;
const ATTACK_2 = 2;
const ATTACK_A = 3;
const ATTACK_JOKER = 5;

const WIN_REWARD = { iq: 10, coins: 30 };

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function cardLabel(c: Card): string {
  if (c.rank === 'JOKER') return '🃏 조커';
  return `${SUIT_LABEL[c.suit!]}${c.rank}`;
}

export class OneCardEngine extends GameEngine {
  private deck: Card[] = [];
  private discard: Card[] = []; // 마지막 원소가 top
  private hands = new Map<string, Card[]>(); // playerId → 손패
  private order: string[] = []; // 좌석 순서(고정)
  private turnIdx = 0; // order 인덱스
  private direction: 1 | -1 = 1;
  private activeSuit: Suit | null = null; // 현재 요구 무늬(7/조커로 변경 가능)
  private pendingDraw = 0; // 누적 공격 장수(현재 차례가 못 받으면 먹어야 함)
  private pendingType: '2' | 'A' | 'JOKER' | null = null; // 누적 공격의 종류(스택 제한)
  private extraTurn = false; // Q로 한 번 더

  private winnerId: string | null = null;
  private log: string[] = [];
  private finalBoard: { name: string; score: number; iqDelta: number; coinsDelta: number; won: boolean }[] = [];

  constructor(private room: Room) {
    super();
  }

  // ── 헬퍼 ────────────────────────────────────────────────────
  private say(text: string) {
    this.log.push(text);
  }
  private currentId(): string {
    return this.order[this.turnIdx]!;
  }
  private hand(id: string): Card[] {
    return this.hands.get(id) ?? [];
  }
  private buildDeck(): Card[] {
    const cards: Card[] = [];
    for (const s of SUITS) for (const r of NUMBERS) cards.push({ id: `${s}${r}`, suit: s, rank: r });
    cards.push({ id: 'JOKER1', suit: null, rank: 'JOKER' });
    cards.push({ id: 'JOKER2', suit: null, rank: 'JOKER' });
    return cards;
  }
  // 덱이 비면 버린 더미(top 제외)를 셔플해 재생성
  private drawOne(): Card | null {
    if (this.deck.length === 0) {
      if (this.discard.length <= 1) return null;
      const top = this.discard.pop()!;
      this.deck = shuffle(this.discard);
      this.discard = [top];
      this.say('♻️ 덱 소진 — 버린 카드를 다시 섞었습니다.');
    }
    return this.deck.pop() ?? null;
  }
  private draw(id: string, n: number): void {
    const h = this.hand(id);
    for (let i = 0; i < n; i++) {
      const c = this.drawOne();
      if (!c) break;
      h.push(c);
    }
  }
  private top(): Card {
    return this.discard[this.discard.length - 1]!;
  }
  // 일반 숫자 카드인지(시작 top·activeSuit 판정용)
  private isPlainNumber(c: Card): boolean {
    return c.suit !== null && c.rank !== '2' && c.rank !== 'A' && c.rank !== '7' && c.rank !== 'J' && c.rank !== 'Q' && c.rank !== 'K';
  }
  // 다음 좌석으로 (skip장수만큼 추가 이동)
  private advance(skip = 0): void {
    const n = this.order.length;
    this.turnIdx = (((this.turnIdx + this.direction * (1 + skip)) % n) + n) % n;
  }

  // 해당 카드를 지금 낼 수 있는가(공격 누적 상태 포함)
  private canPlay(c: Card): boolean {
    // 공격 누적 중엔 같은 종류 공격 카드로만 받아칠 수 있다.
    if (this.pendingDraw > 0) {
      if (this.pendingType === 'JOKER') return c.rank === 'JOKER';
      return c.rank === this.pendingType;
    }
    if (c.rank === 'JOKER') return true; // 조커는 언제든
    if (c.suit === this.activeSuit) return true; // 무늬 일치
    return c.rank === this.top().rank; // 문양/숫자 일치
  }

  // ── 시작 ────────────────────────────────────────────────────
  async start(requesterId: string): Promise<void> {
    if (!this.room.isHost(requesterId)) throw new Error('호스트만 시작할 수 있습니다.');
    if (this.room.phase !== 'lobby') throw new Error('이미 시작된 게임입니다.');
    const players = this.room.list();
    const n = players.length;
    if (n < 2 || n > 6) throw new Error('원카드는 2~6명이 필요합니다.');

    this.deck = shuffle(this.buildDeck());
    this.discard = [];
    this.hands.clear();
    this.order = players.map((p) => p.playerId);
    this.direction = 1;
    this.pendingDraw = 0;
    this.pendingType = null;
    this.extraTurn = false;
    this.winnerId = null;

    for (const p of players) {
      p.iqDelta = 0;
      p.coinsDelta = 0;
      this.hands.set(p.playerId, []);
      this.draw(p.playerId, HAND_SIZE);
    }

    // 시작 top은 일반 숫자 카드여야 함(특수면 다시 뽑아 덱 바닥으로)
    let first = this.deck.pop()!;
    while (!this.isPlainNumber(first)) {
      this.deck.unshift(first);
      first = this.deck.pop()!;
    }
    this.discard.push(first);
    this.activeSuit = first.suit;

    this.turnIdx = 0;
    this.room.phase = 'playing';
    this.say(`🃏 원카드 시작! (${n}명) — 시작 카드 ${cardLabel(first)}`);
    this.say(`${this.room.player(this.currentId())?.name}님 차례입니다.`);
    this.room.startTimer(TURN_SECONDS, () => this.onTimeout());
  }

  private onTimeout(): void {
    // 타임아웃 = 1장 뽑고(공격 누적 중이면 전량) 턴 넘김
    const id = this.currentId();
    const name = this.room.player(id)?.name ?? '?';
    if (this.pendingDraw > 0) {
      this.draw(id, this.pendingDraw);
      this.say(`⏳ ${name}님 시간 초과 — 공격 ${this.pendingDraw}장을 받고 넘어갑니다.`);
      this.pendingDraw = 0;
      this.pendingType = null;
    } else {
      this.draw(id, 1);
      this.say(`⏳ ${name}님 시간 초과 — 1장 뽑고 넘어갑니다.`);
    }
    this.advance();
    this.startTurnTimer();
  }

  private startTurnTimer(): void {
    if (this.room.phase !== 'playing') return;
    this.say(`▶️ ${this.room.player(this.currentId())?.name}님 차례입니다.`);
    this.room.startTimer(TURN_SECONDS, () => this.onTimeout());
  }

  // ── 행동 ────────────────────────────────────────────────────
  onAction(playerId: string, action: GameAction): void {
    if (this.room.phase !== 'playing') throw new Error('게임이 진행 중이 아닙니다.');
    if (playerId !== this.currentId()) throw new Error('당신의 차례가 아닙니다.');

    switch (action.kind) {
      case 'play':
        return this.doPlay(playerId, action);
      case 'draw':
        return this.doDraw(playerId);
      case 'pass':
        return this.doPass(playerId);
      default:
        throw new Error('알 수 없는 행동입니다.');
    }
  }

  private doPlay(playerId: string, action: GameAction): void {
    const cardId = action.cardId;
    if (typeof cardId !== 'string') throw new Error('낼 카드를 선택하세요.');
    const h = this.hand(playerId);
    const idx = h.findIndex((c) => c.id === cardId);
    if (idx < 0) throw new Error('가지고 있지 않은 카드입니다.');
    const card = h[idx]!;
    if (!this.canPlay(card)) throw new Error('지금 낼 수 없는 카드입니다.');

    // 무늬 선언 필요 카드(7/조커)는 chosenSuit 필수
    const needsSuit = card.rank === '7' || card.rank === 'JOKER';
    const chosen = action.chosenSuit;
    if (needsSuit && (typeof chosen !== 'string' || !SUITS.includes(chosen as Suit)))
      throw new Error('바꿀 무늬를 함께 골라주세요.');

    // 손에서 제거 → 버린 더미로
    h.splice(idx, 1);
    this.discard.push(card);
    const name = this.room.player(playerId)?.name ?? '?';

    // activeSuit 갱신 (조커는 무늬 없음 → 선언, 7은 선언, 그 외는 카드 무늬)
    if (needsSuit) this.activeSuit = chosen as Suit;
    else this.activeSuit = card.suit;

    this.say(`🃏 ${name} → ${cardLabel(card)}${needsSuit ? ` (무늬 ${SUIT_LABEL[chosen as Suit]} 선언)` : ''}`);

    // 승리 판정
    if (h.length === 0) {
      this.end(playerId);
      return;
    }

    // 특수 효과 적용 + 다음 차례 결정
    this.room.clearTimer();
    this.applyEffect(card);
  }

  // 카드 효과 처리 후 턴 전환 + 타이머 재시작
  private applyEffect(card: Card): void {
    let skip = 0;
    this.extraTurn = false;

    switch (card.rank) {
      case '2':
        this.pendingDraw += ATTACK_2;
        this.pendingType = '2';
        this.say(`💥 공격! 다음 사람 누적 ${this.pendingDraw}장`);
        break;
      case 'A':
        this.pendingDraw += ATTACK_A;
        this.pendingType = 'A';
        this.say(`💥 공격! 다음 사람 누적 ${this.pendingDraw}장`);
        break;
      case 'JOKER':
        this.pendingDraw += ATTACK_JOKER;
        this.pendingType = 'JOKER';
        this.say(`☠️ 강공격! 다음 사람 누적 ${this.pendingDraw}장`);
        break;
      case 'J':
        skip = 1;
        this.say('⏭ 한 명 건너뛰기!');
        break;
      case 'Q':
        this.extraTurn = true;
        this.say('🔁 한 번 더!');
        break;
      case 'K':
        this.direction = this.direction === 1 ? -1 : 1;
        this.say('↩️ 방향 전환!');
        break;
      default:
        break;
    }

    if (this.extraTurn) {
      // 같은 사람이 한 번 더 (턴 인덱스 유지)
      this.startTurnTimer();
      return;
    }
    this.advance(skip);
    this.startTurnTimer();
  }

  private doDraw(playerId: string): void {
    this.room.clearTimer();
    const name = this.room.player(playerId)?.name ?? '?';
    if (this.pendingDraw > 0) {
      // 공격을 못 받음 → 전량 먹고 턴 넘김(스킵 효과)
      this.draw(playerId, this.pendingDraw);
      this.say(`😵 ${name}님이 공격 ${this.pendingDraw}장을 받았습니다.`);
      this.pendingDraw = 0;
      this.pendingType = null;
      this.advance();
      this.startTurnTimer();
      return;
    }
    // 일반 1장 뽑기 → 낸 게 가능하면 이어서 낼 수 있게 턴 유지(pass로 마무리)
    this.draw(playerId, 1);
    this.say(`🤚 ${name}님이 1장을 뽑았습니다.`);
    // 뽑은 후에도 같은 차례 — 낼 수 있으면 play, 없으면 pass
    this.room.startTimer(TURN_SECONDS, () => this.onTimeout());
  }

  private doPass(playerId: string): void {
    // 뽑은 뒤에도 낼 수 없을 때만 패스 허용
    if (this.pendingDraw > 0) throw new Error('공격을 받거나 받아쳐야 합니다.');
    const h = this.hand(playerId);
    if (h.some((c) => this.canPlay(c)) && h.length > 0) {
      // 낼 수 있는데 패스? — 1장 뽑은 직후만 통과시키려 했으나, 단순화: 낼 수 있으면 거부
      throw new Error('낼 수 있는 카드가 있으면 패스할 수 없습니다.');
    }
    this.room.clearTimer();
    this.say(`⤵️ ${this.room.player(playerId)?.name}님이 넘겼습니다.`);
    this.advance();
    this.startTurnTimer();
  }

  // ── 종료 ────────────────────────────────────────────────────
  private end(winnerId: string): void {
    this.room.clearTimer();
    this.winnerId = winnerId;
    this.room.phase = 'ended';

    for (const p of this.room.list()) {
      const remaining = this.hand(p.playerId).length;
      if (p.playerId === winnerId) {
        p.iqDelta = WIN_REWARD.iq;
        p.coinsDelta = WIN_REWARD.coins;
      } else {
        // 남은 장수에 비례한 손실(-1 ~ -2 스케일, 절반 단위 캡)
        p.iqDelta = -Math.min(2, Math.max(1, Math.ceil(remaining / 4)));
        p.coinsDelta = 0;
      }
    }

    this.finalBoard = this.room
      .list()
      .map((p) => {
        const remaining = this.hand(p.playerId).length;
        const won = p.playerId === winnerId;
        return {
          name: p.name,
          score: won ? 0 : -remaining, // 승자 0, 나머지 남은 장수만큼 마이너스
          iqDelta: (p.iqDelta as number) ?? 0,
          coinsDelta: (p.coinsDelta as number) ?? 0,
          won,
        };
      })
      .sort((a, b) => Number(b.won) - Number(a.won) || b.score - a.score);

    this.say(`🎉 ${this.room.player(winnerId)?.name}님이 손패를 모두 비워 승리했습니다!`);
  }

  // ── 직렬화 ──────────────────────────────────────────────────
  playerView(player: PlayerView, _viewerId: string): Record<string, unknown> {
    const p = player as unknown as { playerId: string };
    return {
      handCount: this.hand(p.playerId).length,
      isCurrent: this.room.phase === 'playing' && p.playerId === this.currentId(),
    };
  }

  viewFor(viewerId: string): unknown {
    const top = this.discard.length ? this.top() : null;
    const myHand = this.hand(viewerId);
    const isMyTurn = this.room.phase === 'playing' && viewerId === this.currentId();
    const v: Record<string, unknown> = {
      mode: 'onecard',
      log: this.log.slice(-40),
      topCard: top ? { rank: top.rank, suit: top.suit } : null,
      activeSuit: this.activeSuit,
      turnPlayerId: this.room.phase === 'playing' ? this.currentId() : null,
      direction: this.direction,
      pendingDraw: this.pendingDraw,
      deckCount: this.deck.length,
      myHand: myHand.map((c) => ({ id: c.id, rank: c.rank, suit: c.suit, playable: isMyTurn && this.canPlay(c) })),
      // 7/조커를 내려는 경우 무늬 선택이 필요함을 클라에 알림(낼 수 있는 7/조커 보유 시)
      mustChooseSuit: isMyTurn && myHand.some((c) => (c.rank === '7' || c.rank === 'JOKER') && this.canPlay(c)),
      players: this.room.list().map((p) => ({
        id: p.playerId,
        name: p.name,
        handCount: this.hand(p.playerId).length,
        isCurrent: this.room.phase === 'playing' && p.playerId === this.currentId(),
      })),
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
      won: p.playerId === this.winnerId,
    }));
  }
}
