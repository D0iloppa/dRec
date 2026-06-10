// 펫 SVG 렌더 (플레이스홀더) — 종(species) × 무드(mood) × 액세서리.
// asset 키 기반이라 추후 nanobanana 스프라이트로 종/아이템 단위 교체 가능.
export type PetMood = 'happy' | 'ok' | 'sad';

function face(mood: PetMood): string {
  if (mood === 'happy')
    return `<circle cx="40" cy="50" r="4" fill="#222"/><circle cx="64" cy="50" r="4" fill="#222"/>
            <path d="M42 64 Q52 74 62 64" stroke="#222" stroke-width="3.5" fill="none"/>`;
  if (mood === 'sad')
    return `<circle cx="40" cy="52" r="4" fill="#222"/><circle cx="64" cy="52" r="4" fill="#222"/>
            <path d="M42 70 Q52 62 62 70" stroke="#222" stroke-width="3.5" fill="none"/>
            <path d="M34 44 Q40 40 46 44" stroke="#222" stroke-width="2" fill="none"/>
            <path d="M58 44 Q64 40 70 44" stroke="#222" stroke-width="2" fill="none"/>`;
  return `<circle cx="40" cy="50" r="4" fill="#222"/><circle cx="64" cy="50" r="4" fill="#222"/>
          <line x1="44" y1="66" x2="60" y2="66" stroke="#222" stroke-width="3.5"/>`;
}

function acc(code: string | null | undefined): string {
  switch (code) {
    case 'pet_acc_ribbon':
      return `<g fill="#f472b6"><path d="M62 16 L74 8 L74 24 Z"/><path d="M86 16 L74 8 L74 24 Z"/><circle cx="74" cy="16" r="4" fill="#ec4899"/></g>`;
    case 'pet_acc_hat':
      return `<path d="M30 22 Q52 0 74 22 L74 28 L30 28 Z" fill="#2563eb"/><rect x="24" y="26" width="56" height="6" rx="3" fill="#1d4ed8"/>`;
    default:
      return '';
  }
}

export function petSvg(species: string, mood: PetMood = 'ok', accessory?: string | null): string {
  let body = '';
  switch (species) {
    case 'pet_dog':
      body = `
        <ellipse cx="52" cy="92" rx="34" ry="22" fill="#d2a05f"/>
        <circle cx="52" cy="52" r="32" fill="#e3b87a"/>
        <path d="M24 34 Q14 16 30 18 Q36 26 32 38 Z" fill="#c08948"/>
        <path d="M80 34 Q90 16 74 18 Q68 26 72 38 Z" fill="#c08948"/>
        <ellipse cx="52" cy="62" rx="10" ry="7" fill="#f6dcb3"/>
        <circle cx="52" cy="58" r="4" fill="#222"/>`;
      break;
    case 'pet_cat':
      body = `
        <ellipse cx="52" cy="92" rx="32" ry="22" fill="#8d8d94"/>
        <circle cx="52" cy="52" r="30" fill="#a8a8b0"/>
        <path d="M28 32 L24 10 L42 22 Z" fill="#8d8d94"/>
        <path d="M76 32 L80 10 L62 22 Z" fill="#8d8d94"/>
        <path d="M48 58 L52 62 L56 58" stroke="#222" stroke-width="2.5" fill="none"/>
        <g stroke="#555" stroke-width="1.5"><line x1="20" y1="56" x2="36" y2="58"/><line x1="84" y1="56" x2="68" y2="58"/></g>`;
      break;
    default: // pet_chick
      body = `
        <ellipse cx="52" cy="90" rx="28" ry="22" fill="#fbd75e"/>
        <circle cx="52" cy="50" r="28" fill="#fde38a"/>
        <path d="M48 58 L52 64 L56 58 Z" fill="#f59e0b"/>
        <path d="M46 14 Q52 6 58 14" stroke="#f59e0b" stroke-width="3" fill="none"/>`;
      break;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 104 120" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
    ${body}${face(mood)}${acc(accessory)}</svg>`;
}

// 펫용품 아이콘 (상점/인벤 카드용)
export function petItemSvg(code: string): string {
  let inner = '';
  switch (code) {
    case 'pet_food_basic':
      inner = `<path d="M16 40 L84 40 L76 78 L24 78 Z" fill="#b45309"/><ellipse cx="50" cy="40" rx="34" ry="10" fill="#92400e"/><ellipse cx="50" cy="38" rx="26" ry="7" fill="#d97706"/>`;
      break;
    case 'pet_food_premium':
      inner = `<path d="M16 40 L84 40 L76 78 L24 78 Z" fill="#7c3aed"/><ellipse cx="50" cy="40" rx="34" ry="10" fill="#5b21b6"/><ellipse cx="50" cy="38" rx="26" ry="7" fill="#a78bfa"/><path d="M44 20 L50 8 L56 20 Z" fill="#facc15"/>`;
      break;
    case 'pet_snack_cookie':
      inner = `<circle cx="50" cy="50" r="30" fill="#d6a35c"/><circle cx="40" cy="44" r="4" fill="#6b3f17"/><circle cx="58" cy="52" r="4" fill="#6b3f17"/><circle cx="48" cy="62" r="4" fill="#6b3f17"/>`;
      break;
    case 'pet_snack_cake':
      inner = `<rect x="22" y="46" width="56" height="28" rx="6" fill="#fbcfe8"/><rect x="22" y="40" width="56" height="12" rx="6" fill="#f9a8d4"/><circle cx="50" cy="34" r="5" fill="#ef4444"/>`;
      break;
    case 'pet_acc_ribbon':
      inner = `<g fill="#f472b6"><path d="M20 50 L46 36 L46 64 Z"/><path d="M80 50 L54 36 L54 64 Z"/><circle cx="50" cy="50" r="8" fill="#ec4899"/></g>`;
      break;
    case 'pet_acc_hat':
      inner = `<path d="M26 52 Q50 18 74 52 Z" fill="#2563eb"/><rect x="18" y="50" width="64" height="10" rx="5" fill="#1d4ed8"/>`;
      break;
    default:
      inner = `<circle cx="50" cy="50" r="28" fill="#cbd5e1"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100%" height="100%">${inner}</svg>`;
}
