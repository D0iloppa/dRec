// 아바타 렌더 (v2) — 나노바나나 생성 PNG 레이어 합성: base(벗은 캐릭터) + 아이템 overlay.
// 애셋 경로: /avatar/<m|f>/b<1-3>/{base,<item_code>}.png (tools/assetgen promote가 배포)
// overlay가 준비된 아이템만 시각 반영 — 목록은 OVERLAY_ITEMS에서 관리 (애셋 추가 시 갱신).
export type Equipped = Record<string, string>;
export interface AvatarInfo {
  gender?: string;
  base?: number;
  equipped?: Equipped;
  [k: string]: unknown;
}

export const OVERLAY_ITEMS = new Set(['top_hoodie', 'hair_long', 'top_suit', 'top_stripe', 'acc_crown', 'acc_sunglasses', 'acc_cap']);

// base 캐릭터 이름 (페르소나 원본: tools/assetgen/personas.json — 변경 시 동기화)
export const BASE_NAMES: Record<string, string[]> = {
  m: ['지호', '태오', '강우'],
  f: ['세라', '유나', '민지'],
};
// 합성 순서: 상의 → 헤어(상의 위로 흘러내림) → 소품(최상단)
const SLOT_ORDER = ['top', 'hair', 'acc'];

export function normAvatar(av: AvatarInfo | null | undefined): { g: string; b: number; eq: Equipped } {
  const a = av ?? {};
  const g = a.gender === 'f' ? 'f' : 'm';
  const b = a.base === 2 || a.base === 3 ? a.base : 1;
  return { g, b, eq: (a.equipped ?? {}) as Equipped };
}

export function avatarLayers(av: AvatarInfo | null | undefined): string[] {
  const { g, b, eq } = normAvatar(av);
  const dir = `/avatar/${g}/b${b}`;
  const urls = [`${dir}/base.png`];
  for (const slot of SLOT_ORDER) {
    const code = eq[slot];
    if (code && OVERLAY_ITEMS.has(code)) urls.push(`${dir}/${code}.png`);
  }
  return urls;
}

// DOM용 — 겹쳐진 <img> 스택 (컨테이너 크기에 contain 맞춤)
export function avatarImgHtml(av: AvatarInfo | null | undefined): string {
  return `<span class="ava-stack">${avatarLayers(av)
    .map((u) => `<img src="${u}" alt="" draggable="false">`)
    .join('')}</span>`;
}
