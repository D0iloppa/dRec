// 아바타 SVG 렌더 (플레이스홀더). equipped 맵 → 레이어드 SVG 문자열.
// 추후 실제 스프라이트로 교체 (asset 키 기반).
export type Equipped = Record<string, string>;

const SKIN = '#f1c27d';

export function avatarSvg(equipped: Equipped = {}): string {
  const eq = equipped || {};
  const parts: string[] = [];

  // 상의(몸통 위) — 머리 뒤
  const topColor = eq.top === 'top_hoodie' ? '#6d28d9' : eq.top === 'top_suit' ? '#1f2937' : '#3b82f6';
  parts.push(`<path d="M14 130 Q14 96 50 96 Q86 96 86 130 Z" fill="${topColor}"/>`);

  // 머리
  parts.push(`<circle cx="50" cy="58" r="30" fill="${SKIN}"/>`);

  // 눈
  parts.push(`<circle cx="40" cy="56" r="3" fill="#222"/><circle cx="60" cy="56" r="3" fill="#222"/>`);
  // 입(face)
  parts.push(
    eq.face === 'face_cool'
      ? `<rect x="38" y="69" width="24" height="3" rx="1.5" fill="#222"/>`
      : `<path d="M41 69 Q50 77 59 69" stroke="#222" stroke-width="3" fill="none"/>`
  );

  // 헤어
  if (eq.hair === 'hair_spiky') parts.push(`<path d="M20 44 L30 24 L38 42 L50 20 L62 42 L70 24 L80 44 Z" fill="#3b2f2f"/>`);
  else if (eq.hair === 'hair_long') parts.push(`<path d="M18 46 Q50 8 82 46 L82 86 Q72 62 70 46 L30 46 Q28 62 18 86 Z" fill="#5b3a1f"/>`);
  else parts.push(`<path d="M22 48 Q50 18 78 48 Q70 34 50 34 Q30 34 22 48 Z" fill="#222"/>`);

  // 액세서리
  if (eq.acc === 'acc_glasses')
    parts.push(`<g stroke="#111" stroke-width="2" fill="none"><circle cx="40" cy="56" r="8"/><circle cx="60" cy="56" r="8"/><line x1="48" y1="56" x2="52" y2="56"/></g>`);
  if (eq.acc === 'acc_crown') parts.push(`<path d="M30 30 L38 16 L50 28 L62 16 L70 30 Z" fill="#facc15" stroke="#d97706" stroke-width="1.5"/>`);

  return `<svg viewBox="0 0 100 132" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>`;
}
