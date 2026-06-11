// liar(라이어게임) 패키지 — 표준 GamePackage(meta + createEngine) export.
import type { GamePackage } from '@dopl/core';
import { LiarEngine } from './engine.js';

export const liarPackage: GamePackage = {
  meta: { type: 'liar', label: '🤥 라이어게임', minPlayers: 3, maxPlayers: 8, category: 'party' },
  createEngine: (room) => new LiarEngine(room),
};

export { LiarEngine } from './engine.js';
