// 마피아 엔진 — 시스템이 사회자를 대신한다.
// 진행: 밤(마피아 지목·경찰 조사·의사 치료) → 아침 발표 → 낮 토론(전원 동의 시 스킵)
//       → 투표 → 처형 발표 → 승리 판정 → 다음 밤. 단계별 타이머 + 전원 행동 시 조기 진행.
// 채팅: 밤엔 마피아 전용(vis='mafia'), 사망자는 유령 채팅(vis='dead'), 낮엔 전체 공개.
import { GameEngine, Room, type GameResult } from '@dopl/core';
import type { ChatMessage, GameAction, PlayerView } from '@dopl/protocol';

export type Role = 'mafia' | 'police' | 'doctor' | 'citizen';
type Stage = 'night' | 'dawn' | 'day' | 'vote' | 'execution' | null;

const NIGHT_SECONDS = 30;
const DAWN_SECONDS = 6;
const DAY_SECONDS = 60;
const VOTE_SECONDS = 25;
const EXEC_SECONDS = 7;

const ROLE_LABEL: Record<Role, string> = { mafia: '마피아', police: '경찰', doctor: '의사', citizen: '시민' };
const ROLE_ICON: Record<Role, string> = { mafia: '🔪', police: '🕵️', doctor: '💉', citizen: '👤' };

// 승리 보상 (IQ는 economy의 체감식이 다시 보정)
const WIN_MAFIA = { iq: 14, coins: 45 };
const WIN_CITIZEN = { iq: 10, coins: 30 };
const LOSE_MAFIA_IQ = -3;
const LOSE_CITIZEN_IQ = -2;

