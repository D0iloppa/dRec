// onecard(원카드) 게임 패키지 — 표준 GamePackage(meta + createEngine) export.
import type { GamePackage } from '@dopl/core';
import { OneCardEngine } from './engine.js';

export const onecardPackage: GamePackage = {
  meta: { type: 'onecard', label: '🃏 원카드', minPlayers: 2, maxPlayers: 6, category: 'party' },
  createEngine: (room) => new OneCardEngine(room),
};

export { OneCardEngine } from './engine.js';
export type { Suit, Rank, Card } from './engine.js';
