// poker(텍사스 홀덤) 게임 패키지 — 표준 GamePackage(meta + createEngine) export.
import type { GamePackage } from '@dopl/core';
import { PokerEngine } from './engine.js';

export const pokerPackage: GamePackage = {
  meta: { type: 'poker', label: '♠️ 포커', minPlayers: 2, maxPlayers: 6, category: 'board' },
  createEngine: (room) => new PokerEngine(room),
};

export { PokerEngine } from './engine.js';
