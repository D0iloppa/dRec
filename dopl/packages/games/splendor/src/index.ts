// splendor 게임 패키지 — 표준 GamePackage(meta + createEngine) export.
import type { GamePackage } from '@dopl/core';
import { SplendorEngine } from './engine.js';

export const splendorPackage: GamePackage = {
  meta: { type: 'splendor', label: '💎 스플랜더', minPlayers: 2, maxPlayers: 4, category: 'board' },
  createEngine: (room) => new SplendorEngine(room),
};

export { SplendorEngine } from './engine.js';
export type { Color } from './engine.js';
