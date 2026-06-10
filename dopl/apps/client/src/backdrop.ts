// 공용 카툰 배경 — 밝은 하늘 + 떠다니는 구름 (로그인 톤과 통일). 로비/게임방 씬에서 사용.
import Phaser from 'phaser';

export function addCartoonBackdrop(scene: Phaser.Scene): void {
  const W = scene.scale.width;
  const H = scene.scale.height;
  scene.cameras.main.setBackgroundColor('#6cc0ff');
  // 하단으로 갈수록 밝아지는 느낌의 띠
  scene.add.rectangle(W / 2, H * 0.7, W * 2, H * 0.4, 0xa9e0ff, 0.45);
  scene.add.rectangle(W / 2, H * 0.95, W * 2, H * 0.3, 0xe6f7ff, 0.5);

  const specs: [number, number, number][] = [
    [0.1, 0.14, 56], [0.5, 0.07, 38], [0.86, 0.2, 48], [0.18, 0.8, 40], [0.88, 0.76, 52],
  ];
  for (const [fx, fy, r] of specs) {
    const c = scene.add.container(W * fx, H * fy);
    c.add([
      scene.add.ellipse(0, 0, r * 2.4, r, 0xffffff, 0.92),
      scene.add.ellipse(-r * 0.7, -r * 0.3, r * 1.2, r * 1.1, 0xffffff, 0.92),
      scene.add.ellipse(r * 0.7, -r * 0.2, r, r * 0.9, 0xffffff, 0.92),
    ]);
    scene.tweens.add({ targets: c, x: c.x + 26, yoyo: true, repeat: -1, duration: 6000 + r * 60, ease: 'Sine.easeInOut' });
  }
}
