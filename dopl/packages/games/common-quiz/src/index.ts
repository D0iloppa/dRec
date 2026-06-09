import type { GamePackage } from '@dopl/core';
import { CommonQuizEngine } from './engine.js';

export const commonQuizPackage: GamePackage = {
  meta: { type: 'common-quiz', label: '🧠 상식 퀴즈', minPlayers: 2, maxPlayers: 30, category: 'party' },
  createEngine: (room) => new CommonQuizEngine(room),
};

export { CommonQuizEngine } from './engine.js';
export type { McQuestion } from './engine.js';
