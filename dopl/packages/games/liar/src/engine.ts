// 라이어게임 엔진 — 시스템이 사회자를 대신한다.
// 진행: 카드 공개(reveal) → 좌석 순서 힌트(describe, 2라운드) → 투표(vote)
//       → 지목된 사람이 라이어면 라이어에게 단어 추측 1회 기회(guess) → 종료.
// 시민은 제시어를 알고, 라이어는 카테고리만 안다. 힌트는 채팅이 아니라 보드에 노출되는 별도 액션.
import { GameEngine, Room, type GameResult } from '@dopl/core';
import type { GameAction, PlayerView } from '@dopl/protocol';

type Stage = 'reveal' | 'describe' | 'vote' | 'guess' | null;

const REVEAL_SECONDS = 6;
const HINT_SECONDS = 25;
const VOTE_SECONDS = 30;
const GUESS_SECONDS = 20;
const HINT_ROUNDS = 2; // 각 플레이어가 두 번씩 힌트

// 승리 보상 (IQ는 economy의 체감식이 다시 보정)
const WIN_LIAR = { iq: 14, coins: 45 };
const WIN_CITIZEN = { iq: 10, coins: 30 };
const LOSE_LIAR_IQ = -3;
const LOSE_CITIZEN_IQ = -2;

// 단어 은행 — 카테고리 10 × 단어 8 (한국어)
const WORD_BANK: Record<string, string[]> = {
  '음식': ['김치찌개', '떡볶이', '치킨', '초밥', '햄버거', '비빔밥', '라면', '삼겹살'],
  '동물': ['사자', '코끼리', '펭귄', '강아지', '고양이', '기린', '돌고래', '호랑이'],
  '직업': ['의사', '교사', '소방관', '요리사', '가수', '프로그래머', '경찰', '변호사'],
  '스포츠': ['축구', '농구', '야구', '수영', '테니스', '골프', '배드민턴', '스키'],
  '나라': ['대한민국', '일본', '미국', '프랑스', '브라질', '이집트', '호주', '캐나다'],
  '과일': ['사과', '바나나', '딸기', '수박', '포도', '복숭아', '망고', '오렌지'],
  '교통수단': ['버스', '지하철', '비행기', '자전거', '택시', '기차', '배', '오토바이'],
  '직장': ['회의', '야근', '월급', '커피', '출근', '결재', '회식', '휴가'],
  '영화장르': ['공포', '로맨스', '액션', '코미디', '판타지', 'SF', '스릴러', '다큐멘터리'],
  '계절': ['벚꽃', '장마', '단풍', '눈사람', '바다', '해돋이', '크리스마스', '캠핑'],
};

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '');
}

export class LiarEngine extends GameEngine {
  private stage: Stage = null;
  private category = '';
  private word = '';
  private liarId: string | null = null;

  private order: string[] = []; // 좌석 순서(플레이어 id)
  private turnIdx = 0; // order 내 현재 차례
  private round = 1; // 1..HINT_ROUNDS
  private hints: { playerId: string; name: string; text: string }[] = [];

  private votes = new Map<string, string>(); // voterId → targetId
  private accusedId: string | null = null;
  private liarGuess: string | null = null;

  private winner: 'citizen' | 'liar' | null = null;
  private log: string[] = [];
  private finalBoard: { name: string; iqDelta: number; coinsDelta: number; won: boolean }[] = [];

  constructor(private room: Room) {
    super();
  }

  // ── 헬퍼 ────────────────────────────────────────────────────
  private say(text: string) {
    this.log.push(text);
  }
  private name(id: string): string {
    return this.room.player(id)?.name ?? '???';
  }
  private turnPlayerId(): string | null {
    return this.stage === 'describe' ? this.order[this.turnIdx] ?? null : null;
  }

  // ── 시작/배정 ──────────────────────────────────────────────
  async start(requesterId: string): Promise<void> {
    if (!this.room.isHost(requesterId)) throw new Error('호스트만 시작할 수 있습니다.');
    if (this.room.phase !== 'lobby') throw new Error('이미 시작된 게임입니다.');
    const players = this.room.list();
    const n = players.length;
    if (n < 3) throw new Error('라이어게임은 최소 3명이 필요합니다.');
    if (n > 8) throw new Error('라이어게임은 최대 8명까지 가능합니다.');

    // 카테고리·제시어 무작위
    const cats = Object.keys(WORD_BANK);
    this.category = cats[Math.floor(Math.random() * cats.length)]!;
    const words = WORD_BANK[this.category]!;
    this.word = words[Math.floor(Math.random() * words.length)]!;

    // 라이어 1명 무작위 배정
    this.order = shuffle(players.map((p) => p.playerId));
    this.liarId = this.order[Math.floor(Math.random() * this.order.length)]!;
    for (const p of players) {
      p.role = p.playerId === this.liarId ? 'liar' : 'citizen';
      p.iqDelta = 0;
      p.coinsDelta = 0;
    }

    this.room.phase = 'playing';
    this.turnIdx = 0;
    this.round = 1;
    this.hints = [];
    this.votes.clear();
    this.accusedId = null;
    this.liarGuess = null;
    this.winner = null;
    this.say(`🤥 라이어게임 시작! (${n}명 — 라이어 1명이 섞여 있습니다)`);
    this.say(`카테고리: 「${this.category}」 — 카드를 확인하세요.`);
    this.startReveal();
  }

