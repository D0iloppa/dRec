// 아바타 프리셋 (MVP: color + face 조합). 향후 파츠/아이템으로 확장.
export const AVATAR_COLORS = ['slate', 'blue', 'green', 'red', 'purple', 'amber'] as const;
export const AVATAR_FACES = ['😀', '😎', '🤖', '🐱', '🦊', '👾'] as const;

export interface Avatar {
  color: string;
  face: string;
}

export const DEFAULT_AVATAR: Avatar = { color: 'slate', face: '😀' };

// 허용된 프리셋 값인지 검증. 통과하면 정규화된 Avatar 반환, 아니면 null.
export function validateAvatar(input: unknown): Avatar | null {
  if (typeof input !== 'object' || input === null) return null;
  const { color, face } = input as Record<string, unknown>;
  if (typeof color !== 'string' || !AVATAR_COLORS.includes(color as (typeof AVATAR_COLORS)[number])) return null;
  if (typeof face !== 'string' || !AVATAR_FACES.includes(face as (typeof AVATAR_FACES)[number])) return null;
  return { color, face };
}
