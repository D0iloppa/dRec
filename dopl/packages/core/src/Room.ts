// 게임 공통 방 — 게임 종류와 무관한 인프라(플레이어/재접속/채팅/타이머/직렬화).
// 게임별 규칙은 this.game(GameEngine)이 담당. 플랫폼 서비스는 context로 주입.
import type { ChatMessage } from '@dopl/protocol';
import type { GameEngine } from './engine.js';

export interface RoomPlayer {
  playerId: string;
  userId: number | null; // 인증 유저 id
  name: string;
  socketId: string;
  connected: boolean;
  [key: string]: unknown; // 게임별 필드(alive, role, iq 등)
}

export class Room {
  code: string;
  type: string;
  title = '';
  players = new Map<string, RoomPlayer>();
  hostId: string | null = null;
  chat: ChatMessage[] = [];
  phase = 'lobby';
  timerEndsAt: number | null = null;
  onChange: () => void = () => {};
  // 서버가 주입하는 플랫폼 서비스(예: 문제 로더). 게임 패키지는 server db를 직접 모름.
  context: Record<string, unknown> = {};
  game!: GameEngine;

  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(code: string, type: string) {
    this.code = code;
    this.type = type;
  }

  player(id: string): RoomPlayer | undefined {
    return this.players.get(id);
  }
  list(): RoomPlayer[] {
    return [...this.players.values()];
  }
  connected(): RoomPlayer[] {
    return this.list().filter((p) => p.connected);
  }
  isHost(playerId: string): boolean {
    return this.hostId === playerId;
  }

  addPlayer(playerId: string, name: string, socketId: string, userId: number | null): boolean {
    const existing = this.players.get(playerId);
    if (existing) {
      existing.socketId = socketId;
      existing.connected = true;
      if (name) existing.name = name;
      return true;
    }
    if (this.phase !== 'lobby') return false;
    this.players.set(playerId, { playerId, userId, name: name || '익명', socketId, connected: true });
    if (!this.hostId) this.hostId = playerId;
    return true;
  }

  rejoin(playerId: string, socketId: string): boolean {
    const p = this.players.get(playerId);
    if (!p) return false;
    p.socketId = socketId;
    p.connected = true;
    return true;
  }

  disconnectSocket(socketId: string): RoomPlayer | null {
    for (const p of this.players.values()) {
      if (p.socketId !== socketId) continue;
      p.connected = false;
      if (this.phase === 'lobby') this.players.delete(p.playerId);
      if (this.hostId === p.playerId) {
        const next = this.connected()[0];
        this.hostId = next ? next.playerId : this.hostId;
      }
      return p;
    }
    return null;
  }

  addChat(playerId: string, text: string): void {
    const p = this.players.get(playerId);
    if (!p || !text) return;
    this.chat.push({ name: p.name, text: String(text).slice(0, 300), ts: Date.now() });
    if (this.chat.length > 100) this.chat.shift();
  }

  startTimer(seconds: number, cb: () => void): void {
    this.clearTimer();
    this.timerEndsAt = Date.now() + seconds * 1000;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerEndsAt = null;
      try {
        cb();
      } catch (e) {
        console.error('[room timer]', e);
      }
      this.onChange();
    }, seconds * 1000);
  }
  clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerEndsAt = null;
  }

  serialize(viewerId: string) {
    const players = this.list().map((p) => ({
      id: p.playerId,
      name: p.name,
      connected: p.connected,
      isHost: p.playerId === this.hostId,
      ...this.game.playerView(p as never, viewerId),
    }));
    return {
      code: this.code,
      type: this.type,
      phase: this.phase,
      hostId: this.hostId,
      myId: viewerId,
      timerEndsAt: this.timerEndsAt,
      players,
      chat: this.chat.slice(-50),
      game: this.game.viewFor(viewerId),
    };
  }
}
