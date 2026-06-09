import { useEffect, useState } from 'react';
import type { Socket } from 'socket.io-client';
import * as api from '../api';

export default function Lobby({
  socket,
  games,
  profile,
  token,
  error,
  onLogout,
  reloadProfile,
}: {
  socket: Socket;
  games: any[];
  profile: any;
  token: string;
  error: string;
  onLogout: () => void;
  reloadProfile: () => void;
}) {
  const [joinCode, setJoinCode] = useState('');
  const [presets, setPresets] = useState<{ colors: string[]; faces: string[] }>({ colors: [], faces: [] });
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    api.getPresets().then(setPresets).catch(() => {});
  }, []);

  const createRoom = (type: string) =>
    socket.emit('createRoom', { type, name: profile.profile.nickname });
  const joinRoom = () => socket.emit('joinRoom', { code: joinCode, name: profile.profile.nickname });

  const setAvatar = async (patch: Record<string, unknown>) => {
    await api.patchProfile(token, { avatar: { ...profile.profile.avatar, ...patch } });
    reloadProfile();
  };

  const { nickname, avatar, iq } = profile.profile;
  return (
    <main className="app">
      <div className="bar">
        <span>
          <span className="ava">{avatar.face}</span> <b>{nickname}</b>
        </span>
        <span>🧠 IQ {iq} · 🪙 {profile.wallet.coins}</span>
      </div>
      {error && <div className="error">{error}</div>}

      <div className="card">
        <h3>아바타 <button className="mini" onClick={() => setEditing(!editing)}>{editing ? '닫기' : '꾸미기'}</button></h3>
        <div className="ava-big" style={{ background: colorHex(avatar.color) }}>{avatar.face}</div>
        {editing && (
          <>
            <div className="picker">{presets.faces.map((f) => <button key={f} onClick={() => setAvatar({ face: f })}>{f}</button>)}</div>
            <div className="picker">{presets.colors.map((c) => (
              <button key={c} className="swatch" style={{ background: colorHex(c) }} onClick={() => setAvatar({ color: c })} />
            ))}</div>
          </>
        )}
      </div>

      <div className="card">
        <h3>게임 선택</h3>
        <div className="gamepick">
          {games.map((g) => (
            <button key={g.type} onClick={() => createRoom(g.type)}>
              {g.label}<small>{g.minPlayers}~{g.maxPlayers}명</small>
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>방 참가</h3>
        <input placeholder="방 코드 (예: AB12)" value={joinCode} maxLength={4} onChange={(e) => setJoinCode(e.target.value.toUpperCase())} />
        <button onClick={joinRoom}>입장</button>
      </div>

      <button className="leave" onClick={onLogout}>로그아웃</button>
    </main>
  );
}

function colorHex(c: string): string {
  const map: Record<string, string> = {
    slate: '#475569', blue: '#2563eb', green: '#16a34a', red: '#dc2626', purple: '#7c3aed', amber: '#d97706',
  };
  return map[c] ?? '#475569';
}