  // ── reveal ─────────────────────────────────────────────────
  private startReveal(): void {
    this.stage = 'reveal';
    this.room.startTimer(REVEAL_SECONDS, () => this.startDescribe());
  }

  // ── describe ───────────────────────────────────────────────
  private startDescribe(): void {
    this.stage = 'describe';
    this.say(`🗣 ${this.round}라운드 — 좌석 순서대로 단어에 대한 힌트를 한 줄씩 말하세요.`);
    this.beginTurn();
  }

  private beginTurn(): void {
    const id = this.turnPlayerId();
    if (id) this.say(`👉 ${this.name(id)}님의 차례입니다. (${this.round}/${HINT_ROUNDS}라운드)`);
    this.room.startTimer(HINT_SECONDS, () => {
      const cur = this.turnPlayerId();
      if (cur) {
        this.hints.push({ playerId: cur, name: this.name(cur), text: '(침묵)' });
        this.say(`⏱ ${this.name(cur)}님이 침묵했습니다.`);
      }
      this.advanceTurn();
    });
  }

  private advanceTurn(): void {
    this.room.clearTimer();
    this.turnIdx += 1;
    if (this.turnIdx >= this.order.length) {
      this.turnIdx = 0;
      this.round += 1;
      if (this.round > HINT_ROUNDS) {
        this.startVote();
        return;
      }
      this.say(`🗣 ${this.round}라운드 — 한 번 더 힌트를 말하세요.`);
    }
    this.beginTurn();
  }

  // ── vote ───────────────────────────────────────────────────
  private startVote(): void {
    this.room.clearTimer();
    this.stage = 'vote';
    this.votes.clear();
    this.say('🗳 투표! 라이어로 의심되는 사람을 지목하세요.');
    this.room.startTimer(VOTE_SECONDS, () => this.resolveVote());
  }

  private resolveVote(): void {
    this.room.clearTimer();
    const tally = new Map<string, number>();
    for (const t of this.votes.values()) tally.set(t, (tally.get(t) ?? 0) + 1);
    let accused: string | null = null;
    if (tally.size > 0) {
      const max = Math.max(...tally.values());
      const tops = [...tally.entries()].filter(([, c]) => c === max);
      if (tops.length === 1) accused = tops[0]![0]; // 동률이면 지목 실패
    }
    this.accusedId = accused;

    if (!accused) {
      this.say('🗳 표가 갈려 아무도 지목하지 못했습니다 — 라이어의 승리!');
      this.end('liar');
      return;
    }
    if (accused !== this.liarId) {
      this.say(`🗳 ${this.name(accused)}님이 지목됐지만 라이어가 아닙니다 — 라이어의 승리!`);
      this.end('liar');
      return;
    }
    // 라이어를 정확히 지목 — 라이어에게 마지막 단어 추측 기회
    this.say(`🗳 ${this.name(accused)}님이 라이어로 지목됐습니다! 마지막 기회 — 제시어를 맞혀보세요.`);
    this.startGuess();
  }

  // ── guess (라이어 역전 기회) ───────────────────────────────
  private startGuess(): void {
    this.room.clearTimer();
    this.stage = 'guess';
    this.liarGuess = null;
    this.room.startTimer(GUESS_SECONDS, () => this.resolveGuess());
  }

  private resolveGuess(): void {
    this.room.clearTimer();
    if (this.liarGuess !== null && normalize(this.liarGuess) === normalize(this.word)) {
      this.say(`🎯 라이어가 제시어 「${this.word}」를 맞혔습니다 — 대역전, 라이어의 승리!`);
      this.end('liar');
    } else {
      const g = this.liarGuess ? `「${this.liarGuess}」` : '(추측 없음)';
      this.say(`❌ 라이어의 추측 ${g} — 제시어는 「${this.word}」였습니다. 시민의 승리!`);
      this.end('citizen');
    }
  }

