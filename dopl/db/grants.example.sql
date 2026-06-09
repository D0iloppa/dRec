-- DOPL 전용 DB 유저 (예시). 실제 비밀번호로 채워 grants.sql로 복사 후 적용.
--   cp grants.example.sql grants.sql  →  비번 채우기  →  docker exec -i db psql -U doil -d dev < grants.sql
-- grants.sql은 .gitignore(*.sql) 처리되어 커밋되지 않는다 (비밀번호 보호).
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dopl') THEN
    CREATE ROLE dopl LOGIN;
  END IF;
END $$;
-- DO-block CREATE의 PASSWORD가 SCRAM 해시를 제대로 못 만드는 경우가 있어 ALTER로 분리 설정.
ALTER ROLE dopl WITH PASSWORD 'CHANGE_ME';

GRANT CONNECT ON DATABASE dev TO dopl;
GRANT USAGE ON SCHEMA public TO dopl;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, user_profile, user_wallet TO dopl;
GRANT SELECT ON quiz_question, quiz_mc_question TO dopl;
GRANT SELECT ON dev_config TO dopl;
GRANT SELECT ON item TO dopl;
GRANT SELECT, INSERT, DELETE ON user_inventory TO dopl;
GRANT USAGE, SELECT ON SEQUENCE users_id_seq TO dopl;
