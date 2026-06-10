// 아바타 PNG 레이어 → Phaser 텍스처 — 게임 씬(마피아/퀴즈)에서 꾸민 캐릭터를 노출하기 위한 헬퍼.
// base+overlay 이미지를 캔버스에 합성해 텍스처로 등록한다. 같은 조합은 같은 키로 캐시.
import Phaser from 'phaser';
import { avatarLayers, normAvatar, type AvatarInfo } from './avatarRender';

const pending = new Set<string>();

export function avatarKey(av: AvatarInfo | null | undefined): string {
  const { g, b, eq } = normAvatar(av);
  return 'ava2:' + JSON.stringify({ g, b, eq });
}

// 텍스처가 준비됐으면 key 반환, 아니면 로드를 시작하고 null 반환(완료 시 onReady 호출).
export function avatarTexture(scene: Phaser.Scene, av: AvatarInfo | null | undefined, onReady: () => void): string | null {
  const key = avatarKey(av);
  if (scene.textures.exists(key)) return key;
  if (pending.has(key)) return null;
  pending.add(key);

  const urls = avatarLayers(av);
  void Promise.all(
    urls.map(
      (u) =>
        new Promise<HTMLImageElement | null>((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => resolve(null); // 없는 레이어는 건너뜀
          img.src = u;
        })
    )
  ).then((imgs) => {
    pending.delete(key);
    const loaded = imgs.filter((i): i is HTMLImageElement => !!i);
    if (!loaded.length) return;
    const baseImg = loaded[0]!;
    const canvas = document.createElement('canvas');
    canvas.width = baseImg.naturalWidth;
    canvas.height = baseImg.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    for (const im of loaded) ctx.drawImage(im, 0, 0, canvas.width, canvas.height);
    if (!scene.textures.exists(key)) {
      try {
        scene.textures.addCanvas(key, canvas);
      } catch {
        return;
      }
    }
    onReady();
  });
  return null;
}
