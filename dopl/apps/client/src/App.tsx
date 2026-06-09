import { useEffect, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { RoomState } from '@dopl/protocol';
import { connectGame } from './socket';
import * as api from './api';
import PhaserLogin from './ui/PhaserLogin';
import PhaserLobby from './ui/PhaserLobby';
import Room from './ui/Room';

export default function App() {
  const [token, setToken] = useState<string | null>(localStorage.getItem('dopl-token'));
  const [profile, setProfile] = useState<any>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [games, setGames] = useState<any[]>([]);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [error, setError] = useState('');

  const logout = () => {
    socket?.close();
    localStorage.removeItem('dopl-token');
    setToken(null);
    setProfile(null);
    setSocket(null);
    setRoom(null);
  };

  useEffect(() => {
    if (!token) return;
    localStorage.setItem('dopl-token', token);
    api.getProfile(token).then(setProfile).catch(logout);
    const s = connectGame(token);
    s.on('games', setGames);
    s.on('state', (st: RoomState) => setRoom(st));
    s.on('errorMsg', (m: string) => {
      setError(m);
      setTimeout(() => setError(''), 3000);
    });
    setSocket(s);
    return () => {
      s.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (!token) return <PhaserLogin onAuth={setToken} />;
  if (!profile || !socket) return <main className="app"><p className="muted">로딩 중…</p></main>;
  if (room) {
    return (
      <Room
        socket={socket}
        room={room}
        games={games}
        error={error}
        onLeave={() => { socket.emit('returnToLobby'); setRoom(null); }}
      />
    );
  }
  return <PhaserLobby socket={socket} games={games} profile={profile} />;
}
