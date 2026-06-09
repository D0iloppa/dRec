// OAuth 시작 라우트 — dev_config의 키를 읽어 redirect. 키 미등록이면 "준비 중" 안내.
// 풀 콜백/토큰교환은 앱 등록 + 키 입력 후 구현 예정.
import express from 'express';
import { pool } from '../db.js';

export const oauthRouter = express.Router();

const PROVIDERS = ['google', 'kakao', 'naver'];
const clientIdKey = (p: string) => (p === 'kakao' ? 'oauth.kakao.rest_api_key' : `oauth.${p}.client_id`);

async function getConfig(key: string): Promise<string> {
  const { rows } = await pool.query('SELECT value FROM dev_config WHERE key = $1', [key]);
  return rows[0]?.value ?? '';
}

oauthRouter.get('/:provider/start', async (req, res) => {
  const provider = req.params.provider;
  if (!PROVIDERS.includes(provider)) {
    res.status(404).send('unknown provider');
    return;
  }
  const clientId = await getConfig(clientIdKey(provider));
  if (!clientId) {
    res
      .status(200)
      .type('html')
      .send(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
          `<body style="font-family:system-ui;text-align:center;padding:3rem 1.5rem;background:linear-gradient(#7ec8ff,#e6f7ff);min-height:100vh;margin:0">` +
          `<h2>🚧 ${provider} 로그인 준비 중</h2>` +
          `<p style="color:#0b6cb0">앱 등록 후 키를 입력하면 활성화됩니다.</p>` +
          `<a href="/" style="color:#0b6cb0;font-weight:800">← 돌아가기</a></body>`
      );
    return;
  }
  // TODO: 키 등록 후 — provider authorize URL로 redirect + /callback 토큰교환 구현
  res.status(501).json({ error: 'OAuth 플로우 미구현 (키는 등록됨)' });
});