interface Reveal {
  type: 'killed' | 'safe' | 'peace' | 'executed' | 'novote';
  name?: string;
  role?: Role;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export class MafiaEngine extends GameEngine {
  private stage: Stage = null;
  private day = 0;

  // 밤 행동 (라운드마다 리셋)
  private mafiaPicks = new Map<string, string>(); // mafiaId → targetId (재선택 가능)
  private doctorPick: string | null = null;
  private policeDone = false;

  private investigations: { name: string; mafia: boolean }[] = []; // 경찰 누적 조사 기록
  private votes = new Map<string, string>(); // voterId → targetId | 'abstain'
  private skips = new Set<string>(); // 낮 토론 건너뛰기 동의

  private reveal: Reveal | null = null;
  private winner: 'mafia' | 'citizen' | null = null;
  private log: string[] = [];
  private finalBoard: { name: string; iqDelta: number; coinsDelta: number; won: boolean }[] = [];

  constructor(private room: Room) {
    super();
  }

  // ── 헬퍼 ────────────────────────────────────────────────────
  private alive() {
    return this.room.list().filter((p) => p.alive !== false);
  }
  private aliveMafia() {
    return this.alive().filter((p) => p.role === 'mafia');
  }
  private role(p: { [key: string]: unknown }): Role {
    return p.role as Role;
  }
  private say(text: string) {
    this.log.push(text);
  }

  // ── 시작/역할 배정 ──────────────────────────────────────────
  async start(requesterId: string): Promise<void> {
    if (!this.room.isHost(requesterId)) throw new Error('호스트만 시작할 수 있습니다.');
    if (this.room.phase !== 'lobby') throw new Error('이미 시작된 게임입니다.');
    const players = this.room.list();
    const n = players.length;
    if (n < 4) throw new Error('마피아는 최소 4명이 필요합니다.');

    const mafiaCount = n >= 9 ? 3 : n >= 6 ? 2 : 1;
    const roles: Role[] = [
      ...Array<Role>(mafiaCount).fill('mafia'),
      'police',
      'doctor',
      ...Array<Role>(n - mafiaCount - 2).fill('citizen'),
    ];
    const shuffled = shuffle(roles);
    players.forEach((p, i) => {
      p.role = shuffled[i];
      p.alive = true;
      p.iqDelta = 0;
      p.coinsDelta = 0;
    });

    this.room.phase = 'playing';
    this.day = 0;
    this.investigations = [];
    this.winner = null;
    this.say(`🎭 마피아 게임 시작! (${n}명 — 마피아 ${mafiaCount} · 경찰 1 · 의사 1 · 시민 ${n - mafiaCount - 2})`);
    this.say('역할 카드를 확인하세요. 곧 밤이 됩니다…');
    this.startNight();
  }

  // ── 밤 ─────────────────────────────────────────────────────
  private startNight(): void {
    this.day += 1;
    this.stage = 'night';
    this.mafiaPicks.clear();
    this.doctorPick = null;
    this.policeDone = false;
    this.reveal = null;
    this.say(`🌙 ${this.day}번째 밤이 깊었습니다. 마피아가 움직입니다…`);
    this.room.startTimer(NIGHT_SECONDS, () => this.resolveNight());
  }

  private maybeResolveNight(): void {
    const mafias = this.aliveMafia();
    const police = this.alive().find((p) => this.role(p) === 'police');
    const doctor = this.alive().find((p) => this.role(p) === 'doctor');
    const mafiaReady = mafias.every((m) => this.mafiaPicks.has(m.playerId));
    const policeReady = !police || this.policeDone;
    const doctorReady = !doctor || this.doctorPick !== null;
    if (mafiaReady && policeReady && doctorReady) this.resolveNight();
  }

  private resolveNight(): void {
    this.room.clearTimer();
    // 마피아 다수결 (동률이면 무작위)
    const tally = new Map<string, number>();
    for (const t of this.mafiaPicks.values()) tally.set(t, (tally.get(t) ?? 0) + 1);
    let targetId: string | null = null;
    if (tally.size > 0) {
      const max = Math.max(...tally.values());
      const tops = [...tally.entries()].filter(([, c]) => c === max).map(([id]) => id);
      targetId = tops[Math.floor(Math.random() * tops.length)]!;
    }

    const target = targetId ? this.room.player(targetId) : undefined;
    if (!target || target.alive === false) {
      this.reveal = { type: 'peace' };
      this.say('🕊 아무 일도 일어나지 않은 평화로운 밤이었습니다.');
    } else if (targetId === this.doctorPick) {
      this.reveal = { type: 'safe', name: target.name };
      this.say(`💉 마피아가 ${target.name}님을 노렸지만, 의사가 살려냈습니다!`);
    } else {
      target.alive = false;
      this.reveal = { type: 'killed', name: target.name, role: this.role(target) };
      this.say(`☠️ ${target.name}님이 살해당했습니다. (직업: ${ROLE_ICON[this.role(target)]} ${ROLE_LABEL[this.role(target)]})`);
    }

    this.stage = 'dawn';
    this.room.startTimer(DAWN_SECONDS, () => {
      if (!this.checkEnd()) this.startDay();
    });
  }

  // ── 낮 ─────────────────────────────────────────────────────
  private startDay(): void {
    this.stage = 'day';
    this.skips.clear();
    this.say(`☀️ ${this.day}일차 낮 — 토론하세요. 누가 마피아일까요? (전원 동의 시 바로 투표)`);
    this.room.startTimer(DAY_SECONDS, () => this.startVote());
  }

  private startVote(): void {
    this.room.clearTimer();
    this.stage = 'vote';
    this.votes.clear();
    this.say('🗳 투표 시간! 처형할 사람을 지목하세요. (기권 가능)');
    this.room.startTimer(VOTE_SECONDS, () => this.resolveVote());
  }

  private resolveVote(): void {
    this.room.clearTimer();
    const tally = new Map<string, number>();
    for (const t of this.votes.values()) {
      if (t !== 'abstain') tally.set(t, (tally.get(t) ?? 0) + 1);
    }
    let executed: ReturnType<Room['player']> | undefined;
    if (tally.size > 0) {
      const max = Math.max(...tally.values());
      const tops = [...tally.entries()].filter(([, c]) => c === max);
      if (tops.length === 1) executed = this.room.player(tops[0]![0]);
    }

    if (executed && executed.alive !== false) {
      executed.alive = false;
      this.reveal = { type: 'executed', name: executed.name, role: this.role(executed) };
      this.say(`⚖️ 투표 결과 — ${executed.name}님이 처형되었습니다. (직업: ${ROLE_ICON[this.role(executed)]} ${ROLE_LABEL[this.role(executed)]})`);
    } else {
      this.reveal = { type: 'novote' };
      this.say('⚖️ 표가 모이지 않아 아무도 처형되지 않았습니다.');
    }

    this.stage = 'execution';
    this.room.startTimer(EXEC_SECONDS, () => {
      if (!this.checkEnd()) this.startNight();
    });
  }

  // ── 승리 판정/종료 ──────────────────────────────────────────
  private checkEnd(): boolean {
    const mafiaN = this.aliveMafia().length;
    const otherN = this.alive().length - mafiaN;
    if (mafiaN === 0) {
      this.end('citizen');
      return true;
    }
    if (mafiaN >= otherN) {
      this.end('mafia');
      return true;
    }
    return false;
  }

  private end(winner: 'mafia' | 'citizen'): void {
    this.room.clearTimer();
    this.stage = null;
    this.winner = winner;
    this.room.phase = 'ended';

    for (const p of this.room.list()) {
      const isMafia = this.role(p) === 'mafia';
      const won = (winner === 'mafia') === isMafia;
      if (won) {
        const r = isMafia ? WIN_MAFIA : WIN_CITIZEN;
        p.iqDelta = r.iq;
        p.coinsDelta = r.coins;
      } else {
        p.iqDelta = isMafia ? LOSE_MAFIA_IQ : LOSE_CITIZEN_IQ;
        p.coinsDelta = 0;
      }
    }
    this.finalBoard = this.room
      .list()
      .map((p) => ({
        name: `${ROLE_ICON[this.role(p)]} ${p.name} · ${ROLE_LABEL[this.role(p)]}`,
        iqDelta: (p.iqDelta as number) ?? 0,
        coinsDelta: (p.coinsDelta as number) ?? 0,
        won: (winner === 'mafia') === (this.role(p) === 'mafia'),
      }))
      .sort((a, b) => Number(b.won) - Number(a.won));
    this.say(winner === 'mafia' ? '🔪 마피아의 승리! 도시가 어둠에 잠겼습니다…' : '🎉 시민의 승리! 마피아를 모두 찾아냈습니다!');
  }

  // ── 행동 ────────────────────────────────────────────────────
  onAction(playerId: string, action: GameAction): void {
    if (this.room.phase !== 'playing') throw new Error('게임이 진행 중이 아닙니다.');
    const me = this.room.player(playerId);
    if (!me || me.alive === false) throw new Error('사망하여 행동할 수 없습니다.');
    const myRole = this.role(me);
    const target = typeof action.target === 'string' ? this.room.player(action.target) : undefined;

    switch (action.kind) {
      case 'kill': {
        if (this.stage !== 'night' || myRole !== 'mafia') throw new Error('지금은 할 수 없습니다.');
        if (!target || target.alive === false) throw new Error('생존자를 지목하세요.');
        if (this.role(target) === 'mafia') throw new Error('동료 마피아는 지목할 수 없습니다.');
        this.mafiaPicks.set(playerId, target.playerId);
        this.maybeResolveNight();
        return;
      }
      case 'investigate': {
        if (this.stage !== 'night' || myRole !== 'police') throw new Error('지금은 할 수 없습니다.');
        if (this.policeDone) throw new Error('오늘 밤 조사는 끝났습니다.');
        if (!target || target.alive === false) throw new Error('생존자를 지목하세요.');
        if (target.playerId === playerId) throw new Error('자신은 조사할 수 없습니다.');
        this.policeDone = true;
        this.investigations.push({ name: target.name, mafia: this.role(target) === 'mafia' });
        this.maybeResolveNight();
        return;
      }
      case 'heal': {
        if (this.stage !== 'night' || myRole !== 'doctor') throw new Error('지금은 할 수 없습니다.');
        if (!target || target.alive === false) throw new Error('생존자를 지목하세요.');
        this.doctorPick = target.playerId; // 자기 자신 보호 가능, 재선택 가능
        this.maybeResolveNight();
        return;
      }
      case 'vote': {
        if (this.stage !== 'vote') throw new Error('지금은 투표 시간이 아닙니다.');
        if (action.target === 'abstain') this.votes.set(playerId, 'abstain');
        else {
          if (!target || target.alive === false) throw new Error('생존자에게 투표하세요.');
          this.votes.set(playerId, target.playerId);
        }
        if (this.alive().every((p) => this.votes.has(p.playerId))) this.resolveVote();
        return;
      }
      case 'skipDay': {
        if (this.stage !== 'day') throw new Error('지금은 토론 시간이 아닙니다.');
        this.skips.add(playerId);
        if (this.alive().every((p) => this.skips.has(p.playerId))) {
          this.say('⏩ 전원 동의 — 바로 투표로 넘어갑니다.');
          this.startVote();
        }
        return;
      }
      default:
        return;
    }
  }

  // ── 채팅 (사회자 통제) ──────────────────────────────────────
  onChat(playerId: string, text: string): void {
    const p = this.room.player(playerId);
    if (!p) return;
    if (p.alive === false) {
      this.room.addChat(playerId, text, 'dead'); // 유령 채팅
      return;
    }
    if (this.stage === 'night') {
      if (this.role(p) === 'mafia') this.room.addChat(playerId, text, 'mafia'); // 마피아 작전 채팅
      return; // 시민은 밤에 침묵 (클라에서 입력 잠금)
    }
    this.room.addChat(playerId, text);
  }

  chatVisible(msg: ChatMessage, viewerId: string): boolean {
    if (this.room.phase === 'ended') return true; // 종료 후 전체 공개 (복기)
    const v = this.room.player(viewerId);
    if (!v) return false;
    if (v.alive === false) return true; // 사망자는 모든 채널 관전
    if (msg.vis === 'mafia') return this.role(v) === 'mafia';
    return false; // 'dead' 채널은 산 사람에게 숨김
  }

  // ── 직렬화 ──────────────────────────────────────────────────
  playerView(player: PlayerView, viewerId: string): Record<string, unknown> {
    const p = player as unknown as { playerId: string; alive?: boolean; role?: Role };
    const viewer = this.room.player(viewerId);
    const viewerDead = viewer ? viewer.alive === false : false;
    const viewerMafia = viewer ? this.role(viewer) === 'mafia' : false;
    const dead = p.alive === false;
    const ended = this.room.phase === 'ended';
    // 직업 공개: 사망자/게임종료 → 전체, 마피아끼리, 관전(사망) 시점
    const showRole = dead || ended || viewerDead || (viewerMafia && p.role === 'mafia');
    const voteFor = this.stage === 'vote' || this.stage === 'execution' ? this.votes.get(p.playerId) : undefined;
    return {
      alive: !dead,
      role: showRole ? p.role : undefined,
      voted: this.stage === 'vote' ? this.votes.has(p.playerId) : undefined,
      voteCount:
        this.stage === 'vote' || this.stage === 'execution'
          ? [...this.votes.values()].filter((t) => t === p.playerId).length
          : undefined,
      voteTarget: voteFor === undefined ? undefined : voteFor, // 공개 투표 — 누가 누구에게 투표했는지
    };
  }

  viewFor(viewerId: string): unknown {
    const me = this.room.player(viewerId);
    const myRole = me ? this.role(me) : undefined;
    const myAlive = me ? me.alive !== false : false;
    const v: Record<string, unknown> = {
      mode: 'mafia',
      stage: this.stage,
      day: this.day,
      log: this.log.slice(-40),
      myRole,
      myAlive,
      aliveCount: this.alive().length,
      chatLocked: this.stage === 'night' && myAlive && myRole !== 'mafia',
    };
    if (myRole === 'mafia') {
      v.mates = this.room
        .list()
        .filter((p) => this.role(p) === 'mafia')
        .map((p) => p.name);
      v.myPick = this.mafiaPicks.get(viewerId) ?? null;
    }
    if (myRole === 'police') {
      v.investigations = this.investigations;
      v.policeDone = this.policeDone;
    }
    if (myRole === 'doctor') v.myHeal = this.doctorPick;
    if (this.stage === 'vote') {
      v.myVote = this.votes.get(viewerId) ?? null;
      v.votedCount = this.votes.size;
    }
    if (this.stage === 'day') {
      v.skipCount = this.skips.size;
      v.mySkip = this.skips.has(viewerId);
    }
    if (this.stage === 'dawn' || this.stage === 'execution') v.reveal = this.reveal;
    if (this.room.phase === 'ended') {
      v.winner = this.winner;
      v.finalBoard = this.finalBoard;
    }
    return v;
  }

  results(): GameResult[] {
    return this.room.list().map((p) => ({
      userId: p.userId,
      iqDelta: (p.iqDelta as number) ?? 0,
      coinsDelta: (p.coinsDelta as number) ?? 0,
      won: this.winner !== null && (this.winner === 'mafia') === (this.role(p) === 'mafia'),
    }));
  }
}
