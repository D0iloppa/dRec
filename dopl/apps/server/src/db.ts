// Postgres 연결 — 기존 공유 컨테이너 `db`의 dev DB 사용.
import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'doil',
  password: process.env.DB_PASSWORD || 'doildev1!',
  database: process.env.DB_NAME || 'dev',
  max: 5,
  // 유휴 연결을 닫지 않음(기본 10s) — 콜드 재연결 시 간헐적 SCRAM 인증 실패를 회피.
  idleTimeoutMillis: 0,
  keepAlive: true,
});

pool.on('error', (e) => console.error('[db] pool error:', e.message));
