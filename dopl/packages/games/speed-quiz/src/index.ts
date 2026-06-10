// speed-quiz 게임 패키지 — 표준 GamePackage(meta + createEngine) export.
import type { GamePackage } from '@dopl/core';
import { SpeedQuizEngine } from './engine.js';

export const speedQuizPackage: GamePackage = {
  meta: { type: 'speed-quiz', label: '⚡ 스피드퀴즈', minPlayers: 2, maxPlayers: 8, category: 'party' },
  createEngine: (room) => new SpeedQuizEngine(room),
};

export { SpeedQuizEngine, chosungHint } from './engine.js';
export type { TextQuestion } from './engine.js';
