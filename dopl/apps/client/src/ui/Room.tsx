import { useEffect, useState, type FormEvent } from 'react';
import type { Socket } from 'socket.io-client';
import type { RoomState } from '@dopl/protocol';
import GameStage from './GameStage';

const PHASE_LABEL: Record<string, string> = {
  lobby: '대기실', playing: '진행 중', ended: '종료',
};

export default function Room({
  socket, room, games, error, onLeave,
}: {
  socket: Socket; room: RoomState; games: any[]; error: string; onLeave: () => void;
}) {
  const meta = games.find((g) => g.type === room.type);
  const isHost = room.hostId === room.myId;

  return (
    <main className="app">
      <div className="bar">
        <span>{meta?.label ?? room.type} · <b>{room.code}</b></span>
        <span>{PHASE_LABEL[room.phase] ?? room.phase} <Timer endsAt={room.timerEndsAt} /></span>
      </div>
      {error && <div className="error">{error}</div>}

      {room.phase === 'lobby' && (
        <div className="card">
          <h3>참가자 ({room.players.length})</h3>
          <ul className="players">
            {room.players.map((p) => (
              <li key={p.id} className={p.connected ? '' : 'off'}>{p.name} {p.isHost && '👑'}</li>
            ))}
          </ul>
          {isHost ? (
            <button onClick={() => socket.emit('start')}>게임 시작 ({meta?.minPlayers}명 이상)</button>
          ) : (
            <p className="muted">호스트가 시작하기를 기다리는 중…</p>
          )}
        </div>
      )}

      {room.phase !== 'lobby' && <GameStage socket={socket} room={room} />}

      {room.phase !== 'lobby' && (
        <div className="card">
          <h3>참가자</h3>
          <ul className="players">
            {room.players.map((p: any) => (
              <li key={p.id} className={p.connected ? '' : 'off'}>
                {p.name} {p.isHost && '👑'}{p.alive === false && ' 💀'}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Chat socket={socket} chat={room.chat} />
      <button className="leave" onClick={onLeave}>나가기</button>
    </main>
  );
}

function Timer({ endsAt }: { endsAt: number | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!endsAt) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [endsAt]);
  if (!endsAt) return null;
  return <span className="timer">⏳ {Math.max(0, Math.ceil((endsAt - now) / 1000))}s</span>;
}

function Chat({ socket, chat }: { socket: Socket; chat: { name: string; text: string }[] }) {
  const [text, setText] = useState('');
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    socket.emit('chat', { text });
    setText('');
  };
  return (
    <div className="card chat">
      <h3>채팅</h3>
      <div className="chatlog">
        {chat.map((c, i) => <div key={i} className="chatline"><b>{c.name}</b> {c.text}</div>)}
      </div>
      <form className="chatform" onSubmit={send}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="메시지…" />
        <button type="submit">전송</button>
      </form>
    </div>
  );
}
