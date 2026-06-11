// bang 게임 패키지 — 표준 GamePackage(meta + createEngine) export.
import type { GamePackage } from '@dopl/core';
import { BangEngine } from './engine.js';

export const bangPackage: GamePackage = {
  meta: { type: 'bang', label: '🤠 뱅!', minPlayers: 4, maxPlayers: 7, category: 'board' },
  createEngine: (room) => new BangEngine(room),
};

export { BangEngine } from './engine.js';
export type { Role } from './engine.js';
