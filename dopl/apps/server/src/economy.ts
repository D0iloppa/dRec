// 게임 결과 → IQ·XP·coins 적립 (플랫폼 소유. 게임 패키지는 economy를 모름).
// IQ: 상한 1000, 높을수록 얻기 어려운 체감식 — 획득분 × (1000-iq)/900, 최소 +1.
// XP: 참가 10 + 획득 코인만큼. 레벨 = floor(sqrt(xp/50)) + 1 (클라와 동일 공식).
import { pool } from './db.js';
import type { GameResult } from '@dopl/core';

export async function applyResults(results: GameResult[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of results) {
      if (r.userId == null) continue;
      const xpDelta = 10 + Math.max(0, r.coinsDelta);
      await client.query(
        `UPDATE user_profile SET
           iq = LEAST(1000, GREATEST(0, iq + CASE
             WHEN $2::int > 0 THEN GREATEST(1, ROUND($2::int * LEAST(900, 1000 - iq) / 900.0))::int
             ELSE $2::int END)),
           xp = xp + $3,
           updated_at = now()
         WHERE user_id = $1`,
        [r.userId, r.iqDelta, xpDelta]
      );
      await client.query('UPDATE user_wallet SET coins = GREATEST(0, coins + $2), updated_at = now() WHERE user_id = $1', [r.userId, r.coinsDelta]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
