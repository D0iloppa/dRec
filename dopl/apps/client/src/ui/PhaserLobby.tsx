// Phaser 로비 호스트 — LobbyScene을 풀스크린 마운트, socket/games/profile 주입.
import { useEffect, useRef } from 'react';
import Phaser from 'phaser';
import type { Socket } from 'socket.io-client';
import { LobbyScene } from '../scenes/LobbyScene';

export default function PhaserLobby({ socket, games, profile }: { socket: Socket; games: any[]; profile: any }) {
  const ref = useRef<HTMLDivElement>(null);

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
    return () => game.destroy(true);
  }, [socket, games, profile]);

  return <div ref={ref} className="phaser-fullscreen" />;
}
