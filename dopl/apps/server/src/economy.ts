// 게임 결과 → IQ·coins 적립 (플랫폼 소유. 게임 패키지는 economy를 모름).
import { pool } from './db.js';
import type { GameResult } from '@dopl/core';

export async function applyResults(results: GameResult[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of results) {
      if (r.userId == null) continue;
      await client.query('UPDATE user_profile SET iq = GREATEST(0, iq + $2), updated_at = now() WHERE user_id = $1', [r.userId, r.iqDelta]);
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
