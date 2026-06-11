// puyo(뿌요뿌요) 게임 패키지 — 표준 GamePackage(meta + createEngine) export.
import type { GamePackage } from '@dopl/core';
import { PuyoEngine } from './engine.js';

export const puyoPackage: GamePackage = {
  meta: { type: 'puyo', label: '🟢 뿌요뿌요', minPlayers: 2, maxPlayers: 2, category: 'board' },
  createEngine: (room) => new PuyoEngine(room),
};

export { PuyoEngine } from './engine.js';
