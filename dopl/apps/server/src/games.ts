// 게임 registry + 게임별 플랫폼 서비스(문제 로더 등).
// 새 게임 추가 = 패키지 import + 이 맵에 한 줄.
import type { GamePackage } from '@dopl/core';
import { oxQuizPackage } from '@dopl/game-ox-quiz';
import { commonQuizPackage } from '@dopl/game-common-quiz';
import { pool } from './db.js';

export const registry: Record<string, GamePackage> = {
  [oxQuizPackage.meta.type]: oxQuizPackage,
  [commonQuizPackage.meta.type]: commonQuizPackage,
};

export const gameList = Object.values(registry).map((g) => g.meta);

// OX 문제 로더 (quiz_question 테이블)
export async function loadOxQuestions(n = 10) {
  const { rows } = await pool.query(
    'SELECT question, answer, category FROM quiz_question ORDER BY random() LIMIT $1',
    [n]
  );
  return rows.map((r) => ({ question: r.question, answer: r.answer, category: r.category }));
}

// 상식퀴즈 문제 로더 (quiz_mc_question 테이블)
export async function loadMcQuestions(n = 10) {
  const { rows } = await pool.query(
    'SELECT question, options, answer_index, category FROM quiz_mc_question ORDER BY random() LIMIT $1',
    [n]
  );
  return rows.map((r) => ({
    question: r.question,
    options: r.options,
    answerIndex: r.answer_index,
    category: r.category,
  }));
}