  // ── 종료 ───────────────────────────────────────────────────
  private end(winner: 'citizen' | 'liar'): void {
    this.room.clearTimer();
    this.stage = null;
    this.winner = winner;
    this.room.phase = 'ended';

    for (const p of this.room.list()) {
      const isLiar = p.playerId === this.liarId;
      const won = (winner === 'liar') === isLiar;
      if (won) {
        const r = isLiar ? WIN_LIAR : WIN_CITIZEN;
        p.iqDelta = r.iq;
        p.coinsDelta = r.coins;
      } else {
        p.iqDelta = isLiar ? LOSE_LIAR_IQ : LOSE_CITIZEN_IQ;
        p.coinsDelta = 0;
      }
    }
    this.finalBoard = this.room
      .list()
      .map((p) => {
        const isLiar = p.playerId === this.liarId;
        return {
          name: `${isLiar ? '🤥 라이어' : '🙂 시민'} ${p.name}`,
          iqDelta: (p.iqDelta as number) ?? 0,
          coinsDelta: (p.coinsDelta as number) ?? 0,
          won: (winner === 'liar') === isLiar,
        };
      })
      .sort((a, b) => Number(b.won) - Number(a.won));
  }

  // ── 행동 ───────────────────────────────────────────────────
  onAction(playerId: string, action: GameAction): void {
    if (this.room.phase !== 'playing') throw new Error('게임이 진행 중이 아닙니다.');
    const me = this.room.player(playerId);
    if (!me) throw new Error('참가자가 아닙니다.');

    switch (action.kind) {
      case 'hint': {
        if (this.stage !== 'describe') throw new Error('지금은 힌트 시간이 아닙니다.');
        if (this.turnPlayerId() !== playerId) throw new Error('당신의 차례가 아닙니다.');
        const text = typeof action.text === 'string' ? action.text.trim() : '';
        if (!text) throw new Error('힌트를 입력하세요.');
        this.hints.push({ playerId, name: me.name, text: text.slice(0, 60) });
        this.say(`💬 ${me.name}: ${text.slice(0, 60)}`);
        this.advanceTurn();
        return;
      }
      case 'vote': {
        if (this.stage !== 'vote') throw new Error('지금은 투표 시간이 아닙니다.');
        const target = typeof action.target === 'string' ? this.room.player(action.target) : undefined;
        if (!target) throw new Error('지목할 사람을 선택하세요.');
        if (target.playerId === playerId) throw new Error('자신에게는 투표할 수 없습니다.');
        this.votes.set(playerId, target.playerId);
        if (this.room.list().every((p) => this.votes.has(p.playerId))) this.resolveVote();
        return;
      }
      case 'guess': {
        if (this.stage !== 'guess') throw new Error('지금은 추측 시간이 아닙니다.');
        if (playerId !== this.liarId) throw new Error('라이어만 추측할 수 있습니다.');
        const text = typeof action.text === 'string' ? action.text.trim() : '';
        if (!text) throw new Error('추측할 단어를 입력하세요.');
        this.liarGuess = text.slice(0, 60);
        this.resolveGuess();
        return;
      }
      default:
        return;
    }
  }

  // ── 직렬화 ─────────────────────────────────────────────────
  playerView(player: PlayerView, _viewerId: string): Record<string, unknown> {
    const p = player as unknown as { playerId: string };
    const ended = this.room.phase === 'ended';
    const hasHinted = this.hints.some((h) => h.playerId === p.playerId);
    const voteFor = this.stage === 'vote' ? this.votes.get(p.playerId) : undefined;
    return {
      // 라이어 정체는 종료 전까지 절대 비공개
      role: ended ? (p.playerId === this.liarId ? 'liar' : 'citizen') : undefined,
      hasHinted,
      isTurn: this.turnPlayerId() === p.playerId,
      voted: this.stage === 'vote' ? this.votes.has(p.playerId) : undefined,
      voteCount:
        this.stage === 'vote'
          ? [...this.votes.values()].filter((t) => t === p.playerId).length
          : undefined,
      voteTarget: voteFor === undefined ? undefined : voteFor, // 공개 투표
    };
  }

  viewFor(viewerId: string): unknown {
    const amLiar = viewerId === this.liarId;
    const v: Record<string, unknown> = {
      mode: 'liar',
      stage: this.stage,
      log: this.log.slice(-40),
      category: this.category, // 카테고리는 전원에게 항상 공개
      myWord: amLiar ? null : this.word, // 라이어는 단어를 모름
      amLiar,
      round: this.round,
      maxRounds: HINT_ROUNDS,
      turnPlayerId: this.turnPlayerId(),
      hints: this.hints.map((h) => ({ name: h.name, text: h.text })),
    };
    if (this.stage === 'vote') {
      v.myVote = this.votes.get(viewerId) ?? null;
      v.votedCount = this.votes.size;
      v.aliveCount = this.room.list().length;
    }
    if (this.room.phase === 'ended') {
      v.winner = this.winner;
      v.word = this.word;
      v.liarName = this.liarId ? this.name(this.liarId) : '';
      v.finalBoard = this.finalBoard;
    }
    return v;
  }

  results(): GameResult[] {
    return this.room.list().map((p) => ({
      userId: p.userId,
      iqDelta: (p.iqDelta as number) ?? 0,
      coinsDelta: (p.coinsDelta as number) ?? 0,
      won: this.winner !== null && (this.winner === 'liar') === (p.playerId === this.liarId),
    }));
  }
}
