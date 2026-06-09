// React ↔ Phaser 브리지. 타입에 맞는 씬을 마운트하고 서버 state를 주입,
// 씬의 입력을 socket action으로 전달. (게임 추가 = SCENES에 한 줄)
import { useEffect, useRef } from 'react';
import Phaser from 'phaser';
import type { Socket } from 'socket.io-client';
import type { RoomState } from '@dopl/protocol';
import { OxScene } from '../games/ox/OxScene';
import { CommonQuizScene } from '../games/common-quiz/CommonQuizScene';

interface DoplScene extends Phaser.Scene {
  sendAction: (a: unknown) => void;
  pushState: (s: RoomState) => void;
}
const SCENES: Record<string, new () => DoplScene> = {
  'ox-quiz': OxScene as unknown as new () => DoplScene,
  'common-quiz': CommonQuizScene as unknown as new () => DoplScene,
};

export const PHASER_TYPES = Object.keys(SCENES);

export default function PhaserStage({ socket, room }: { socket: Socket; room: RoomState }) {
  const ref = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const sceneRef = useRef<DoplScene | null>(null);

  useEffect(() => {
    const SceneClass = SCENES[room.type];
    if (!ref.current || !SceneClass) return;
    const scene = new SceneClass();
    scene.sendAction = (a: unknown) => socket.emit('action', a);
    sceneRef.current = scene;
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: ref.current,
      width: 560,
      height: 420,
      backgroundColor: '#0f172a',
      scene,
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_HORIZONTALLY },
    });
    gameRef.current = game;
    return () => {
      game.destroy(true);
      gameRef.current = null;
      sceneRef.current = null;
    };
  }, [room.type, socket]);

  useEffect(() => {
    sceneRef.current?.pushState(room);
  }, [room]);

  return <div className="phaser-wrap" ref={ref} />;
}
