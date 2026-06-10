// 프로필/아바타/지갑 라우트 (인증 필요).
import express from 'express';
import { pool } from '../db.js';
import { requireAuth, type AuthedRequest } from '../auth/middleware.js';
import { AVATAR_COLORS, AVATAR_FACES, validateAvatar } from './avatar.js';

export const profileRouter = express.Router();

// 아바타 선택지 (클라이언트 꾸미기 UI용)
profileRouter.get('/presets', (_req, res) => {
  res.json({ colors: AVATAR_COLORS, faces: AVATAR_FACES });
});

// 내 프로필 + 지갑
profileRouter.get('/me', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.username, p.nickname, p.avatar, p.iq, p.xp, w.coins
         FROM users u
         JOIN user_profile p ON p.user_id = u.id
         JOIN user_wallet  w ON w.user_id = u.id
        WHERE u.id = $1`,
      [req.user!.uid]
    );
    const r = rows[0];
    if (!r) {
      res.status(404).json({ error: '프로필을 찾을 수 없습니다.' });
      return;
    }
    res.json({
      user: { id: r.id, username: r.username },
      profile: { nickname: r.nickname, avatar: r.avatar, iq: r.iq, xp: r.xp },
      wallet: { coins: r.coins },
    });
  } catch (e) {
    console.error('[profile/me]', e);
    res.status(500).json({ error: '프로필 조회 중 오류' });
  }
});

// 공개 프로필 조회 (다른 유저 정보 카드용 — 닉네임 기준, 민감 정보 제외)
profileRouter.get('/of/:nickname', requireAuth, async (req, res) => {
  const nickname = String(req.params.nickname ?? '').slice(0, 20);
  try {
    const { rows } = await pool.query(
      `SELECT p.nickname, p.iq, p.xp, p.avatar, u.created_at
         FROM user_profile p JOIN users u ON u.id = p.user_id
        WHERE p.nickname = $1 LIMIT 1`,
      [nickname]
    );
    if (!rows[0]) {
      res.status(404).json({ error: '유저를 찾을 수 없습니다.' });
      return;
    }
    res.json({ profile: rows[0] });
  } catch (e) {
    console.error('[profile/of]', e);
    res.status(500).json({ error: '프로필 조회 오류' });
  }
});

// 닉네임/아바타 수정
profileRouter.patch('/me', requireAuth, async (req: AuthedRequest, res) => {
  const { nickname, avatar } = req.body ?? {};
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;

  if (nickname !== undefined) {
    if (typeof nickname !== 'string' || nickname.length < 1 || nickname.length > 20) {
      res.status(400).json({ error: '닉네임은 1~20자여야 합니다.' });
      return;
    }
    sets.push(`nickname = $${i++}`);
    vals.push(nickname);
  }
  if (avatar !== undefined) {
    const v = validateAvatar(avatar);
    if (!v) {
      res.status(400).json({ error: '아바타 값이 올바르지 않습니다.' });
      return;
    }
    sets.push(`avatar = $${i++}`);
    vals.push(JSON.stringify(v));
  }
  if (sets.length === 0) {
    res.status(400).json({ error: '변경할 내용이 없습니다.' });
    return;
  }
  vals.push(req.user!.uid);
  try {
    await pool.query(`UPDATE user_profile SET ${sets.join(', ')}, updated_at = now() WHERE user_id = $${i}`, vals);
    res.json({ ok: true });
  } catch (e) {
    console.error('[profile/patch]', e);
    res.status(500).json({ error: '프로필 수정 중 오류' });
  }
});

// 아바타 장착: { equipped: { slot: code }, base?: 1~3 }. 무료(price 0) 또는 보유 아이템만 허용.
profileRouter.put('/equip', requireAuth, async (req: AuthedRequest, res) => {
  const equipped = req.body?.equipped;
  if (typeof equipped !== 'object' || equipped === null) {
    res.status(400).json({ error: 'equipped 맵이 필요합니다.' });
    return;
  }
  const baseRaw = req.body?.base;
  const baseN = baseRaw === undefined || baseRaw === null ? null : Number(baseRaw);
  if (baseN !== null && (!Number.isInteger(baseN) || baseN < 1 || baseN > 3)) {
    res.status(400).json({ error: 'base는 1~3이어야 합니다.' });
    return;
  }
  const entries = Object.entries(equipped).filter(([, v]) => typeof v === 'string') as [string, string][];
  const codes = entries.map(([, code]) => code);
  try {
    const { rows } = await pool.query(
      `SELECT i.code, i.slot, i.price, (ui.user_id IS NOT NULL) AS owned
         FROM item i LEFT JOIN user_inventory ui ON ui.item_id = i.id AND ui.user_id = $1
        WHERE i.code = ANY($2) AND i.enabled`,
      [req.user!.uid, codes]
    );
    const byCode = new Map(rows.map((r) => [r.code, r]));
    const valid: Record<string, string> = {};
    for (const [slot, code] of entries) {
      const it = byCode.get(code);
      if (!it) { res.status(400).json({ error: `알 수 없는 아이템: ${code}` }); return; }
      if (it.slot !== slot) { res.status(400).json({ error: `슬롯 불일치: ${code}` }); return; }
      if (it.price > 0 && !it.owned) { res.status(403).json({ error: `미보유 아이템: ${code}` }); return; }
      valid[slot] = code;
    }
    if (baseN !== null) {
      await pool.query(
        `UPDATE user_profile SET avatar = jsonb_set(
           jsonb_set(coalesce(avatar, '{}'::jsonb), '{equipped}', $2::jsonb),
           '{base}', to_jsonb($3::int)), updated_at = now() WHERE user_id = $1`,
        [req.user!.uid, JSON.stringify(valid), baseN]
      );
    } else {
      await pool.query(
        `UPDATE user_profile SET avatar = jsonb_set(coalesce(avatar, '{}'::jsonb), '{equipped}', $2::jsonb), updated_at = now() WHERE user_id = $1`,
        [req.user!.uid, JSON.stringify(valid)]
      );
    }
    res.json({ ok: true, equipped: valid, base: baseN ?? undefined });
  } catch (e) {
    console.error('[profile/equip]', e);
    res.status(500).json({ error: '장착 처리 오류' });
  }
});
