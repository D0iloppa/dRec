-- OAuth 설정 시드 (google, kakao, naver). 값은 빈칸 — 발급 후 UPDATE로 채운다.
--   예: UPDATE dev_config SET value='실제키' WHERE key='oauth.google.client_id';
-- key 충돌 시 기존 값 보존(ON CONFLICT DO NOTHING) — 이미 채운 값을 덮지 않음.
INSERT INTO dev_config (key, value, description) VALUES
  ('oauth.google.client_id',     '', 'Google OAuth client ID'),
  ('oauth.google.client_secret', '', 'Google OAuth client secret'),
  ('oauth.google.redirect_uri',  'https://dopl.doil.me/auth/google/callback',  'Google OAuth redirect URI'),
  ('oauth.kakao.rest_api_key',   '', 'Kakao REST API key (client ID 역할)'),
  ('oauth.kakao.client_secret',  '', 'Kakao client secret (선택)'),
  ('oauth.kakao.redirect_uri',   'https://dopl.doil.me/auth/kakao/callback',   'Kakao OAuth redirect URI'),
  ('oauth.naver.client_id',      '', 'Naver OAuth client ID'),
  ('oauth.naver.client_secret',  '', 'Naver OAuth client secret'),
  ('oauth.naver.redirect_uri',   'https://dopl.doil.me/auth/naver/callback',   'Naver OAuth redirect URI')
ON CONFLICT (key) DO NOTHING;
