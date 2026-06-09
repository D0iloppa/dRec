-- DOPL 스키마 (기존 dev DB, public). 멱등(IF NOT EXISTS).
-- 적용: docker exec -i db psql -U doil -d dev < dopl/db/schema.sql

-- 사용자 계정. password_hash가 NULL이면 OAuth 전용 계정(향후 auth_identity로 연결).
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 프로필: 닉네임 + 아바타(프리셋 JSON) + iq(레벨 대체). 계정당 1행.
CREATE TABLE IF NOT EXISTS user_profile (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  nickname   TEXT NOT NULL,
  avatar     JSONB NOT NULL DEFAULT '{"color":"slate","face":"😀"}',
  iq         INTEGER NOT NULL DEFAULT 100,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 지갑: 게임 내 재화(coins). 계정당 1행.
CREATE TABLE IF NOT EXISTS user_wallet (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  coins      INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 아바타 아이템 카탈로그. asset=렌더 키(현재 SVG 템플릿, 추후 스프라이트로 교체).
CREATE TABLE IF NOT EXISTS item (
  id      SERIAL PRIMARY KEY,
  code    TEXT UNIQUE NOT NULL,
  name    TEXT NOT NULL,
  slot    TEXT NOT NULL,          -- body/hair/face/top/acc ...
  asset   TEXT NOT NULL,          -- 렌더 키 (svg:<id> 등)
  price   INTEGER NOT NULL DEFAULT 0,
  rarity  TEXT NOT NULL DEFAULT 'common',
  enabled BOOLEAN NOT NULL DEFAULT true
);

-- 유저 인벤토리(보유 아이템).
CREATE TABLE IF NOT EXISTS user_inventory (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id     INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_id)
);

-- 플랫폼 설정 key-value 저장 (OAuth API 키 등). 값은 나중에 UPDATE로 채운다.
CREATE TABLE IF NOT EXISTS dev_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 상식퀴즈(4지선다) 콘텐츠. options=JSON 배열, answer_index=정답 인덱스(0~3).
CREATE TABLE IF NOT EXISTS quiz_mc_question (
  id           SERIAL PRIMARY KEY,
  category     TEXT,
  question     TEXT NOT NULL UNIQUE,
  options      JSONB NOT NULL,
  answer_index SMALLINT NOT NULL,
  difficulty   SMALLINT NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
