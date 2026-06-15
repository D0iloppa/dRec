# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 핵심 행동 원칙 — 카파시 지침 (Karpathy's Guidelines)

> Andrej Karpathy 의 agentic coding 안티패턴 4원칙. 본 파일과 [`ai-docs/agent-guidelines.md`](ai-docs/agent-guidelines.md) 의 모든 규칙보다 **우선**한다.

### 1. Think Before Coding — 가정하지 말고, 헷갈림을 숨기지 말 것
- 구현 전에 **가정을 명시**한다. 불확실하면 묻는다.
- 해석이 둘 이상이면 **모두 제시**하고 사용자가 고르게 한다. 임의 선택 금지.
- 더 단순한 길이 있으면 **반박**한다. 필요할 땐 push back.
- 헷갈리면 멈춘다. 무엇이 헷갈리는지 이름 붙여 묻는다.

### 2. Simplicity First — 요청을 풀 수 있는 최소한의 코드
- 요청 이상 기능 추가 금지.
- 1회용 코드에 추상화 금지.
- 요청되지 않은 "유연성·설정 가능성" 금지.
- 일어날 수 없는 시나리오에 대한 에러 처리 금지.
- 200줄 짠 게 50줄로 가능하면 다시 쓴다.
- 자문: "시니어 엔지니어가 이걸 보고 과설계라고 할까?" → 그렇다면 단순화.

### 3. Surgical Changes — 시킨 것만 건드릴 것
- 기존 코드 수정 시 **인접 코드·주석·포맷팅을 "개선"하지 않는다**.
- 망가지지 않은 것을 리팩토링하지 않는다.
- 마음에 안 들어도 **기존 스타일을 따른다**.
- 무관한 dead code 발견 시 **언급만** 하고 삭제하지 않는다.
- 내 변경으로 발생한 고아(import, 변수, 함수)만 정리한다. 기존 dead code는 요청 시에만.
- 테스트: **모든 변경 라인이 사용자 요청과 직접 연결돼야 한다.**

### 4. Goal-Driven Execution — 검증 가능한 목표로 변환할 것
- 작업을 검증 가능한 형태로 다시 정의한다:
  - "validation 추가" → "잘못된 입력에 대한 테스트 작성 후 통과시키기"
  - "버그 고치기" → "버그 재현 테스트 작성 후 통과시키기"
  - "X 리팩토링" → "리팩토링 전후 테스트가 동일하게 통과하는지 확인"
- 다단계 작업은 사전에 짧은 계획 명시:
  ```
  1. [단계] → 검증: [확인 방법]
  2. [단계] → 검증: [확인 방법]
  ```
- 강한 성공 기준이 있으면 모델이 독립적으로 루프 돌 수 있다. 약한 기준("동작하게 해줘")은 매번 재확인을 요구하게 만든다.

**작동 신호:** diff 안의 불필요한 변경이 줄어들고, 과설계로 인한 재작업이 줄어들며, **실수 후가 아니라 구현 전에** 명확화 질문이 나온다.

## Overview

This is the `doil.me` server infrastructure repository — a Docker Compose–based monorepo that hosts the gateway homepage, wiki, and sandbox services, plus legacy LSH services. It serves as the backup/source of truth for what runs on the production server.

## Architecture

```
Nginx (doil-gw) → routes by path/subdomain
  /             → static React build (doil-react → nginx/html)
  /wiki/        → doil-wiki (Docusaurus, nginx:alpine)
  /sb/          → doil-sb (Express.js)
  /api/         → doil-sb (API gateway)
  /mm/          → Mattermost (messaging)
  /cdn/         → imgproxy (image optimization)
  /lsh*/        → legacy lsh_* containers (Vite dev servers)
  /lsh_api/     → host.docker.internal:8180 (external Java API)

External subdomains:
  jenkins.doil.me   → host.docker.internal:8080
  doybrary.doil.me  → kavita:5000
  ohno.doil.me      → host.docker.internal:18080 (FastAPI)
  blog.doil.me      → Naver Blog redirect
  plane.doil.me     → Plane CE (project management, separate compose)
  cie.doil.me       → cie:3000 (Can I Eat — 별도 repo, 자체 compose)
```

All containers share the external Docker network `dev-net` (must be created separately before `docker compose up`).

## Services

| Service | Directory | Tech | Notes |
|---------|-----------|------|-------|
| doil-gw | nginx/ | nginx:latest | Reverse proxy, TLS termination |
| doil-react | doil-react/ | React + Vite | Builder-only container; outputs to nginx/html |
| doil-wiki | doil-wiki/ | Docusaurus | Multi-stage build → nginx:alpine |
| doil-sb | doil-sb/ | Express.js | Sandbox + API gateway + MCP host |
| mattermost | — | Mattermost Team | Messaging (`/mm/`), uses `db` |
| plane | — | Plane CE | Project management (`/plane/`) |
| db | dev_db/ | PostgreSQL | 공유 dev DB. 프로젝트별 database (`dev`, `cie`, `mattermost`), user: `doil`. dev-net 별칭 `devdb` (소비자는 `DB_HOST=devdb`) |
| cie | cie/ | React+Vite / Express / PG | **별도 repo**(`github.com/D0iloppa/cie`, gitignore). 자체 compose 로 dev-net 구동, `cie.doil.me`. AI=claude CLI+OAuth 토큰. database `cie` |

## Common Commands

### Docker (production-style)
```bash
docker compose up -d                    # Start all services
docker compose up -d --build doil-wiki  # Rebuild and restart wiki
docker compose logs -f doil-gw          # Tail nginx logs
```

### Deploy React frontend
```bash
# From inside doil-react/ or via deploy script:
./page_deploy.sh          # Build React + copy dist to nginx/html
```

