// mafia 게임 패키지 — 표준 GamePackage(meta + createEngine) export.
import type { GamePackage } from '@dopl/core';
import { MafiaEngine } from './engine.js';

export const mafiaPackage: GamePackage = {
  meta: { type: 'mafia', label: '🔪 마피아', minPlayers: 4, maxPlayers: 10, category: 'party' },
  createEngine: (room) => new MafiaEngine(room),
};

export { MafiaEngine } from './engine.js';
export type { Role } from './engine.js';
