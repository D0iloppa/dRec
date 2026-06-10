// 스피드퀴즈(주관식 타이핑) 엔진 — 큐플레이 방식.
// 문제 출제 → 채팅창에 답 타이핑 → 선착 정답자 득점 → 제한시간 절반에 초성 힌트 → N라운드 후 점수 랭킹.
import { GameEngine, Room, type GameResult } from '@dopl/core';
import type { GameAction, PlayerView } from '@dopl/protocol';

export interface TextQuestion {
  question: string;
  answers: string[]; // 허용 정답들(첫 항목이 대표 정답)
  category?: string;
}
type Loader = () => Promise<TextQuestion[]>;

const ANSWER_SECONDS = 20;
const HINT_SECONDS = 10; // 마지막 N초 동안 초성 힌트 공개
const REVEAL_SECONDS = 3;
const SCORE_CORRECT = 10;
const IQ_CORRECT = 4;
const COIN_CORRECT = 8;
const IQ_WIN = 10;
const COIN_WIN = 30;

const CHO = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

// 한글은 초성, 공백은 유지, 그 외(숫자/영문)는 ＊로 가린 힌트 문자열
export function chosungHint(answer: string): string {
  return [...answer]
    .map((ch) => {
      const code = ch.charCodeAt(0);
      if (code >= 0xac00 && code <= 0xd7a3) return CHO[Math.floor((code - 0xac00) / 588)]!;
      if (ch === ' ') return ' ';
      return '＊';
    })
    .join('');
}

// 글자수만 보여주는 마스크 (공백 유지)
function maskAnswer(answer: string): string {
  return [...answer].map((ch) => (ch === ' ' ? ' ' : '○')).join('');
}

// 대소문자/공백 무시 비교
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '');
}

interface Reveal {
  question: string;
  answer: string;
  winnerName: string | null; // null = 시간 초과(정답자 없음)
}

export class SpeedQuizEngine extends GameEngine {
  private questions: TextQuestion[] = [];
  private idx = -1;
  private stage: 'answer' | 'reveal' | null = null;
  private hintShown = false;
  private log: string[] = [];
  private reveal: Reveal | null = null;
  private winnerNames: string[] = [];
  private finalBoard: { name: string; score: number; iqDelta: number; coinsDelta: number; won: boolean }[] = [];

  constructor(private room: Room) {
    super();
  }

  async start(requesterId: string): Promise<void> {
    if (!this.room.isHost(requesterId)) throw new Error('호스트만 시작할 수 있습니다.');
    if (this.room.phase !== 'lobby') throw new Error('이미 시작된 게임입니다.');
    if (this.room.list().length < 2) throw new Error('최소 2명이 필요합니다.');

    const loader = this.room.context.loadTextQuestions as Loader | undefined;
    this.questions = loader ? await loader() : [];
    if (this.questions.length === 0) throw new Error('출제할 문제가 없습니다.');

    for (const p of this.room.list()) {
      p.score = 0;
      p.iqDelta = 0;
      p.coinsDelta = 0;
    }
    this.room.phase = 'playing';
    this.idx = -1;
    this.log.push(`⚡ 스피드퀴즈 시작! 문제 ${this.questions.length}개. 채팅창에 정답을 입력하세요!`);
    this.nextQuestion();
  }

  private nextQuestion(): void {
    this.idx += 1;
    if (this.idx >= this.questions.length) return this.end();
    this.stage = 'answer';
    this.hintShown = false;
    this.reveal = null;
    // 전반: 힌트 없이, 후반: 초성 힌트 공개
    this.room.startTimer(ANSWER_SECONDS - HINT_SECONDS, () => {
      this.hintShown = true;
      this.log.push(`💡 초성 힌트: ${chosungHint(this.questions[this.idx]!.answers[0]!)}`);
      this.room.startTimer(HINT_SECONDS, () => this.timeoutRound());
    });
  }

  private timeoutRound(): void {
    const q = this.questions[this.idx]!;
    this.reveal = { question: q.question, answer: q.answers[0]!, winnerName: null };
    this.log.push(`⏰ 시간 초과! 정답은 "${q.answers[0]}"`);
    this.toReveal();
  }