### Deploy wiki (zero-downtime)
```bash
./wikidoc_publish.sh               # Full rebuild + redeploy
./wikidoc_publish.sh --no-build    # Redeploy without rebuild
```

### doil-react (React + Vite)
```bash
cd doil-react
npm run dev       # Vite dev server
npm run build     # Production build → dist/
npm run lint      # ESLint
npm run preview   # Preview production build locally
```

### doil-wiki (Docusaurus)
```bash
cd doil-wiki
npm run start     # Dev server
npm run build     # Static HTML build → build/
npm run deploy    # GitHub Pages deployment
```

### doil-sb (Express.js)
```bash
cd doil-sb
npm run dev       # Nodemon hot-reload dev
npm run start     # Production start
```

### dopl 애셋 생성기 (나노바나나)
dopl 게임의 캐릭터/아이템 착용샷은 `dopl/tools/assetgen/`의 파이썬 모듈로 생성한다.
```bash
cd dopl/tools/assetgen
python3 assetgen.py check            # 키/모델 확인
python3 assetgen.py base             # 남/여 베이스 캐릭터
python3 assetgen.py item <code>      # 아이템 착용샷 (베이스를 레퍼런스로 캐릭터 일관성 유지)
python3 assetgen.py all [--slot S]   # 전체
```
- **API 키**: `dopl/tools/assetgen/.env`의 `GEMINI_API_KEY` (gitignore — `.env.example` 참고)
- 아이템 프롬프트: `items.json` (code는 `db/seed_items.sql`의 item.code와 1:1)
- 산출물: `dopl/assets_gen/<m|f>/` (gitignore) → **검수 후** `dopl/apps/client/public/avatar/`로 승격
- 스타일은 `assetgen.py`의 `STYLE`/`BASE_PROMPTS` 상수로 통일 — 스타일 변경 시 base부터 재생성
- **스타일 철칙(필독): `dopl/tools/assetgen/STYLE_GUIDE.md`** — 레트로 도트 톤 불변, 착용샷은 반드시 `ref/base_*.png` 레퍼런스 첨부, 임의 프롬프트 생성 금지
- API 한도 소진 시: `dopl/tools/assetgen/ANTIGRAVITY_PROMPTS.md`의 프롬프트로 안티그라비티에서 수동 생성 → 지정 파일명으로 저장 → refine/audit/promote (API 불필요)
- 자세한 워크플로: `dopl/tools/assetgen/README.md`

### dopl 애셋 생성기 (나노바나나)
dopl 게임의 캐릭터/아이템 착용샷은 `dopl/tools/assetgen/`의 파이썬 모듈로 생성한다.
```bash
cd dopl/tools/assetgen
python3 assetgen.py check            # 키/모델 확인
python3 assetgen.py base             # 남/여 베이스 캐릭터
python3 assetgen.py item <code>      # 아이템 착용샷 (베이스를 레퍼런스로 캐릭터 일관성 유지)
python3 assetgen.py all [--slot S]   # 전체
```
- **API 키**: `dopl/tools/assetgen/.env`의 `GEMINI_API_KEY` (gitignore — `.env.example` 참고)
- 아이템 프롬프트: `items.json` (code는 `db/seed_items.sql`의 item.code와 1:1)
- 산출물: `dopl/assets_gen/<m|f>/` (gitignore) → **검수 후** `dopl/apps/client/public/avatar/`로 승격
- 스타일은 `assetgen.py`의 `STYLE`/`BASE_PROMPTS` 상수로 통일 — 스타일 변경 시 base부터 재생성
- **스타일 철칙(필독): `dopl/tools/assetgen/STYLE_GUIDE.md`** — 레트로 도트 톤 불변, 착용샷은 반드시 `ref/base_*.png` 레퍼런스 첨부, 임의 프롬프트 생성 금지
- API 한도 소진 시: `dopl/tools/assetgen/ANTIGRAVITY_PROMPTS.md`의 프롬프트로 안티그라비티에서 수동 생성 → 지정 파일명으로 저장 → refine/audit/promote (API 불필요)
- 자세한 워크플로: `dopl/tools/assetgen/README.md`

## Key File Locations

- **Nginx site config**: `nginx/conf.d/doil.me.conf`
- **Static React output**: `nginx/html/` (populated by `page_deploy.sh`)
- **SSL certs**: `nginx/live/doil.me/` (LetsEncrypt, managed by certbot, gitignored)
- **DB init scripts**: `dev_db/init/001_dev_context.sql`, `002_dev_context_seed.sql`
- **CDN assets**: `nginx/cdn/` (gitignored — large binaries)

## Nginx Routing Notes

- `doil-react` is a **builder-only** container (Docker profile). It runs `npm install && npm run build`, writes to a volume, then exits. The nginx container serves the output as static files.
- The wiki Dockerfile uses a multi-stage build: Node 20 builds Docusaurus, then copies the output into nginx:alpine. The base path is `/wiki/`.
- LSH services (`lsh_react`, `lsh_staff`, `lsh_admin`) are legacy dev-only containers that run Vite dev servers — they are not built for production.

## Database

- **Container**: `db` (PostgreSQL)
- **Exposed port**: 5432 (localhost)
- **Database**: `dev`, **User**: `doil`
- Legacy LSH uses a separate `db_lsh` container with its data directory gitignored.

## What Is Gitignored

Large or sensitive items not in the repo:
- `lsh_*/` — legacy service directories
- `nginx/live/` — SSL certificates
- `nginx/cdn/`, `cdn_storage/` — CDN binary assets
- `postgres_lsh/` — legacy DB data
- `.env`, `.env.local` — secrets
