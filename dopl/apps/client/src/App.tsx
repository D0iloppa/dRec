import { useEffect, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { RoomState } from '@dopl/protocol';
import { connectGame } from './socket';
import * as api from './api';
import { loadBgmMeta } from './bgm';

// BGM 트랙 메타(DB) 1회 로드 — 씬들이 key로 참조
void loadBgmMeta();
import PhaserLogin from './ui/PhaserLogin';
import PhaserLobby from './ui/PhaserLobby';
import PhaserRoom from './ui/PhaserRoom';

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

  // BGM은 각 씬(LoginScene/LobbyScene/ShopScene/DressScene/RoomScene)이 화면별 트랙으로 제어

  // 게임 종료 시 적립된 IQ/코인이 로비에 반영되도록 프로필 재조회
  useEffect(() => {
    if (room?.phase === 'ended' && token) api.getProfile(token).then(setProfile).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.phase]);

  if (!token) return <PhaserLogin onAuth={setToken} />;
  if (!profile || !socket) return <main className="app"><p className="muted">로딩 중…</p></main>;
  if (room) {
    return (
      <PhaserRoom
        socket={socket}
        room={room}
        games={games}
        error={error}
        token={token}
        onLeave={() => { socket.emit('returnToLobby'); setRoom(null); }}
      />
    );
  }
  return (
    <PhaserLobby
      socket={socket}
      games={games}
      profile={profile}
      token={token}
      onLogout={logout}
      refreshProfile={() => api.getProfile(token).then(setProfile).catch(() => {})}
    />
  );
}
