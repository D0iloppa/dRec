// ox-quiz 게임 패키지 — 표준 GamePackage(meta + createEngine) export.
import type { GamePackage } from '@dopl/core';
import { OxQuizEngine } from './engine.js';

export const oxQuizPackage: GamePackage = {
  meta: { type: 'ox-quiz', label: '🧠 OX 퀴즈', minPlayers: 2, maxPlayers: 30, category: 'party' },
  createEngine: (room) => new OxQuizEngine(room),
};

export { OxQuizEngine } from './engine.js';
export type { OxQuestion } from './engine.js';
