// 게임 registry + 게임별 플랫폼 서비스(문제 로더 등).
// 새 게임 추가 = 패키지 import + 이 맵에 한 줄.
import type { GamePackage } from '@dopl/core';
import { oxQuizPackage } from '@dopl/game-ox-quiz';
import { commonQuizPackage } from '@dopl/game-common-quiz';
import { speedQuizPackage } from '@dopl/game-speed-quiz';
import { mafiaPackage } from '@dopl/game-mafia';
import { pool } from './db.js';

export const registry: Record<string, GamePackage> = {
  [oxQuizPackage.meta.type]: oxQuizPackage,
  [commonQuizPackage.meta.type]: commonQuizPackage,
  [speedQuizPackage.meta.type]: speedQuizPackage,
  [mafiaPackage.meta.type]: mafiaPackage,
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

// 스피드퀴즈(주관식) 문제 로더 (quiz_text_question 테이블)
export async function loadTextQuestions(n = 10) {
  const { rows } = await pool.query(
    'SELECT question, answers, category FROM quiz_text_question ORDER BY random() LIMIT $1',
    [n]
  );
  return rows.map((r) => ({ question: r.question, answers: r.answers, category: r.category }));
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
