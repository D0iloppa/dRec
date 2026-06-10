// 아바타 SVG 렌더 (플레이스홀더 paper-doll). equipped 맵(slot→code) → 레이어드 SVG 문자열.
// asset 키(code) 기반이라 추후 nanobanana 스프라이트로 코드 단위 교체 가능.
export type Equipped = Record<string, string>;

// body 슬롯 = 피부톤
const SKIN: Record<string, string> = {
  body_basic: '#f1c27d',
  body_tan: '#c68642',
  body_pale: '#ffe0bd',
  body_mint: '#7dd3c0',
  body_robot: '#aab2c0',
};

// top 슬롯 = 상의 (색/형태)
function topSvg(code: string): string {
  switch (code) {
    case 'top_hoodie':
      return `<path d="M14 130 Q14 96 50 96 Q86 96 86 130 Z" fill="#6d28d9"/>
              <path d="M30 100 Q50 88 70 100 Q60 108 50 108 Q40 108 30 100 Z" fill="#5b21b6"/>`;
    case 'top_suit':
      return `<path d="M14 130 Q14 96 50 96 Q86 96 86 130 Z" fill="#1f2937"/>
              <path d="M44 98 L50 112 L56 98 Z" fill="#fff"/>
              <path d="M48 100 L50 110 L52 100 L50 97 Z" fill="#dc2626"/>`;
    case 'top_stripe':
      return `<path d="M14 130 Q14 96 50 96 Q86 96 86 130 Z" fill="#f59e0b"/>
              <path d="M16 112 Q50 102 84 112 L84 118 Q50 108 16 118 Z" fill="#fff"/>`;
    case 'top_armor':
      return `<path d="M14 130 Q14 96 50 96 Q86 96 86 130 Z" fill="#94a3b8"/>
              <path d="M30 100 L70 100 L66 112 L34 112 Z" fill="#cbd5e1"/>
              <circle cx="50" cy="106" r="4" fill="#fbbf24"/>`;
    default: // top_tee
      return `<path d="M14 130 Q14 96 50 96 Q86 96 86 130 Z" fill="#3b82f6"/>`;
  }
}

// face 슬롯 = 표정 (눈+입)
function faceSvg(code: string): string {
  switch (code) {
    case 'face_cool':
      return `<circle cx="40" cy="56" r="3" fill="#222"/><circle cx="60" cy="56" r="3" fill="#222"/>
              <rect x="38" y="69" width="24" height="3" rx="1.5" fill="#222"/>`;
    case 'face_wink':
      return `<circle cx="40" cy="56" r="3" fill="#222"/>
              <path d="M55 56 Q60 52 65 56" stroke="#222" stroke-width="2.5" fill="none"/>
              <path d="M41 68 Q50 76 59 68" stroke="#222" stroke-width="3" fill="none"/>`;
    case 'face_surprise':
      return `<circle cx="40" cy="56" r="3.5" fill="#222"/><circle cx="60" cy="56" r="3.5" fill="#222"/>
              <ellipse cx="50" cy="71" rx="5" ry="7" fill="#222"/>`;
    case 'face_angry':
      return `<path d="M34 49 L46 53" stroke="#222" stroke-width="2.5"/><path d="M66 49 L54 53" stroke="#222" stroke-width="2.5"/>
              <circle cx="40" cy="58" r="3" fill="#222"/><circle cx="60" cy="58" r="3" fill="#222"/>
              <path d="M41 73 Q50 66 59 73" stroke="#222" stroke-width="3" fill="none"/>`;
    case 'face_cat':
      return `<circle cx="40" cy="56" r="3" fill="#222"/><circle cx="60" cy="56" r="3" fill="#222"/>
              <path d="M44 68 Q47 72 50 68 Q53 72 56 68" stroke="#222" stroke-width="2.5" fill="none"/>
              <g stroke="#222" stroke-width="1.5"><line x1="20" y1="62" x2="34" y2="64"/><line x1="20" y1="68" x2="34" y2="68"/>
              <line x1="80" y1="62" x2="66" y2="64"/><line x1="80" y1="68" x2="66" y2="68"/></g>`;
    default: // face_smile
      return `<circle cx="40" cy="56" r="3" fill="#222"/><circle cx="60" cy="56" r="3" fill="#222"/>
              <path d="M41 69 Q50 77 59 69" stroke="#222" stroke-width="3" fill="none"/>`;
  }
}

