// 상점/인벤토리 — 아이템 카탈로그, 구매(coins 차감→인벤 추가), 보유 목록.
import express from 'express';
import { pool } from '../db.js';
import { requireAuth, type AuthedRequest } from '../auth/middleware.js';

export const shopRouter = express.Router();

// 아이템 카탈로그
shopRouter.get('/items', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, code, name, slot, asset, price, rarity FROM item WHERE enabled ORDER BY slot, price'
    );
    res.json({ items: rows });
  } catch (e) {
    console.error('[shop/items]', e);
    res.status(500).json({ error: '카탈로그 조회 오류' });
  }
});

// 내 인벤토리 (보유 아이템)
shopRouter.get('/inventory', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT i.id, i.code, i.name, i.slot, i.asset, i.rarity
         FROM user_inventory ui JOIN item i ON i.id = ui.item_id
        WHERE ui.user_id = $1 ORDER BY i.slot`,
      [req.user!.uid]
    );
    res.json({ items: rows });
  } catch (e) {
    console.error('[shop/inventory]', e);
    res.status(500).json({ error: '인벤토리 조회 오류' });
  }
});

// 구매: coins >= price 확인 후 차감 + 인벤 추가 (트랜잭션)
shopRouter.post('/buy', requireAuth, async (req: AuthedRequest, res) => {
  const itemId = Number(req.body?.itemId);
  if (!Number.isInteger(itemId)) {
    res.status(400).json({ error: 'itemId가 필요합니다.' });
    return;
  }
  const uid = req.user!.uid;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: irows } = await client.query('SELECT id, price FROM item WHERE id = $1 AND enabled', [itemId]);
    const item = irows[0];
    if (!item) { await client.query('ROLLBACK'); res.status(404).json({ error: '아이템을 찾을 수 없습니다.' }); return; }

    const { rows: owned } = await client.query('SELECT 1 FROM user_inventory WHERE user_id = $1 AND item_id = $2', [uid, itemId]);
    if (owned[0]) { await client.query('ROLLBACK'); res.status(409).json({ error: '이미 보유한 아이템입니다.' }); return; }

    const { rows: wrows } = await client.query('SELECT coins FROM user_wallet WHERE user_id = $1 FOR UPDATE', [uid]);
    const coins = wrows[0]?.coins ?? 0;
    if (coins < item.price) { await client.query('ROLLBACK'); res.status(402).json({ error: '코인이 부족합니다.' }); return; }

    await client.query('UPDATE user_wallet SET coins = coins - $2, updated_at = now() WHERE user_id = $1', [uid, item.price]);
    await client.query('INSERT INTO user_inventory(user_id, item_id) VALUES($1, $2)', [uid, itemId]);
    await client.query('COMMIT');
    res.json({ ok: true, coins: coins - item.price });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[shop/buy]', e);
    res.status(500).json({ error: '구매 처리 오류' });
  } finally {
    client.release();
  }
});
