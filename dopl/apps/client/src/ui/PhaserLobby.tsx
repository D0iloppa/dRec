// Phaser 로비 호스트 — LobbyScene을 풀스크린 마운트, socket/games/profile 주입.
import { useEffect, useRef } from 'react';
import Phaser from 'phaser';
import type { Socket } from 'socket.io-client';
import { LobbyScene } from '../scenes/LobbyScene';

export default function PhaserLobby({
  socket, games, profile, token, onLogout, refreshProfile,
}: {
  socket: Socket; games: any[]; profile: any; token: string; onLogout: () => void; refreshProfile: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);

  // 게임은 소켓 세션당 한 번만 생성/파괴. games/profile 변화로 재생성하지 않는다.
  useEffect(() => {
    if (!ref.current) return;
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: ref.current,
      width: ref.current.clientWidth || window.innerWidth,
      height: ref.current.clientHeight || window.innerHeight,
      backgroundColor: '#0b3a5b',
      dom: { createContainer: true },
      scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.NO_CENTER },
      scene: new LobbyScene(),
    });
    game.registry.set('socket', socket);
    game.registry.set('games', games);
    game.registry.set('profile', profile);
    game.registry.set('token', token);
    game.registry.set('onLogout', onLogout);
    game.registry.set('refreshProfile', refreshProfile);
    gameRef.current = game;
    return () => { game.destroy(true); gameRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket]);

  // games/profile 갱신은 실행 중인 게임 registry에 주입 → LobbyScene이 구독해 re-render.
  useEffect(() => {
    gameRef.current?.registry.set('games', games);
    gameRef.current?.registry.set('profile', profile);
  }, [games, profile]);

  return <div ref={ref} className="phaser-fullscreen" />;
}
