// OX 서바이벌 퀴즈 엔진. 출제→제한시간 O/X→정답공개+오답탈락→최후 생존.
import { GameEngine, Room, type GameResult } from '@dopl/core';
import type { GameAction, PlayerView } from '@dopl/protocol';

export interface OxQuestion {
  question: string;
  answer: boolean; // true=O, false=X
  category?: string;
}
type Loader = () => Promise<OxQuestion[]>;

const ANSWER_SECONDS = 12;
const REVEAL_SECONDS = 3;
const IQ_CORRECT = 3;
const IQ_WRONG = -2;
const IQ_WIN = 10;
const COIN_CORRECT = 5;
const COIN_WIN = 30;

interface Reveal {
  question: string;
  answer: boolean;
  correctNames: string[];
  eliminatedNames: string[];
  wipe: boolean;
}

export class OxQuizEngine extends GameEngine {
  private questions: OxQuestion[] = [];
  private idx = -1;
  private stage: 'answer' | 'reveal' | null = null;
  private log: string[] = [];
  private reveal: Reveal | null = null;
  private winnerNames: string[] = [];

  constructor(private room: Room) {
    super();
  }

  async start(requesterId: string): Promise<void> {
    if (!this.room.isHost(requesterId)) throw new Error('호스트만 시작할 수 있습니다.');
    if (this.room.phase !== 'lobby') throw new Error('이미 시작된 게임입니다.');
    const players = this.room.list();
    if (players.length < 2) throw new Error('최소 2명이 필요합니다.');

    const loader = this.room.context.loadOxQuestions as Loader | undefined;
    this.questions = loader ? await loader() : [];
    if (this.questions.length === 0) throw new Error('출제할 문제가 없습니다.');

    for (const p of players) {
      p.alive = true;
      p.answer = null;
      p.iqDelta = 0;
      p.coinsDelta = 0;
    }
    this.room.phase = 'playing';
    this.idx = -1;
    this.log.push(`OX 서바이벌 시작! 문제 ${this.questions.length}개. 틀리면 탈락.`);
    this.nextQuestion();
  }

  private alive() {
    return this.room.list().filter((p) => p.alive !== false);
  }

  private nextQuestion(): void {
    this.idx += 1;
    if (this.idx >= this.questions.length) return this.end('문제 소진');
    this.stage = 'answer';
    this.room.list().forEach((p) => {
      p.answer = null;
    });
    this.room.startTimer(ANSWER_SECONDS, () => this.resolveRound());
  }

  private allAnswered(): boolean {
    const a = this.alive();
    return a.length > 0 && a.every((p) => p.answer !== null && p.answer !== undefined);
  }

  private resolveRound(): void {
    this.room.clearTimer();
    const q = this.questions[this.idx]!;
    const alive = this.alive();
    const correct = alive.filter((p) => p.answer === q.answer);
    const wrong = alive.filter((p) => p.answer !== q.answer);
    const wipe = correct.length === 0; // 전원 오답이면 전멸 방지

    if (!wipe) {
      for (const p of correct) {
        p.iqDelta = ((p.iqDelta as number) ?? 0) + IQ_CORRECT;
        p.coinsDelta = ((p.coinsDelta as number) ?? 0) + COIN_CORRECT;
      }
      for (const p of wrong) {
        p.alive = false;
        p.iqDelta = ((p.iqDelta as number) ?? 0) + IQ_WRONG;
      }
    }
    this.reveal = {
      question: q.question,
      answer: q.answer,
      correctNames: correct.map((p) => p.name),
      eliminatedNames: wipe ? [] : wrong.map((p) => p.name),
      wipe,
    };
    this.log.push(
      wipe
        ? `정답 ${q.answer ? 'O' : 'X'} — 전원 오답! 아무도 탈락하지 않습니다.`
        : `정답 ${q.answer ? 'O' : 'X'} — ${wrong.length}명 탈락.`
    );

    this.stage = 'reveal';
    const survivors = this.alive();
    if (survivors.length <= 1 || this.idx >= this.questions.length - 1) {
      this.room.startTimer(REVEAL_SECONDS, () => this.end('생존자 확정'));
    } else {
      this.room.startTimer(REVEAL_SECONDS, () => this.nextQuestion());
    }
  }

  private end(_reason: string): void {
    this.room.clearTimer();
    this.stage = null;
    this.room.phase = 'ended';
    const survivors = this.alive();
    for (const p of survivors) {
      p.iqDelta = ((p.iqDelta as number) ?? 0) + IQ_WIN;
      p.coinsDelta = ((p.coinsDelta as number) ?? 0) + COIN_WIN;
    }
    this.winnerNames = survivors.map((p) => p.name);
    this.log.push(
      survivors.length ? `🏆 생존: ${this.winnerNames.join(', ')} (+${IQ_WIN} IQ, +${COIN_WIN} coins)` : '생존자 없음'
    );
  }

  onAction(playerId: string, action: GameAction): void {
    if (action.kind !== 'answer') return;
    if (this.room.phase !== 'playing' || this.stage !== 'answer') throw new Error('지금은 응답 시간이 아닙니다.');
    const p = this.room.player(playerId);
    if (!p || p.alive === false) throw new Error('탈락하여 응답할 수 없습니다.');
    if (p.answer !== null && p.answer !== undefined) return;
    p.answer = action.value === true;
    if (this.allAnswered()) this.resolveRound();
  }

  playerView(player: PlayerView): Record<string, unknown> {
    const p = player as { alive?: boolean; answer?: unknown };
    return {
      alive: p.alive !== false,
      answered: this.stage === 'answer' ? p.answer !== null && p.answer !== undefined : undefined,
    };
  }

  viewFor(viewerId: string): unknown {
    const me = this.room.player(viewerId);
    const q = this.questions[this.idx];
    const v: Record<string, unknown> = {
      stage: this.stage,
      round: this.idx + 1,
      total: this.questions.length,
      log: this.log.slice(-30),
      myAlive: me ? me.alive !== false : false,
      myAnswer: me ? (me.answer ?? null) : null,
      myIqDelta: me ? ((me.iqDelta as number) ?? 0) : 0,
      myCoinsDelta: me ? ((me.coinsDelta as number) ?? 0) : 0,
    };
    if (this.stage === 'answer' && q) v.question = { category: q.category, text: q.question };
    if (this.stage === 'reveal' || this.room.phase === 'ended') v.reveal = this.reveal;
    if (this.room.phase === 'ended') v.winnerNames = this.winnerNames;
    return v;
  }

  results(): GameResult[] {
    return this.room.list().map((p) => ({
      userId: p.userId,
      iqDelta: (p.iqDelta as number) ?? 0,
      coinsDelta: (p.coinsDelta as number) ?? 0,
      won: p.alive !== false,
    }));
  }
}
