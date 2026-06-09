# Agent Guidelines (상세 규칙)

> 최우선 원칙은 [`CLAUDE.md`](../CLAUDE.md) 상단의 **카파시 지침 4원칙**이다.
> 이 문서의 모든 규칙은 그보다 하위이며, 충돌 시 카파시 지침이 이긴다.

## 문서 관리

- 에이전트/개발 운영 문서(설계 메모, 구현계획, 워크플로 등)는 **이 `ai-docs/` 디렉토리**에 둔다.
- 사용자 대상 공개 문서는 별도로 **doil-wiki**(Docusaurus, `/wiki/`)에 발행한다 — 대상 독자가 다르다.

## 작업 관리 (Plane)

- 작업/이슈는 **Plane의 `doil-sb` 프로젝트**에 티켓으로 등록한다.
- Plane 인스턴스: `https://plane.doil.me` (워크스페이스: `doil`).
- 설정/키: `doil-sb/mcp/config.yml` (gitignore 처리됨, 커밋 금지).
- MCP 연동: `doil-sb/mcp` 서버를 루트 `.mcp.json`에 `doil-mcp`로 등록 (plane/mattermost 도구). **Claude Code 재시작 시 로드됨.**
- `plane_create_project` 도구 추가됨 → 재시작 후 `doil-sb` 프로젝트 생성 + 티켓 발행 예정. 생성된 프로젝트 ID는 `config.yml`의 `plane.projects.doil_sb`에 기재.

## 미러링 (Notion)

- 대상: Notion **DOIL-SB** 페이지 (`프로젝트 리스트` DB 항목, id `37a3bd6b405d802f86d2e2a521c57b78`).
- 개발 문서를 이 페이지 하위로 미러링한다. (예: "멀티 게임 플랫폼 구현계획")
- Notion MCP는 현재 세션에 연결돼 있어 즉시 미러링 가능.

## 빌드 / 배포 명령

### 기존 서비스 (인프라 repo)
```bash
# 전체 기동 (prod 기본)
docker compose up -d

# doil-sb 개발 핫리로드
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d doil-sb

# 프론트 배포
./page_deploy.sh        # doil-react → nginx/html (/)
./app_deploy.sh         # doil-app  → nginx/html/sb/app (/sb/app)
./wikidoc_publish.sh    # doil-wiki 무중단 재발행 (--no-build: 재기동만)

# nginx 설정 검사/리로드
docker exec doil-gw nginx -t && docker exec doil-gw nginx -s reload
```

### DOPL 모노레포 (`dopl/`, npm workspaces + TS)
```bash
cd dopl
npm install                       # 워크스페이스 링크
npm run build                     # tsc -b (프로젝트 레퍼런스 빌드)
npm run clean                     # tsc -b --clean

# DB 스키마 적용 (기존 db 컨테이너의 dev DB)
docker exec -i db psql -U doil -d dev < dopl/db/schema.sql

# 서버 실행 (env: DB_HOST,DB_PORT,DB_USER,DB_PASSWORD,DB_NAME,JWT_SECRET,PORT=3100)
node apps/server/dist/index.js
```

### DOPL 배포 (라이브: dopl.doil.me)
```bash
# 서버(백엔드): compose 서비스 dopl-server (Express+Socket.IO, :3100)
docker compose build dopl-server && docker compose up -d dopl-server
#   JWT_SECRET은 env DOPL_JWT_SECRET로 주입(미설정 시 기본값 — prod에서 반드시 설정)

# 클라이언트: vite 빌드 → nginx/html/dopl 로 복사 → reload
./dopl_deploy.sh

# nginx: dopl.doil.me 443 = 루트 정적 + /socket.io·/auth·/profile → dopl-server 프록시
```
> 인증서 갱신은 `인증서갱신.md` 참고(`sudo zerossl-bot` → cert 복사 → nginx reload). dopl.doil.me는 SAN에 포함됨.

## 레포 운영 사실 (참고)

- **중첩 git repo**: `doil-sb/`는 독립 repo(branch `main`). parent(`/mnt/c/DEV/docker`, branch `master`)는 doil-sb 내부를 추적하지 않음. 커밋은 각 repo에서 따로.
- 경로 `/mnt/c/DEV/docker`와 `/home/doil/workspace/w_dev/docker`는 **동일 파일**(같은 inode).
- 배포 스크립트: `app_deploy.sh`(doil-app → `/sb/app`), `page_deploy.sh`(doil-react → `/`), `wikidoc_publish.sh`(doil-wiki).
- 모든 컨테이너는 외부 네트워크 `dev-net` 공유.