// hair 슬롯
function hairSvg(code: string): string {
  switch (code) {
    case 'hair_spiky':
      return `<path d="M20 44 L30 24 L38 42 L50 20 L62 42 L70 24 L80 44 Z" fill="#3b2f2f"/>`;
    case 'hair_long':
      return `<path d="M18 46 Q50 8 82 46 L82 86 Q72 62 70 46 L30 46 Q28 62 18 86 Z" fill="#5b3a1f"/>`;
    case 'hair_curly':
      return `<g fill="#7c2d12"><circle cx="30" cy="40" r="11"/><circle cx="43" cy="32" r="12"/><circle cx="58" cy="32" r="12"/><circle cx="70" cy="40" r="11"/><circle cx="50" cy="28" r="11"/></g>`;
    case 'hair_pony':
      return `<path d="M22 48 Q50 18 78 48 Q70 34 50 34 Q30 34 22 48 Z" fill="#1e3a8a"/>
              <path d="M74 38 Q88 44 84 66 Q80 56 72 50 Z" fill="#1e3a8a"/>
              <circle cx="74" cy="42" r="3.5" fill="#f472b6"/>`;
    case 'hair_bald':
      return '';
    default: // hair_short
      return `<path d="M22 48 Q50 18 78 48 Q70 34 50 34 Q30 34 22 48 Z" fill="#222"/>`;
  }
}

// acc 슬롯 (최상단 오버레이)
function accSvg(code: string): string {
  switch (code) {
    case 'acc_glasses':
      return `<g stroke="#111" stroke-width="2" fill="none"><circle cx="40" cy="56" r="8"/><circle cx="60" cy="56" r="8"/><line x1="48" y1="56" x2="52" y2="56"/></g>`;
    case 'acc_sunglasses':
      return `<g><rect x="32" y="50" width="15" height="11" rx="3" fill="#111"/><rect x="53" y="50" width="15" height="11" rx="3" fill="#111"/><line x1="47" y1="54" x2="53" y2="54" stroke="#111" stroke-width="2"/></g>`;
    case 'acc_crown':
      return `<path d="M30 30 L38 16 L50 28 L62 16 L70 30 Z" fill="#facc15" stroke="#d97706" stroke-width="1.5"/>`;
    case 'acc_cap':
      return `<path d="M24 42 Q50 14 76 42 L76 46 L24 46 Z" fill="#dc2626"/><path d="M68 42 L92 44 Q90 50 74 48 Z" fill="#b91c1c"/>`;
    case 'acc_ribbon':
      return `<g fill="#f472b6"><path d="M62 26 L74 18 L74 34 Z"/><path d="M86 26 L74 18 L74 34 Z"/><circle cx="74" cy="26" r="4" fill="#ec4899"/></g>`;
    case 'acc_headphone':
      return `<path d="M24 52 Q24 24 50 24 Q76 24 76 52" stroke="#374151" stroke-width="5" fill="none"/>
              <rect x="18" y="48" width="10" height="16" rx="4" fill="#374151"/><rect x="72" y="48" width="10" height="16" rx="4" fill="#374151"/>`;
    case 'acc_halo':
      return `<ellipse cx="50" cy="12" rx="20" ry="6" fill="none" stroke="#fbbf24" stroke-width="4"/>`;
    default:
      return '';
  }
}

export function avatarSvg(equipped: Equipped = {}): string {
  const eq = equipped || {};
  const skin = SKIN[eq.body ?? ''] ?? SKIN.body_basic!;
  const parts: string[] = [];

  parts.push(topSvg(eq.top ?? ''));                            // 상의 (머리 뒤)
  parts.push(`<circle cx="50" cy="58" r="30" fill="${skin}"/>`); // 머리
  if (eq.body === 'body_robot') parts.push(`<rect x="44" y="84" width="12" height="8" fill="#7b8494"/>`);
  parts.push(faceSvg(eq.face ?? ''));                          // 표정
  parts.push(hairSvg(eq.hair ?? ''));                          // 헤어
  parts.push(accSvg(eq.acc ?? ''));                            // 액세서리

  return `<svg viewBox="0 0 100 132" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>`;
}
