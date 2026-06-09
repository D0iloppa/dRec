// DOPL 서버 (apps/server) — Express(REST) + Socket.IO(게임 실시간) 진입점.
import { createServer } from 'node:http';
import express from 'express';
import cors from 'cors';
import type { PoolClient } from 'pg';
import { pool } from './db.js';
import { authRouter } from './auth/routes.js';
import { oauthRouter } from './auth/oauth.js';
import { profileRouter } from './profile/routes.js';
import { shopRouter } from './shop/routes.js';
import { setupRealtime } from './realtime.js';

// 부팅 시 DB 풀 워밍업 — 첫 콜드 연결 실패를 여기서 흡수해 사용자 요청이 겪지 않게 한다.
// 유휴유지 풀에 정상 연결 N개를 미리 확보(콜드 인증 실패 흡수). 동시에 잡았다 반납해 distinct 연결 확보.
async function warmupDb(target = 3, tries = 12): Promise<void> {
  const clients: PoolClient[] = [];
  for (let i = 1; i <= tries && clients.length < target; i++) {
    try {
      const c = await pool.connect();
      await c.query('select 1');
      clients.push(c);
    } catch (e) {
      console.warn(`[dopl/server] db warmup ${i}: ${(e as Error).message}`);
      await new Promise((res) => setTimeout(res, 400));
    }
  }
  console.log(`[dopl/server] db warm: ${clients.length}/${target} connections ready`);
  clients.forEach((c) => c.release());
}
void warmupDb();

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'OK', service: 'dopl-server' });
});

app.use('/auth', authRouter);
app.use('/auth/oauth', oauthRouter);
app.use('/profile', profileRouter);
app.use('/shop', shopRouter);

const server = createServer(app);
setupRealtime(server);

const PORT = Number(process.env.PORT || 3100);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[dopl/server] listening on ${PORT} (REST + Socket.IO /games)`);
});