  private toReveal(): void {
    this.room.clearTimer();
    this.stage = 'reveal';
    if (this.idx >= this.questions.length - 1) this.room.startTimer(REVEAL_SECONDS, () => this.end());
    else this.room.startTimer(REVEAL_SECONDS, () => this.nextQuestion());
  }

  // 채팅 = 답안 제출. 오답도 채팅으로 노출(큐플레이 방식), 선착 정답이 라운드를 끝낸다.
  onChat(playerId: string, text: string): void {
    this.room.addChat(playerId, text);
    if (this.stage !== 'answer') return;
    const p = this.room.player(playerId);
    if (!p) return;
    const q = this.questions[this.idx]!;
    const guess = normalize(text);
    if (!guess || !q.answers.some((a) => normalize(a) === guess)) return;

    p.score = ((p.score as number) ?? 0) + SCORE_CORRECT;
    p.iqDelta = ((p.iqDelta as number) ?? 0) + IQ_CORRECT;
    p.coinsDelta = ((p.coinsDelta as number) ?? 0) + COIN_CORRECT;
    this.reveal = { question: q.question, answer: q.answers[0]!, winnerName: p.name };
    this.log.push(`⚡ ${p.name} 정답! "${q.answers[0]}" (+${SCORE_CORRECT}점)`);
    this.toReveal();
  }

  onAction(_playerId: string, _action: GameAction): void {
    // 스피드퀴즈는 채팅(onChat)으로만 진행. 별도 액션 없음.
  }

  private end(): void {
    this.room.clearTimer();
    this.stage = null;
    this.room.phase = 'ended';
    const ranked = this.room
      .list()
      .map((p) => ({ p, score: (p.score as number) ?? 0 }))
      .sort((a, b) => b.score - a.score);
    const top = ranked[0]?.score ?? 0;
    const winners = top > 0 ? ranked.filter((r) => r.score === top) : [];
    for (const { p } of winners) {
      p.iqDelta = ((p.iqDelta as number) ?? 0) + IQ_WIN;
      p.coinsDelta = ((p.coinsDelta as number) ?? 0) + COIN_WIN;
    }
    this.winnerNames = winners.map((r) => r.p.name);
    this.finalBoard = ranked.map(({ p, score }) => ({
      name: p.name,
      score,
      iqDelta: (p.iqDelta as number) ?? 0,
      coinsDelta: (p.coinsDelta as number) ?? 0,
      won: this.winnerNames.includes(p.name),
    }));
    this.log.push(this.winnerNames.length ? `🏆 우승: ${this.winnerNames.join(', ')} (${top}점)` : '정답자가 없어 우승자 없음');
  }

  playerView(player: PlayerView): Record<string, unknown> {
    const p = player as { score?: number };
    return { score: p.score ?? 0 };
  }

  viewFor(viewerId: string): unknown {
    const me = this.room.player(viewerId);
    const q = this.questions[this.idx];
    const v: Record<string, unknown> = {
      stage: this.stage,
      round: this.idx + 1,
      total: this.questions.length,
      log: this.log.slice(-30),
      myScore: me ? ((me.score as number) ?? 0) : 0,
    };
    if (this.stage === 'answer' && q) {
      v.question = {
        category: q.category,
        text: q.question,
        mask: maskAnswer(q.answers[0]!),
        hint: this.hintShown ? chosungHint(q.answers[0]!) : null,
      };
    }
    if (this.stage === 'reveal' || this.room.phase === 'ended') v.reveal = this.reveal;
    if (this.room.phase === 'ended') {
      v.winnerNames = this.winnerNames;
      v.finalBoard = this.finalBoard;
    }
    return v;
  }

  results(): GameResult[] {
    return this.room.list().map((p) => ({
      userId: p.userId,
      iqDelta: (p.iqDelta as number) ?? 0,
      coinsDelta: (p.coinsDelta as number) ?? 0,
      won: this.winnerNames.includes(p.name),
    }));
  }
}
