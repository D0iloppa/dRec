// 친구 — 목록/요청/수락/거절/삭제. 닉네임 기준으로 동작 (클라가 닉네임만 알고 있음).
// 역방향 pending이 있는 상태에서 요청하면 자동 수락(서로 원한 것이므로).
import express from 'express';
import { pool } from '../db.js';
import { requireAuth, type AuthedRequest } from '../auth/middleware.js';
import { isOnline } from '../realtime.js';

export const friendsRouter = express.Router();
friendsRouter.use(requireAuth);

async function uidByNickname(nickname: string): Promise<number | null> {
  const { rows } = await pool.query('SELECT user_id FROM user_profile WHERE nickname = $1 LIMIT 1', [nickname]);
  return rows[0]?.user_id ?? null;
}

const PROFILE_COLS = 'p.nickname, p.iq, p.xp, p.avatar';

// 친구 목록 + 받은/보낸 요청
friendsRouter.get('/', async (req: AuthedRequest, res) => {
  const uid = req.user!.uid;
  try {
    const { rows: friends } = await pool.query(
      `SELECT ${PROFILE_COLS}, p.user_id
         FROM friendship f
         JOIN user_profile p ON p.user_id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
        WHERE (f.requester_id = $1 OR f.addressee_id = $1) AND f.status = 'accepted'
        ORDER BY p.nickname`,
      [uid]
    );
    const { rows: received } = await pool.query(
      `SELECT ${PROFILE_COLS} FROM friendship f JOIN user_profile p ON p.user_id = f.requester_id
        WHERE f.addressee_id = $1 AND f.status = 'pending' ORDER BY f.created_at`,
      [uid]
    );
    const { rows: sent } = await pool.query(
      `SELECT ${PROFILE_COLS} FROM friendship f JOIN user_profile p ON p.user_id = f.addressee_id
        WHERE f.requester_id = $1 AND f.status = 'pending' ORDER BY f.created_at`,
      [uid]
    );
    res.json({
      friends: friends.map((r) => ({ nickname: r.nickname, iq: r.iq, xp: r.xp, avatar: r.avatar, online: isOnline(r.user_id) })),
      received,
      sent,
    });
  } catch (e) {
    console.error('[friends/list]', e);
    res.status(500).json({ error: '친구 목록 조회 오류' });
  }
});

// 친구 요청 (닉네임). 역방향 pending이면 자동 수락.
friendsRouter.post('/request', async (req: AuthedRequest, res) => {
  const uid = req.user!.uid;
  const nickname = String(req.body?.nickname ?? '').trim();
  try {
    const target = await uidByNickname(nickname);
    if (!target) { res.status(404).json({ error: '해당 닉네임의 유저가 없습니다.' }); return; }
    if (target === uid) { res.status(400).json({ error: '자신에게는 요청할 수 없습니다.' }); return; }

    const { rows } = await pool.query(
      `SELECT requester_id, status FROM friendship
        WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)`,
      [uid, target]
    );
    const ex = rows[0];
    if (ex) {
      if (ex.status === 'accepted') { res.status(409).json({ error: '이미 친구입니다.' }); return; }
      if (ex.requester_id === uid) { res.status(409).json({ error: '이미 요청을 보냈습니다.' }); return; }
      // 상대가 먼저 보낸 요청 → 자동 수락
      await pool.query(
        `UPDATE friendship SET status = 'accepted' WHERE requester_id = $1 AND addressee_id = $2`,
        [target, uid]
      );
      res.json({ ok: true, accepted: true });
      return;
    }
    await pool.query('INSERT INTO friendship (requester_id, addressee_id) VALUES ($1, $2)', [uid, target]);
    res.json({ ok: true, accepted: false });
  } catch (e) {
    console.error('[friends/request]', e);
    res.status(500).json({ error: '친구 요청 오류' });
  }
});

// 받은 요청 수락
friendsRouter.post('/accept', async (req: AuthedRequest, res) => {
  const uid = req.user!.uid;
  const nickname = String(req.body?.nickname ?? '').trim();
  try {
    const target = await uidByNickname(nickname);
    if (!target) { res.status(404).json({ error: '유저를 찾을 수 없습니다.' }); return; }
    const { rowCount } = await pool.query(
      `UPDATE friendship SET status = 'accepted'
        WHERE requester_id = $1 AND addressee_id = $2 AND status = 'pending'`,
      [target, uid]
    );
    if (!rowCount) { res.status(404).json({ error: '받은 요청이 없습니다.' }); return; }
    res.json({ ok: true });
  } catch (e) {
    console.error('[friends/accept]', e);
    res.status(500).json({ error: '수락 처리 오류' });
  }
});

// 받은 요청 거절
friendsRouter.post('/decline', async (req: AuthedRequest, res) => {
  const uid = req.user!.uid;
  const nickname = String(req.body?.nickname ?? '').trim();
  try {
    const target = await uidByNickname(nickname);
    if (!target) { res.status(404).json({ error: '유저를 찾을 수 없습니다.' }); return; }
    await pool.query(
      `DELETE FROM friendship WHERE requester_id = $1 AND addressee_id = $2 AND status = 'pending'`,
      [target, uid]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[friends/decline]', e);
    res.status(500).json({ error: '거절 처리 오류' });
  }
});

// 친구 삭제 / 보낸 요청 취소
friendsRouter.delete('/:nickname', async (req: AuthedRequest, res) => {
  const uid = req.user!.uid;
  try {
    const target = await uidByNickname(String(req.params.nickname ?? ''));
    if (!target) { res.status(404).json({ error: '유저를 찾을 수 없습니다.' }); return; }
    await pool.query(
      `DELETE FROM friendship
        WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)`,
      [uid, target]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[friends/delete]', e);
    res.status(500).json({ error: '삭제 처리 오류' });
  }
});
