# 신규 프로젝트 부트스트랩 절차

`doil.me` 스택에 새 프로젝트(예: `dRec`)를 추가할 때의 표준 절차. **Doness 보일러플레이트**(`github.com/D0iloppa/Doness`)에서 출발해 별도 repo + 서브모듈 + 서브도메인 + (Docker면) 베이스 게이트웨이/네트워크 연동까지 한다. 선례: `cie/`, `dRec/`.

> 용어: `<proj>` = 프로젝트 슬러그(예: `drec`), `<Proj>` = 표시명(예: `dRec`), `<proj>.doil.me` = 발급 도메인.

---

## 0. 전제

- 베이스 스택의 외부 네트워크 `dev-net` 가동, 공유 Postgres(`db` / dev-net 별칭 `devdb`) 가동.
- 도메인 `<proj>.doil.me` DNS 발급 + TLS 는 베이스 `doil.me` 와일드카드 인증서(`/etc/ssl/live/doil.me/`) 공유.
- 호스트에 `gh`(GitHub CLI) 로그인, `docker`.

## 1. 보일러플레이트 클론 + git 해제

```bash
cd /mnt/c/DEV/docker
git clone --depth 1 https://github.com/D0iloppa/Doness /tmp/Doness
cp -a /tmp/Doness/. <proj>/
rm -rf <proj>/.git            # git 해제 — 신규 repo 로 재발급할 것이므로
```

`<proj>/.gitignore` 하단 3줄(`GUIDELINE.md`, `skill.md`, `ai-docs/`) 주석을 해제해 AI 컨텍스트 산출물을 추적 제외한다(실제 프로젝트 전환).

## 2. 프로젝트화 (보일러플레이트 → 실제 앱)

- `{PROJECT_NAME}` placeholder 치환(`frontend/index.html`, `frontend/src/App.tsx`, `backend/app/main.py`).
- `.env.example` 의 `COMPOSE_PROJECT_NAME` / `NETWORK_BRIDGE` / `DB_NAME` / `DB_USER` 등을 `<proj>` 로.
- `frontend/package.json` `name` → `<proj>-frontend`.
- 기능 코드 작성. **단일 컨테이너 패턴**(cie/dRec)을 쓰면 보일러플레이트의 자체 `nginx/`·`database/`·`wiki/`·`frontend/Dockerfile`·`frontend/nginx.conf` 은 제거하고 멀티스테이지 루트 `Dockerfile` 하나로 FastAPI 가 빌드된 프론트 static + `/api` 를 서빙한다(아래 §5).
- `README.md` / `CLAUDE.md` 의 아키텍처·커맨드 섹션을 실제 구조에 맞게 정정.

## 3. 신규 GitHub repo 연결 + push

> ⚠️ **함정(겪은 사고): `git init -b main` 의 `-b` 는 git < 2.28 에서 미지원.** 그러면 init 이 실패하고 이후 명령이 **상위 베이스 repo** 에 작용해 베이스에 오염 커밋이 생기고 브랜치가 개명된다. 반드시 init 성공과 격리를 검증할 것.

```bash
cd <proj>
git init -q
git symbolic-ref HEAD refs/heads/main          # -b 대신 (구버전 호환)
git rev-parse --show-toplevel                  # 반드시 .../<proj> 인지 검증 (베이스면 중단!)

git add -A
git -c user.name="D0iloppa" -c user.email="<email>" commit -m "feat: <Proj> 초기 구성"
gh repo create D0iloppa/<Proj> --private        # 또는 사용자가 미리 발급
git remote add origin https://github.com/D0iloppa/<Proj>.git
git push -u origin main
```

사고 복구(베이스가 오염된 경우): 베이스에서 `git branch -m <원래브랜치>` 로 개명 되돌리고 `git reset --mixed <직전커밋>` 으로 오염 커밋만 해제(working tree 보존). dRec 원격이 오염됐으면 격리 repo 재생성 후 `git push -f`.

## 4. 베이스 repo 에 서브모듈로 연결

