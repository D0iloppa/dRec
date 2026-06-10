// 메타 라우트 — 클라이언트가 부팅 시 로드하는 정적 메타(배경음악 등).
import express from 'express';
import { pool } from '../db.js';

export const metaRouter = express.Router();

// 배경음악 트랙 목록 (bgm_track 테이블 — key가 씬/게임이 참조하는 링크 키)
metaRouter.get('/bgm', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT key, title, descr, file FROM bgm_track WHERE enabled ORDER BY sort, key'
    );
    res.json({ tracks: rows.map((r) => ({ key: r.key, title: r.title, desc: r.descr, file: r.file })) });
  } catch (e) {
    console.error('[meta/bgm]', e);
    res.status(500).json({ error: 'BGM 메타 조회 오류' });
  }
});
