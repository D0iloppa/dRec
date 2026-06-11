// 텍사스 홀덤 엔진 — 시스템이 딜러를 대신한다.
// 진행: 핸드마다 셔플 → 블라인드 → 프리플랍/플랍/턴/리버 베팅 → 쇼다운 → 팟 분배 → 다음 핸드.
// 종료: 칩 보유자가 1명만 남거나(나머지 전원 파산) 정해진 핸드 수(8핸드)를 마치면 칩 순위로 결산.
// 베팅 라운드는 미폴드 플레이어가 모두 콜(= 현재 베트에 맞춤)하고 전원 행동을 마치면 끝난다.
// 사이드 팟: 올인 금액이 서로 다르면 기여 레벨별로 팟을 쪼개 정확히 분배한다.
import { GameEngine, Room, type GameResult } from '@dopl/core';
import type { GameAction, PlayerView } from '@dopl/protocol';

const START_CHIPS = 1000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const DECISION_SECONDS = 40;
const SHOWDOWN_SECONDS = 8;
const MAX_HANDS = 8; // 이 수만큼 핸드를 치르면 칩 순위로 결산

type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';

// ── 카드 표현: 0..51. rank = 2..14(=A), suit = 0..3 ────────────
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUITS = ['♠', '♥', '♦', '♣'];
function cardRank(c: number): number {
  return (c % 13) + 2; // 0→2 ... 12→14(A)
}
function cardSuit(c: number): number {
  return Math.floor(c / 13);
}
export function cardStr(c: number): string {
  return RANKS[(c % 13)]! + SUITS[cardSuit(c)]!;
}

// 핸드 카테고리 (높을수록 강함)
const CAT_LABEL: Record<number, string> = {
  9: '로열 스트레이트 플러시',
  8: '스트레이트 플러시',
  7: '포카드',
  6: '풀하우스',
  5: '플러시',
  4: '스트레이트',
  3: '트리플',
  2: '투페어',
  1: '원페어',
  0: '하이카드',
};

// 5장 평가 → [category, ...tiebreakers]. 비교는 사전식(lexicographic).
// tiebreaker는 항상 "강한 순"으로 정렬된 rank들이라 같은 길이끼리 사전 비교하면 정확하다.
function eval5(cards: number[]): number[] {
  const ranks = cards.map(cardRank).sort((a, b) => b - a); // 내림차순
  const suits = cards.map(cardSuit);
  const isFlush = suits.every((s) => s === suits[0]);

  // 스트레이트 판정 — 중복 없는 rank 집합으로. A-low(A2345) 별도 처리.
  const uniq = [...new Set(ranks)].sort((a, b) => b - a);
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0]! - uniq[4]! === 4) straightHigh = uniq[0]!; // 연속 5장
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[2] === 4 && uniq[3] === 3 && uniq[4] === 2)
      straightHigh = 5; // A,5,4,3,2 = 휠(A는 1로 취급, 탑은 5)
  }

  // rank별 개수 → [count, rank] 목록을 count desc, rank desc 로 정렬
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const groups = [...counts.entries()]
    .map(([r, c]) => ({ r, c }))
    .sort((a, b) => (b.c - a.c) || (b.r - a.r));
  const c0 = groups[0]!.c;
  const c1 = groups[1]?.c ?? 0;

  if (isFlush && straightHigh) return [straightHigh === 14 ? 9 : 8, straightHigh];
  if (c0 === 4) return [7, groups[0]!.r, groups[1]!.r]; // 포카드 + 키커
  if (c0 === 3 && c1 === 2) return [6, groups[0]!.r, groups[1]!.r]; // 풀하우스
  if (isFlush) return [5, ...ranks]; // 플러시 — 5장 전체가 타이브레이커
  if (straightHigh) return [4, straightHigh];
  if (c0 === 3) return [3, groups[0]!.r, ...groups.slice(1).map((g) => g.r)]; // 트리플 + 키커들
  if (c0 === 2 && c1 === 2) {
    // 투페어: 큰 페어, 작은 페어, 키커
    const pairRanks = groups.filter((g) => g.c === 2).map((g) => g.r).sort((a, b) => b - a);
    const kicker = groups.find((g) => g.c === 1)!.r;
    return [2, pairRanks[0]!, pairRanks[1]!, kicker];
  }
  if (c0 === 2) return [1, groups[0]!.r, ...groups.slice(1).map((g) => g.r)]; // 원페어 + 키커들
  return [0, ...ranks]; // 하이카드
}

