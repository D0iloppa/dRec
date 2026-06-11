// 뿌요뿌요 엔진 — THIN 릴레이.
// 뿌요는 실시간 게임이라 서버가 프레임 단위 권위 시뮬을 돌릴 수 없다.
// 그래서 클라이언트(Phaser 씬)가 낙하/연쇄 시뮬 전부를 로컬로 돌리고,
// 서버는 (1) 두 플레이어 페어링 (2) 공유 시드 배포 (3) 방해뿌요(garbage) 공격 릴레이
// (4) topout 발생 시 승패 판정만 담당한다.
import { GameEngine, Room, type GameResult } from '@dopl/core';
import type { GameAction, PlayerView } from '@dopl/protocol';

// 승리 보상
const WIN = { iq: 10, coins: 30 };
const LOSE = { iq: -2, coins: 0 };

// 플레이어별 실시간 상태 (서버는 릴레이만 — 보드 자체는 안 봄)
interface PuyoState {
  topped: boolean; // 천장에 막혀 패배
  garbageReceived: number; // 누적으로 받은 방해뿌요 수 (상대가 보낸 공격의 합). 클라가 delta로 소비.
  score: number; // 최신 점수 (상대 HUD용)
  chain: number; // 최신 연쇄 수 (상대 HUD용)
}

export class PuyoEngine extends GameEngine {
  private seed = 0;
  private states = new Map<string, PuyoState>(); // playerId → state
  private winnerId: string | null = null;
  private log: string[] = [];
  private finalBoard: { name: string; iqDelta: number; coinsDelta: number; won: boolean }[] = [];

  constructor(private room: Room) {
    super();
  }

  // 상대 플레이어 id (1v1 고정)
  private opponentOf(playerId: string): string | undefined {
    return this.room.list().find((p) => p.playerId !== playerId)?.playerId;
  }

  // ── 시작 ───────────────────────────────────────────────────
  async start(requesterId: string): Promise<void> {
    if (!this.room.isHost(requesterId)) throw new Error('호스트만 시작할 수 있습니다.');
    if (this.room.phase !== 'lobby') throw new Error('이미 시작된 게임입니다.');
    const players = this.room.list();
    if (players.length !== 2) throw new Error('뿌요뿌요는 정확히 2명이 필요합니다.');

    // 두 클라가 동일한 뿌요 페어 시퀀스를 생성하도록 공유 시드 배포
    this.seed = (Math.random() * 0xffffffff) >>> 0;
    this.states.clear();
    this.winnerId = null;
    this.log = [];
    for (const p of players) {
      p.iqDelta = 0;
      p.coinsDelta = 0;
      this.states.set(p.playerId, { topped: false, garbageReceived: 0, score: 0, chain: 0 });
    }

    this.room.phase = 'playing';
    this.log.push(`🟢 뿌요뿌요 대결 시작! ${players[0]!.name} vs ${players[1]!.name}`);
    this.log.push('블록을 쌓아 4개 이상 연결해 터뜨리세요. 연쇄가 클수록 상대에게 방해뿌요가 갑니다!');
  }

  // ── 행동(릴레이) ────────────────────────────────────────────
  onAction(playerId: string, action: GameAction): void {
    if (this.room.phase !== 'playing') throw new Error('게임이 진행 중이 아닙니다.');
    const me = this.states.get(playerId);
    if (!me) throw new Error('참가자가 아닙니다.');
    if (me.topped) throw new Error('이미 패배하여 행동할 수 없습니다.');

    switch (action.kind) {
      case 'attack': {
        // 연쇄로 발생한 방해뿌요를 상대 incoming 누적 카운터에 더한다.
        const count = Number(action.count);
        if (!Number.isFinite(count) || count <= 0) throw new Error('잘못된 공격 수치입니다.');
        const oppId = this.opponentOf(playerId);
        const opp = oppId ? this.states.get(oppId) : undefined;
        if (!opp) return;
        opp.garbageReceived += Math.floor(count);
        return;
      }
      case 'progress': {
        // 스펙터클/HUD용 — 최신 점수·연쇄 저장 (상대 화면에 표시)
        const score = Number(action.score);
        const chain = Number(action.chain);
        if (Number.isFinite(score)) me.score = Math.max(0, Math.floor(score));
        if (Number.isFinite(chain)) me.chain = Math.max(0, Math.floor(chain));
        return;
      }
      case 'topout': {
        // 보낸 사람이 천장에 막혀 패배 → 상대 승리, 게임 종료.
        me.topped = true;
        const oppId = this.opponentOf(playerId);
        this.end(oppId ?? null);
        return;
      }
      default:
        throw new Error('알 수 없는 행동입니다.');
    }
  }

  // ── 종료/판정 ───────────────────────────────────────────────
  private end(winnerId: string | null): void {
    this.room.clearTimer();
    this.winnerId = winnerId;
    this.room.phase = 'ended';

    for (const p of this.room.list()) {
      const won = p.playerId === winnerId;
      const r = won ? WIN : LOSE;
      p.iqDelta = r.iq;
      p.coinsDelta = r.coins;
    }
    this.finalBoard = this.room
      .list()
      .map((p) => ({
        name: p.name,
        iqDelta: (p.iqDelta as number) ?? 0,
        coinsDelta: (p.coinsDelta as number) ?? 0,
        won: p.playerId === winnerId,
      }))
      .sort((a, b) => Number(b.won) - Number(a.won));
    const wname = winnerId ? this.room.player(winnerId)?.name : null;
    this.log.push(wname ? `🏆 ${wname}님의 승리!` : '게임 종료');
  }

  // ── 직렬화 ──────────────────────────────────────────────────
  playerView(player: PlayerView, _viewerId: string): Record<string, unknown> {
    const p = player as unknown as { playerId: string };
    const st = this.states.get(p.playerId);
    if (!st) return {};
    // 공개 정보: 생존 여부 + 최신 점수/연쇄 (상대 HUD)
    return { topped: st.topped, score: st.score, chain: st.chain };
  }

  viewFor(viewerId: string): unknown {
    const me = this.states.get(viewerId);
    const oppId = this.opponentOf(viewerId);
    const opp = oppId ? this.states.get(oppId) : undefined;
    const oppPlayer = oppId ? this.room.player(oppId) : undefined;
    const v: Record<string, unknown> = {
      mode: 'puyo',
      log: this.log.slice(-20),
      seed: this.seed,
      // 클라가 diff로 소비하는 누적 방해뿌요 카운터
      myTotalGarbageReceived: me?.garbageReceived ?? 0,
      opponentId: oppId ?? null,
      opponent: opp
        ? { name: oppPlayer?.name ?? '상대', score: opp.score, chain: opp.chain, topped: opp.topped }
        : null,
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
