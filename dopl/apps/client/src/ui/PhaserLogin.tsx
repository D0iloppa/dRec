// Phaser 로그인 호스트 — LoginScene을 풀스크린으로 마운트하고 api/onAuth를 주입.
import { useEffect, useRef } from 'react';
import Phaser from 'phaser';
import { LoginScene } from '../scenes/LoginScene';
import * as api from '../api';

export default function PhaserLogin({ onAuth }: { onAuth: (token: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: ref.current,
      width: ref.current.clientWidth || window.innerWidth,
      height: ref.current.clientHeight || window.innerHeight,
      backgroundColor: '#7ec8ff',
      dom: { createContainer: true },
      scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.NO_CENTER },
      scene: new LoginScene(),
    });
    game.registry.set('api', api);
    game.registry.set('onAuth', onAuth);
    return () => game.destroy(true);
  }, [onAuth]);

  return <div ref={ref} className="phaser-fullscreen" />;
}