function cmpScore(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// 7장(2 홀 + 5 보드) 중 최강 5장 조합을 찾는다. C(7,5)=21조합 완전 탐색.
function best7(cards7: number[]): number[] {
  let best: number[] | null = null;
  const n = cards7.length; // 5~7장 모두 동작 (보드가 덜 깔린 상황은 쓰지 않지만 안전)
  const combos: number[][] = [];
  if (n <= 5) {
    combos.push(cards7.slice());
  } else {
    // 표준 조합 생성 (n개 중 5개)
    const rec = (start: number, pick: number[]) => {
      if (pick.length === 5) {
        combos.push(pick.map((i) => cards7[i]!));
        return;
      }
      for (let i = start; i < n; i++) rec(i + 1, [...pick, i]);
    };
    rec(0, []);
  }
  for (const c of combos) {
    const s = eval5(c);
    if (!best || cmpScore(s, best) > 0) best = s;
  }
  return best!;
}

export class PokerEngine extends GameEngine {
  private street: Street = 'preflop';
  private deck: number[] = [];
  private board: number[] = []; // 커뮤니티 카드 (최대 5)
  private hole = new Map<string, [number, number]>(); // playerId → 2장
  private dealerIdx = 0; // room.list() 기준 딜러 버튼 좌석 인덱스
  private handNo = 0;
  private toActId: string | null = null; // 현재 행동할 플레이어
  private lastAggressorId: string | null = null; // 마지막 베트/레이즈한 사람 (라운드 종료 기준)
  private currentBet = 0; // 이번 스트리트의 맞춰야 할 금액
  private minRaise = BIG_BLIND; // 최소 레이즈 크기
  private potCommitted = 0; // 이전 스트리트들에서 확정된 팟(중앙으로 모인 칩)
  private log: string[] = [];
  private revealed: { id: string; name: string; cards: number[]; hand: string }[] = [];
  private winnerNames: string[] = [];
  private finalBoard: { name: string; iqDelta: number; coinsDelta: number; won: boolean }[] = [];
  private finalWinnerId: string | null = null; // 최종 칩 리더 (results용)
  private ended = false;

  constructor(private room: Room) {
    super();
  }

  // ── 좌석/플레이어 헬퍼 ───────────────────────────────────────
  private seats() {
    return this.room.list();
  }
  private chips(p: { [k: string]: unknown }): number {
    return (p.chips as number) ?? 0;
  }
  // 이번 핸드에 참여 중(시작 시 칩>0)인 좌석 — folded여도 포함
  private inHand() {
    return this.seats().filter((p) => p.inHand === true);
  }
  // 아직 폴드/올인하지 않아 행동 가능한 플레이어
  private active() {
    return this.inHand().filter((p) => p.folded !== true);
  }
  private notAllIn() {
    return this.active().filter((p) => p.allIn !== true);
  }
  private say(t: string) {
    this.log.push(t);
  }

  // 좌석 인덱스 from을 기준으로 시계방향 다음 inHand & !folded & !allIn 좌석 찾기
  private nextToAct(fromIdx: number): string | null {
    const seats = this.seats();
    const n = seats.length;
    for (let step = 1; step <= n; step++) {
      const p = seats[(fromIdx + step) % n]!;
      if (p.inHand === true && p.folded !== true && p.allIn !== true) return p.playerId;
    }
    return null;
  }
  private seatIdx(id: string): number {
    return this.seats().findIndex((p) => p.playerId === id);
  }

  // ── 시작 ────────────────────────────────────────────────────
  async start(requesterId: string): Promise<void> {
    if (!this.room.isHost(requesterId)) throw new Error('호스트만 시작할 수 있습니다.');
    if (this.room.phase !== 'lobby') throw new Error('이미 시작된 게임입니다.');
    const players = this.seats();
    if (players.length < 2 || players.length > 6) throw new Error('포커는 2~6명이 필요합니다.');

    for (const p of players) {
      p.chips = START_CHIPS;
      p.iqDelta = 0;
      p.coinsDelta = 0;
    }
    this.room.phase = 'playing';
    this.handNo = 0;
    this.dealerIdx = Math.floor(Math.random() * players.length);
    this.say(`♠️ 텍사스 홀덤 시작! (${players.length}명 · 시작 칩 ${START_CHIPS} · 블라인드 ${SMALL_BLIND}/${BIG_BLIND})`);
    this.startHand();
  }

  // ── 핸드 시작 ───────────────────────────────────────────────
  private startHand(): void {
    // 칩 있는 좌석만 이번 핸드 참가
    const seats = this.seats();
    for (const p of seats) {
      p.inHand = this.chips(p) > 0;
      p.folded = false;
      p.allIn = false;
      p.bet = 0; // 이번 스트리트 베트
      p.committed = 0; // 핸드 전체 누적 기여(사이드 팟 계산용)
    }
    const playing = this.inHand();
    if (playing.length < 2) {
      this.finish();
      return;
    }

    this.handNo += 1;
    this.street = 'preflop';
    this.board = [];
    this.hole.clear();
    this.potCommitted = 0;
    this.currentBet = 0;
    this.minRaise = BIG_BLIND;
    this.revealed = [];
    this.winnerNames = [];

    // 셔플 (Fisher-Yates) 후 2장씩 분배
    this.deck = Array.from({ length: 52 }, (_, i) => i);
    for (let i = this.deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.deck[i], this.deck[j]] = [this.deck[j]!, this.deck[i]!];
    }
    for (const p of playing) this.hole.set(p.playerId, [this.deck.pop()!, this.deck.pop()!]);

    // 딜러 버튼은 inHand 좌석 중 하나여야 함 — 버튼이 파산했으면 다음 생존 좌석으로 이동
    const n = seats.length;
    while (seats[this.dealerIdx]!.inHand !== true) this.dealerIdx = (this.dealerIdx + 1) % n;

    this.say(`──── 핸드 #${this.handNo} ────`);
    this.say(`🔘 딜러: ${seats[this.dealerIdx]!.name}`);

    // 블라인드 좌석: 2인(헤즈업)이면 버튼=SB, 상대=BB. 3인 이상이면 버튼 다음=SB, 그 다음=BB.
    let sbIdx: number;
    let bbIdx: number;
    if (playing.length === 2) {
      sbIdx = this.dealerIdx;
      bbIdx = this.nextSeatIdx(this.dealerIdx);
    } else {
      sbIdx = this.nextSeatIdx(this.dealerIdx);
      bbIdx = this.nextSeatIdx(sbIdx);
    }
    const sbP = seats[sbIdx]!;
    const bbP = seats[bbIdx]!;
    this.postBlind(sbP, SMALL_BLIND, '스몰블라인드');
    this.postBlind(bbP, BIG_BLIND, '빅블라인드');
    this.currentBet = BIG_BLIND;
    this.minRaise = BIG_BLIND;

    // 프리플랍 첫 행동: BB 다음(UTG). 헤즈업이면 SB(=버튼)부터.
    // lastAggressor = BB (BB는 옵션을 가지므로, 모두가 BB까지 콜하면 BB에게 한 번 더 차례가 돌아감)
    this.lastAggressorId = bbP.playerId;
    this.toActId = playing.length === 2 ? sbP.playerId : this.nextToAct(bbIdx);
    // BB가 올인이 아니면 옵션을 줘야 하므로 라운드 종료 판정에서 BB 미행동을 추적
    bbP.actedThisRound = false;
    this.beginTurn();
  }

  private nextSeatIdx(fromIdx: number): number {
    const seats = this.seats();
    const n = seats.length;
    for (let step = 1; step <= n; step++) {
      const idx = (fromIdx + step) % n;
      if (seats[idx]!.inHand === true) return idx;
    }
    return fromIdx;
  }

  private postBlind(p: { [k: string]: unknown; name: string }, amount: number, label: string): void {
    const pay = Math.min(amount, this.chips(p));
    p.chips = this.chips(p) - pay;
    p.bet = ((p.bet as number) ?? 0) + pay;
    p.committed = ((p.committed as number) ?? 0) + pay;
    if (this.chips(p) === 0) p.allIn = true;
    this.say(`${p.name} ${label} ${pay}`);
  }

  // ── 턴 시작 (타이머) ─────────────────────────────────────────
  private beginTurn(): void {
    // 행동 가능한 사람이 1명 이하면 곧장 스트리트 종료
    if (this.notAllIn().length === 0) {
      this.endStreet();
      return;
    }
    if (this.toActId === null) {
      this.endStreet();
      return;
    }
    this.room.startTimer(DECISION_SECONDS, () => this.onTimeout());
  }

  private onTimeout(): void {
    const id = this.toActId;
    if (!id) return;
    const p = this.room.player(id);
    if (!p) return;
    // 타임아웃: 콜이 공짜면 체크, 아니면 폴드
    const toCall = this.currentBet - ((p.bet as number) ?? 0);
    if (toCall <= 0) this.applyAction(id, 'check');
    else this.applyAction(id, 'fold');
  }

  // ── 행동 처리 ───────────────────────────────────────────────
  onAction(playerId: string, action: GameAction): void {
    if (this.room.phase !== 'playing') throw new Error('게임이 진행 중이 아닙니다.');
    if (playerId !== this.toActId) throw new Error('당신의 차례가 아닙니다.');
    const kind = action.kind as 'fold' | 'check' | 'call' | 'raise' | 'allin';
    const amount = typeof action.amount === 'number' ? action.amount : undefined;
    this.applyAction(playerId, kind, amount);
  }

  private applyAction(id: string, kind: 'fold' | 'check' | 'call' | 'raise' | 'allin', amount?: number): void {
    const p = this.room.player(id)!;
    const myBet = (p.bet as number) ?? 0;
    const toCall = this.currentBet - myBet;
    const stack = this.chips(p);

    switch (kind) {
      case 'fold': {
        p.folded = true;
        this.say(`${p.name} 폴드`);
        break;
      }
      case 'check': {
        if (toCall > 0) throw new Error('체크할 수 없습니다 — 콜이 필요합니다.');
        this.say(`${p.name} 체크`);
        break;
      }
      case 'call': {
        if (toCall <= 0) throw new Error('콜할 금액이 없습니다 — 체크하세요.');
        const pay = Math.min(toCall, stack);
        this.commit(p, pay);
        if (this.chips(p) === 0) {
          p.allIn = true;
          this.say(`${p.name} 콜 올인 ${pay}`);
        } else this.say(`${p.name} 콜 ${pay}`);
        break;
      }
      case 'raise': {
        // amount = "이번 스트리트 총 베트 목표액"
        if (amount === undefined) throw new Error('레이즈 금액을 지정하세요.');
        const target = Math.floor(amount);
        const minTarget = this.currentBet + this.minRaise;
        if (target < minTarget) throw new Error(`최소 ${minTarget}까지 레이즈해야 합니다.`);
        const pay = target - myBet;
        if (pay > stack) throw new Error('칩이 부족합니다 — 올인을 사용하세요.');
        const raiseSize = target - this.currentBet;
        this.commit(p, pay);
        this.minRaise = raiseSize;
        this.currentBet = target;
        this.lastAggressorId = id;
        if (this.chips(p) === 0) p.allIn = true;
        this.say(`${p.name} 레이즈 → ${target}`);
        break;
      }
      case 'allin': {
        if (stack <= 0) throw new Error('올인할 칩이 없습니다.');
        const target = myBet + stack;
        this.commit(p, stack);
        p.allIn = true;
        if (target > this.currentBet) {
          // 풀레이즈 미만 올인이라도 베트 라인은 올린다. minRaise는 풀레이즈 시에만 갱신.
          const raiseSize = target - this.currentBet;
          if (raiseSize >= this.minRaise) this.minRaise = raiseSize;
          this.currentBet = target;
          this.lastAggressorId = id;
        }
        this.say(`${p.name} 올인 ${stack} (총 ${target})`);
        break;
      }
    }
    p.actedThisRound = true;

    // 마지막 1명 남으면 즉시 핸드 종료(무쇼다운)
    if (this.active().length === 1) {
      this.awardUncontested();
      return;
    }
    this.advance();
  }

  private commit(p: { [k: string]: unknown }, pay: number): void {
    p.chips = this.chips(p) - pay;
    p.bet = ((p.bet as number) ?? 0) + pay;
    p.committed = ((p.committed as number) ?? 0) + pay;
  }

  // 다음 행동자로 이동하거나 스트리트 종료
  private advance(): void {
    this.room.clearTimer();
    const fromIdx = this.seatIdx(this.toActId!);
    const next = this.nextToAct(fromIdx);

    // 라운드 종료 조건: 다음 행동자가 없거나, 모두 currentBet에 맞췄고 마지막 공격자에게 돌아온 경우
    if (next === null) {
      this.endStreet();
      return;
    }
    // 모든 미폴드·미올인 플레이어가 행동했고 베트가 같으면 종료
    const allMatched = this.notAllIn().every(
      (p) => (p.actedThisRound === true) && ((p.bet as number) ?? 0) === this.currentBet
    );
    // 단, lastAggressor에게 차례가 돌아오면 그 사람은 다시 행동하지 않음(이미 최종 공격자)
    if (allMatched && next === this.lastAggressorId) {
      this.endStreet();
      return;
    }
    this.toActId = next;
    this.beginTurn();
  }

  // ── 스트리트 종료 → 다음 스트리트 또는 쇼다운 ────────────────
  private endStreet(): void {
    this.room.clearTimer();
    // 이번 스트리트 베트를 팟으로 모으고 리셋
    for (const p of this.inHand()) {
      this.potCommitted += (p.bet as number) ?? 0;
      p.bet = 0;
      p.actedThisRound = false;
    }
    this.currentBet = 0;
    this.minRaise = BIG_BLIND;

    if (this.street === 'river') {
      this.showdown();
      return;
    }

    // 다음 커뮤니티 카드 오픈
    if (this.street === 'preflop') {
      this.deck.pop(); // 번 카드
      this.board.push(this.deck.pop()!, this.deck.pop()!, this.deck.pop()!);
      this.street = 'flop';
      this.say(`🃏 플랍: ${this.board.map(cardStr).join(' ')}`);
    } else if (this.street === 'flop') {
      this.deck.pop();
      this.board.push(this.deck.pop()!);
      this.street = 'turn';
      this.say(`🃏 턴: ${cardStr(this.board[3]!)}`);
    } else if (this.street === 'turn') {
      this.deck.pop();
      this.board.push(this.deck.pop()!);
      this.street = 'river';
      this.say(`🃏 리버: ${cardStr(this.board[4]!)}`);
    }

    // 베팅 가능한 사람이 1명 이하(전원 올인 등)면 더 이상 베팅이 없다 → 보드를 끝까지 깔고 쇼다운.
    // (혼자 남은 1명은 콜할 상대가 없으므로 행동 의미가 없어 자동 진행한다.)
    if (this.notAllIn().length <= 1) {
      this.toActId = null;
      this.endStreet(); // 재귀적으로 다음 카드를 깔고, 리버면 showdown
      return;
    }

    // 포스트플랍 첫 행동: 버튼 다음의 첫 활성 좌석
    this.toActId = this.nextToAct(this.dealerIdx);
    this.lastAggressorId = this.toActId; // 베트 없이 시작 → 한 바퀴 돌면 종료
    this.beginTurn();
  }

  // ── 무쇼다운(전원 폴드) ─────────────────────────────────────
  private awardUncontested(): void {
    this.room.clearTimer();
    for (const p of this.inHand()) {
      this.potCommitted += (p.bet as number) ?? 0;
      p.bet = 0;
    }
    const winner = this.active()[0]!;
    winner.chips = this.chips(winner) + this.potCommitted;
    this.winnerNames = [winner.name];
    this.say(`🏆 ${winner.name} 단독 승리 (+${this.potCommitted})`);
    this.street = 'showdown';
    this.afterHand();
  }

  // ── 쇼다운 ──────────────────────────────────────────────────
  private showdown(): void {
    this.street = 'showdown';
    const contenders = this.active(); // 끝까지 남은 플레이어
    // 각자 최강 핸드 평가 + 공개
    const scores = new Map<string, number[]>();
    for (const p of contenders) {
      const hole = this.hole.get(p.playerId)!;
      const score = best7([...hole, ...this.board]);
      scores.set(p.playerId, score);
      this.revealed.push({ id: p.playerId, name: p.name, cards: [...hole], hand: CAT_LABEL[score[0]!]! });
    }

    // ── 사이드 팟: 핸드 전체 기여(committed) 레벨별로 팟을 쪼갠다 ──
    // 1) 모든 inHand 플레이어의 committed를 모은다(폴드한 사람의 칩도 팟에 포함).
    const all = this.inHand();
    const levels = [...new Set(all.map((p) => (p.committed as number) ?? 0).filter((v) => v > 0))].sort(
      (a, b) => a - b
    );
    let prev = 0;
    const pots: { amount: number; eligible: string[] }[] = [];
    for (const lvl of levels) {
      const layer = lvl - prev;
      // 이 레벨 이상 기여한 모든 플레이어가 layer만큼 부담
      const contributors = all.filter((p) => ((p.committed as number) ?? 0) >= lvl);
      const amount = layer * contributors.length;
      // 이 팟을 가져갈 자격: 이 레벨 이상 기여 + 끝까지 안 폴드한 사람
      const eligible = contributors.filter((p) => p.folded !== true).map((p) => p.playerId);
      pots.push({ amount, eligible });
      prev = lvl;
    }

    // 2) 각 팟을 자격자 중 최강 핸드에게. 동점 split, 나머지 칩은 버튼 왼쪽부터.
    const wonBy = new Set<string>();
    for (const pot of pots) {
      if (pot.amount <= 0 || pot.eligible.length === 0) continue;
      let bestScore: number[] | null = null;
      let winners: string[] = [];
      for (const id of pot.eligible) {
        const sc = scores.get(id)!;
        if (!bestScore || cmpScore(sc, bestScore) > 0) {
          bestScore = sc;
          winners = [id];
        } else if (cmpScore(sc, bestScore) === 0) winners.push(id);
      }
      const share = Math.floor(pot.amount / winners.length);
      let remainder = pot.amount - share * winners.length;
      // 홀수 칩은 딜러 왼쪽(시계방향 첫) 승자부터
      const ordered = this.orderFromButton(winners);
      for (const id of ordered) {
        const p = this.room.player(id)!;
        let take = share;
        if (remainder > 0) {
          take += 1;
          remainder -= 1;
        }
        p.chips = this.chips(p) + take;
        wonBy.add(id);
      }
    }

    this.winnerNames = [...wonBy].map((id) => this.room.player(id)!.name);
    for (const r of this.revealed) {
      this.say(`🂠 ${r.name}: ${r.cards.map(cardStr).join(' ')} — ${r.hand}`);
    }
    this.say(`🏆 승자: ${this.winnerNames.join(', ')}`);
    this.afterHand();
  }

  // 버튼 다음 좌석부터 시계방향 순서로 주어진 id들을 정렬
  private orderFromButton(ids: string[]): string[] {
    const seats = this.seats();
    const n = seats.length;
    const result: string[] = [];
    for (let step = 1; step <= n; step++) {
      const id = seats[(this.dealerIdx + step) % n]!.playerId;
      if (ids.includes(id)) result.push(id);
    }
    return result;
  }

  // ── 핸드 종료 → 다음 핸드 또는 게임 종료 ─────────────────────
  private afterHand(): void {
    this.room.startTimer(SHOWDOWN_SECONDS, () => {
      const solvent = this.seats().filter((p) => this.chips(p) > 0);
      if (solvent.length <= 1 || this.handNo >= MAX_HANDS) {
        this.finish();
        return;
      }
      // 버튼을 다음 생존 좌석으로 이동
      this.dealerIdx = this.nextSeatIdx(this.dealerIdx);
      this.startHand();
    });
  }

  // ── 게임 종료/결산 ──────────────────────────────────────────
  private finish(): void {
    this.room.clearTimer();
    this.ended = true;
    this.room.phase = 'ended';
    this.street = 'showdown';

    // 최종 칩 순위. 칩 리더 won=true(+12 IQ, +40 코인). 나머지는 칩 비율로 스케일.
    const seats = this.seats();
    const ranked = [...seats].sort((a, b) => this.chips(b) - this.chips(a));
    const top = ranked[0] ? this.chips(ranked[0]) : 0;
    const leaderChips = top || 1;
    this.finalWinnerId = top > 0 && ranked[0] ? ranked[0].playerId : null;
    ranked.forEach((p, i) => {
      if (i === 0 && top > 0) {
        p.iqDelta = 12;
        p.coinsDelta = 40;
      } else {
        // 칩 비율(0~1) 기준: 시작칩 대비 손익을 IQ/코인으로 환산
        const ratio = this.chips(p) / leaderChips; // 0..1
        p.iqDelta = Math.round(-3 + ratio * 9); // 꼴찌 약 -3, 2등권 +
        p.coinsDelta = Math.max(0, Math.round(this.chips(p) / 50));
      }
    });
    this.finalBoard = ranked.map((p, i) => ({
      name: `${i === 0 ? '🏆 ' : ''}${p.name} · ${this.chips(p)}칩`,
      iqDelta: (p.iqDelta as number) ?? 0,
      coinsDelta: (p.coinsDelta as number) ?? 0,
      won: i === 0 && top > 0,
    }));
    this.say('🏁 게임 종료 — 최종 칩 순위로 결산합니다.');
  }

  // ── 직렬화 ──────────────────────────────────────────────────
  playerView(player: PlayerView, viewerId: string): Record<string, unknown> {
    const p = player as unknown as { playerId: string; [k: string]: unknown };
    const idx = this.seatIdx(p.playerId);
    const showdownOrEnd = this.street === 'showdown' || this.ended;
    const isContender = this.revealed.some((r) => r.id === p.playerId);
    // 홀카드: 본인은 항상, 쇼다운에서 끝까지 남은(공개) 플레이어는 전원에게.
    let hole: number[] | undefined;
    if (p.playerId === viewerId) hole = this.hole.get(p.playerId);
    else if (showdownOrEnd && isContender) hole = this.hole.get(p.playerId);
    return {
      chips: this.chips(p),
      bet: (p.bet as number) ?? 0,
      committed: (p.committed as number) ?? 0,
      folded: p.folded === true,
      allIn: p.allIn === true,
      inHand: p.inHand === true,
      isDealer: idx === this.dealerIdx,
      isToAct: p.playerId === this.toActId,
      hole: hole ?? undefined,
    };
  }

  viewFor(viewerId: string): unknown {
    const me = this.room.player(viewerId);
    const myBet = me ? (me.bet as number) ?? 0 : 0;
    const v: Record<string, unknown> = {
      mode: 'poker',
      street: this.street,
      log: this.log.slice(-40),
      board: this.board.slice(),
      pot: this.totalPot(),
      currentBetToCall: Math.max(0, this.currentBet - myBet),
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      bigBlind: BIG_BLIND,
      myChips: me ? this.chips(me) : 0,
      myHole: me ? this.hole.get(viewerId) ?? null : null,
      turnPlayerId: this.toActId,
      dealerId: this.seats()[this.dealerIdx]?.playerId ?? null,
      handNo: this.handNo,
      maxHands: MAX_HANDS,
    };
    if (this.street === 'showdown' || this.ended) {
      v.revealed = this.revealed.map((r) => ({ ...r, cardStrs: r.cards.map(cardStr) }));
      v.winnerNames = this.winnerNames;
    }
    if (this.ended) v.finalBoard = this.finalBoard;
    return v;
  }

  // 현재 테이블 위 총 팟 (확정분 + 이번 스트리트 베트)
  private totalPot(): number {
    let live = 0;
    for (const p of this.inHand()) live += (p.bet as number) ?? 0;
    return this.potCommitted + live;
  }

  results(): GameResult[] {
    return this.seats().map((p) => ({
      userId: p.userId,
      iqDelta: (p.iqDelta as number) ?? 0,
      coinsDelta: (p.coinsDelta as number) ?? 0,
      won: p.playerId === this.finalWinnerId,
    }));
  }
}
