// 레벨 공식 (서버 economy.ts 주석과 동일): LV = floor(sqrt(xp/50)) + 1
export function levelOf(xp: number | null | undefined): number {
  return Math.floor(Math.sqrt(Math.max(0, xp ?? 0) / 50)) + 1;
}
