// Socket.IO 실시간 — /games 네임스페이스. JWT 소켓 인증 + 방 관리 + 종료 시 적립.
import { Server, type Socket } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import { Room } from '@dopl/core';
import { verifyToken, type JwtPayload } from './auth/jwt.js';
import { registry, gameList, loadOxQuestions, loadMcQuestions, loadTextQuestions } from './games.js';
import { applyResults } from './economy.js';
import { pool } from './db.js';

async function loadProfile(userId: number) {
  const { rows } = await pool.query(
    `SELECT p.nickname, p.iq, p.xp, p.avatar, w.coins
       FROM user_profile p JOIN user_wallet w ON w.user_id = p.user_id
      WHERE p.user_id = $1`,
    [userId]
  );
  return rows[0] ?? null;
}

const rooms = new Map<string, Room>();

function genCode(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

export function setupRealtime(http: HttpServer): Server {
  const io = new Server(http, { path: '/socket.io', cors: { origin: true } });
  const nsp = io.of('/games');

  // 방에 들어가지 않고 로비에 있는 소켓들
  const lobby = new Set<Socket>();
  // 로비 전체 채팅 (최근 100개 보관, payload엔 50개)
  const lobbyChat: { name: string; text: string; ts: number }[] = [];

  // JWT 소켓 인증 (handshake.auth.token)
  nsp.use((socket, next) => {
    try {
      socket.data.user = verifyToken(String(socket.handshake.auth?.token ?? ''));
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  // 방 요약 목록 — 대기중/게임중 모두 노출 (큐플레이식 목록)
  function roomSummaries() {
    const out: unknown[] = [];
    for (const r of rooms.values()) {
      const meta = registry[r.type]?.meta;
      out.push({
        code: r.code,
        type: r.type,
        label: meta?.label,
        title: r.title || '',
        host: (r.hostId && r.player(r.hostId)?.name) || '',
        count: r.connected().length,
        max: meta?.maxPlayers ?? 0,
        status: r.phase === 'lobby' ? 'waiting' : 'playing',
      });
    }
    return out;
  }

  function lobbyPayload() {
    const users = [...lobby].map((s) => {
      const p = s.data.profile ?? {};
      return { nickname: p.nickname ?? p.username, iq: p.iq ?? null, xp: p.xp ?? 0, avatar: p.avatar ?? null };
    });
    return { rooms: roomSummaries(), users, chat: lobbyChat.slice(-50) };
  }
  // 로비 상태를 로비 소켓들에 broadcast
  function broadcastLobby() {
    const payload = lobbyPayload();
    for (const s of lobby) s.emit('lobby', payload);
  }

  function broadcast(room: Room): void {
    for (const p of room.list()) {
      if (p.connected && p.socketId) nsp.to(p.socketId).emit('state', room.serialize(p.playerId));
    }
  }
  async function update(room: Room): Promise<void> {
    const r = room as Room & { _paid?: boolean };
    if (room.phase === 'ended' && !r._paid) {
      r._paid = true;
      try {
        await applyResults(room.game.results());
      } catch (e) {
        console.error('[payout]', e);
      }
    }
    broadcast(room);
    broadcastLobby(); // 방 목록/상태 변화 반영
  }

  nsp.on('connection', (socket) => {
    const user = socket.data.user as JwtPayload;
    const pid = `u${user.uid}`;
    let room: Room | null = null;
    socket.emit('games', gameList);

    // 프로필 로드 후 로비 입장
    loadProfile(user.uid)
      .then((p) => { socket.data.profile = { ...(p ?? {}), username: user.username }; })
      .catch(() => { socket.data.profile = { username: user.username }; })
      .finally(() => { lobby.add(socket); broadcastLobby(); });

    const enterRoom = () => { lobby.delete(socket); };

    // 씬 마운트 시 현재 로비 상태 요청
    socket.on('lobbyRefresh', () => { socket.emit('lobby', lobbyPayload()); });

    // 로비 전체 채팅
    socket.on('lobbyChat', (payload) => {
      const text = String(payload?.text ?? '').trim().slice(0, 300);
      if (!text || !lobby.has(socket)) return;
      const p = socket.data.profile ?? {};
      lobbyChat.push({ name: p.nickname ?? p.username ?? '익명', text, ts: Date.now() });
      if (lobbyChat.length > 100) lobbyChat.shift();
      broadcastLobby();
    });

    // 아바타/프로필 변경 후 재조회 → 로비 목록에 반영
    socket.on('profileRefresh', async () => {
      const p = await loadProfile(user.uid).catch(() => null);
      socket.data.profile = { ...(p ?? {}), username: user.username };
      broadcastLobby();
    });

    const makeRoom = (type: string, title?: string): Room | null => {
      const pkg = registry[type];
      if (!pkg) return null;
      let code: string;
      do {
        code = genCode();
      } while (rooms.has(code));
      const r = new Room(code, type);
      r.title = (typeof title === 'string' && title.trim() ? title.trim().slice(0, 30) : '') || `${user.username}의 방`;
      r.onChange = () => void update(r);
      r.context.loadOxQuestions = () => loadOxQuestions(10);
      r.context.loadMcQuestions = () => loadMcQuestions(10);
      r.context.loadTextQuestions = () => loadTextQuestions(10);
      r.game = pkg.createEngine(r);
      rooms.set(code, r);
      return r;
    };

    const myAvatar = () => socket.data.profile?.avatar ?? null;

    socket.on('createRoom', (payload, cb) => {
      const r = makeRoom(payload?.type, payload?.title);
      if (!r) return cb?.({ ok: false, error: '알 수 없는 게임 타입' });
      r.addPlayer(pid, payload?.name || user.username, socket.id, user.uid, myAvatar());
      room = r;
      enterRoom();
      cb?.({ ok: true, code: r.code });
      void update(r);
    });

    socket.on('joinRoom', (payload, cb) => {
      const r = rooms.get(String(payload?.code ?? '').toUpperCase());
      if (!r) return cb?.({ ok: false, error: '방을 찾을 수 없습니다.' });
      const max = registry[r.type]?.meta.maxPlayers;
      if (max && !r.player(pid) && r.list().length >= max)
        return cb?.({ ok: false, error: '정원이 가득 찼습니다.' });
      if (!r.addPlayer(pid, payload?.name || user.username, socket.id, user.uid, myAvatar()))
        return cb?.({ ok: false, error: '이미 시작된 게임입니다.' });
      room = r;
      enterRoom();
      cb?.({ ok: true, code: r.code });
      void update(r);
    });

    socket.on('rejoin', (payload, cb) => {
      const r = rooms.get(String(payload?.code ?? '').toUpperCase());
      if (!r || !r.rejoin(pid, socket.id)) return cb?.({ ok: false });
      room = r;
      enterRoom();
      cb?.({ ok: true, code: r.code });
      void update(r);
    });

    // 방에서 로비로 복귀
    socket.on('returnToLobby', () => {
      if (room) {
        room.disconnectSocket(socket.id);
        if (room.connected().length === 0 && room.phase === 'lobby') rooms.delete(room.code);
        else void update(room);
        room = null;
      }
      lobby.add(socket);
      broadcastLobby();
    });

    // 종료된 게임을 대기실로 되돌려 재경기 (호스트 전용). 엔진 재생성 + 적립 플래그 리셋.
    socket.on('restart', () => {
      if (!room || room.phase !== 'ended' || !room.isHost(pid)) return;
      for (const p of room.list()) if (!p.connected) room.players.delete(p.playerId);
      room.clearTimer();
      room.phase = 'lobby';
      (room as Room & { _paid?: boolean })._paid = false;
      room.game = registry[room.type]!.createEngine(room);
      void update(room);
    });

    socket.on('start', async () => {
      if (!room) return;
      try {
        await room.game.start(pid);
        void update(room);
      } catch (e) {
        socket.emit('errorMsg', (e as Error).message);
      }
    });

    socket.on('action', async (action) => {
      if (!room || !action) return;
      try {
        await room.game.onAction(pid, action);
        void update(room);
      } catch (e) {
        socket.emit('errorMsg', (e as Error).message);
      }
    });

    socket.on('chat', (payload) => {
      if (!room) return;
      const text = String(payload?.text ?? '');
      // 진행 중이고 엔진이 채팅 훅을 구현하면 게임 입력으로 위임(스피드퀴즈 답안 등)
      if (room.phase === 'playing' && room.game.onChat) room.game.onChat(pid, text);
      else room.addChat(pid, text);
      void update(room);
    });

    socket.on('disconnect', () => {
      lobby.delete(socket);
      if (room) {
        room.disconnectSocket(socket.id);
        if (room.connected().length === 0 && room.phase === 'lobby') rooms.delete(room.code);
        else void update(room);
      }
      broadcastLobby();
    });
  });

  return io;
}