```bash
cd /mnt/c/DEV/docker
git submodule add https://github.com/D0iloppa/<Proj>.git <proj>
# .gitmodules + <proj> gitlink 만 스코프 커밋 (무관한 working 변경 건드리지 말 것)
git add .gitmodules <proj> nginx/conf.d/<proj>.doil.me.conf
git commit -m "feat(<proj>): <Proj> 서브모듈 연결 + <proj>.doil.me 게이트웨이 라우팅"
```

## 5. Docker — 베이스 docker / 게이트웨이 연동 (cie/dRec 패턴)

프로젝트는 **자체 `docker-compose.yml`** 로 외부 네트워크 `dev-net` 에 붙고, 베이스 게이트웨이(`doil-gw`)가 TLS 종료 + `<proj>.doil.me` 프록시를 담당한다. 프로젝트별 자체 게이트웨이는 두지 않는다.

`<proj>/docker-compose.yml` 핵심:

```yaml
services:
  <proj>:
    build: .
    container_name: <proj>
    environment:
      - DB_HOST=devdb            # dev-net `db` 별칭 충돌 회피 → 전용 별칭
      - DB_NAME=<proj>           # 공유 Postgres 안 전용 database
      - DB_PASSWORD=${DB_PASSWORD:?}
    networks: [dev-net]
    restart: unless-stopped
networks:
  dev-net:
    external: true
```

공유 DB 전용 database 1회 생성: `docker exec -it db psql -U doil -d dev -c "CREATE DATABASE <proj>;"`

베이스 게이트웨이 라우팅 `nginx/conf.d/<proj>.doil.me.conf` (cie/dRec 미러): 80→443 리다이렉트 + ACME, 443 에서 `doil.me` 인증서로 TLS 종료, `resolver 127.0.0.11` + `set $up http://<proj>:<port>` 변수 프록시(컨테이너 미기동에도 nginx 로드되도록 지연 해석). 오디오·대용량 업로드면 `client_max_body_size` 와 `proxy_read_timeout` 상향.

## 6. claude CLI(Claude Code) 연동 — 컨테이너에서 AI 호출

백엔드가 AI 를 호출하면 **claude CLI 를 컨테이너 런타임에 설치**하고 **OAuth 토큰을 환경변수로** 주입한다(`~/.claude` 마운트 불필요). 선례: cie.

- Dockerfile: `RUN npm install -g @anthropic-ai/claude-code` (node 20 필요 — python 베이스면 NodeSource 로 node 설치).
- 호스트에서 `claude setup-token` 으로 OAuth 토큰 발급 → `.env` 의 `CLAUDE_CODE_OAUTH_TOKEN` 에 주입 → compose `environment` 로 전달. claude CLI 가 자동 사용.
- 코드에서는 `subprocess` 로 `claude -p --model <model>` 호출(프롬프트는 stdin 파이프). 모델 기본 `claude-opus-4-8`.

## 7. 기동 / 확인

```bash
cd <proj>
cp .env.example .env     # 비밀값 채움 (.env 는 절대 커밋 금지)
docker compose up -d --build
```

`https://<proj>.doil.me/` (앱) · `https://<proj>.doil.me/api/health`.

---

## 체크리스트

- [ ] Doness 클론 + `.git` 제거 + `.gitignore` 3줄 해제
- [ ] placeholder/프로젝트명 치환, 기능 구현, README/CLAUDE 정정
- [ ] `<proj>` 격리 git init **검증**(`show-toplevel` 이 `<proj>`) 후 신규 repo push
- [ ] 베이스에 서브모듈 add + 스코프 커밋
- [ ] `dev-net` 합류 compose + 전용 database 생성
- [ ] `nginx/conf.d/<proj>.doil.me.conf` 라우팅 추가
- [ ] AI 호출 시 claude CLI 설치 + `CLAUDE_CODE_OAUTH_TOKEN` 주입
- [ ] 기동 후 `<proj>.doil.me` 확인
