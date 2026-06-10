// Phaser 게임방 호스트 — RoomScene을 풀스크린 마운트. socket/games/onLeave는 1회 주입,
// room/error 갱신은 registry로 주입(게임 재생성 X).
import { useEffect, useRef } from 'react';
import Phaser from 'phaser';
import type { Socket } from 'socket.io-client';
import type { RoomState } from '@dopl/protocol';
import { RoomScene } from '../scenes/RoomScene';

export default function PhaserRoom({
  socket, room, games, error, onLeave,
}: {
  socket: Socket; room: RoomState; games: any[]; error: string; onLeave: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);

  // 게임은 소켓 세션당 한 번만 생성/파괴.
  useEffect(() => {
    if (!ref.current) return;
    // 호스트 씬은 배경색+DOM 오버레이만 그리므로 CANVAS로 충분.
    // 인게임 캔버스(WebGL)와 WebGL 컨텍스트가 겹치지 않게 한다.
    const game = new Phaser.Game({
      type: Phaser.CANVAS,
      parent: ref.current,
      width: ref.current.clientWidth || window.innerWidth,
      height: ref.current.clientHeight || window.innerHeight,
      backgroundColor: '#0b3a5b',
      dom: { createContainer: true },
      scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.NO_CENTER },
      scene: new RoomScene(),
    });
    game.registry.set('socket', socket);
    game.registry.set('games', games);
    game.registry.set('onLeave', onLeave);
    game.registry.set('room', room);
    game.registry.set('roomError', error);
    gameRef.current = game;
    return () => { game.destroy(true); gameRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket]);

  // 서버 state/에러 갱신 → RoomScene이 구독해 re-render.
  useEffect(() => { gameRef.current?.registry.set('room', room); }, [room]);
  useEffect(() => { gameRef.current?.registry.set('roomError', error); }, [error]);

  return <div ref={ref} className="phaser-fullscreen" />;
}
