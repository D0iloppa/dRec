// 인증 라우트: 회원가입 / 로그인 / 내 정보.
import express from 'express';
import bcrypt from 'bcryptjs';
import type { PoolClient } from 'pg';
import { pool } from '../db.js';
import { signToken } from './jwt.js';
import { requireAuth, type AuthedRequest } from './middleware.js';

export const authRouter = express.Router();

authRouter.post('/signup', async (req, res) => {
  const { username, password, nickname, gender } = req.body ?? {};
  const nick = typeof nickname === 'string' && nickname.trim() ? nickname.trim().slice(0, 20) : username;
  // 캐릭터 성별 — 가입 시 1회 선택(고정). 캐릭터 베이스/착용샷이 성별별로 다르다.
  const g = gender === 'f' ? 'f' : 'm';
  if (!username || !password) {
    res.status(400).json({ error: 'username과 password가 필요합니다.' });
    return;
  }
  if (String(password).length < 4) {
    res.status(400).json({ error: '비밀번호는 4자 이상이어야 합니다.' });
    return;
  }
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const hash = await bcrypt.hash(String(password), 10);
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO users(username, password_hash) VALUES($1, $2) RETURNING id, username',
      [username, hash]
    );
    const u = rows[0];
    // 가입 시 프로필(닉네임, 성별 캐릭터 + 빈 착용)과 지갑을 함께 생성
    await client.query('INSERT INTO user_profile(user_id, nickname, avatar) VALUES($1, $2, $3)', [
      u.id,
      nick,
      JSON.stringify({ gender: g, base: 1, equipped: {} }),
    ]);
    await client.query('INSERT INTO user_wallet(user_id) VALUES($1)', [u.id]);
    await client.query('COMMIT');
    res.json({ token: signToken({ uid: u.id, username: u.username }), user: { id: u.id, username: u.username } });
  } catch (e: unknown) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    if (typeof e === 'object' && e && (e as { code?: string }).code === '23505') {
      res.status(409).json({ error: '이미 존재하는 username입니다.' });
      return;
    }
    console.error('[auth/signup]', e);
    res.status(500).json({ error: '가입 처리 중 오류' });
  } finally {
    client?.release();
  }
});

authRouter.post('/login', async (req, res) => {
  const { username, password } = req.body ?? {};
  try {
    const { rows } = await pool.query(
      'SELECT id, username, password_hash FROM users WHERE username = $1',
      [username]
    );
    const u = rows[0];
    if (!u || !u.password_hash || !(await bcrypt.compare(String(password ?? ''), u.password_hash))) {
      res.status(401).json({ error: 'username 또는 비밀번호가 올바르지 않습니다.' });
      return;
    }
    res.json({ token: signToken({ uid: u.id, username: u.username }), user: { id: u.id, username: u.username } });
  } catch (e) {
    console.error('[auth/login]', e);
    res.status(500).json({ error: '로그인 처리 중 오류' });
  }
});

authRouter.get('/me', requireAuth, (req: AuthedRequest, res) => {
  res.json({ user: req.user });
});
