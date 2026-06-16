# Doness — Reference Guide

> Quick Start 는 [`README.md`](../README.md) 참조. 이 문서는 상세 설정과 규약을 다룬다.

---

## 추천 도커 구조

5개 서비스가 골격이다. 프로젝트 성격에 따라 일부만 사용해도 좋지만, **GW 와 wiki 는 항상 함께 둔다** (격리성 + 사람 산출물 원칙).

| 서비스 | 역할 | 추천 이미지/기술 |
|---|---|---|
| **GW** | 단일 외부 진입점, 경로 라우팅, TLS, rate-limit | `nginx:alpine` |
| **FE** | 사용자 UI | Vite dev / `nginx:alpine` 정적 서빙 prod |
| **BE** | API, 비즈니스 로직 | FastAPI (Python 3.12) 또는 동급 |
| **DB** | 영속 데이터 | `postgres:15` (+ PostGIS 등 확장 선택) |
| **wiki** | 사람용 개발자/사용자 문서 포털 | Docusaurus 3 (별도 프로파일 권장) |

`wiki` 는 `docker compose --profile wiki up` 같이 별도 프로파일로 분리하여, 일상 개발 사이클에는 빠지고 발행 시점에만 기동되게 한다.

---

## 추천 버전

### Frontend (React 계열)

```json
{
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.0",
    "zustand": "^4.5.4",
    "i18next": "^26.1.0",
    "react-i18next": "^17.0.7",
    "lucide-react": "^1.16.0",
    "sonner": "^2.0.7",
    "flag-icons": "^7.5.0"
  },
  "devDependencies": {
    "typescript": "^5.5.3",
    "vite": "^5.4.0",
    "@vitejs/plugin-react": "^4.3.1",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@types/node": "^25.7.0"
  }
}
```

> Vue 계열을 선택할 경우 `Vue 3` + `Pinia` + `TanStack Query (Vue Query)` + `TailwindCSS` 조합을 권장.

### Backend (FastAPI)

```
fastapi==0.115.5
uvicorn[standard]==0.32.0
asyncpg==0.30.0
sqlalchemy[asyncio]==2.0.36
passlib[bcrypt]==1.7.4
python-dotenv==1.0.1
python-multipart==0.0.20
httpx>=0.27
PyJWT==2.9.0
tzdata>=2024.1
```

Python 베이스 이미지: `python:3.12-slim`

### Database

- `postgres:15` (필요 시 `postgis/postgis:15-3.4`)
- 초기 스키마는 `database/init/${NNN}_${title}.sql` 순번 적용
- 컨테이너 최초 기동 시 `/docker-entrypoint-initdb.d/` 가 파일명 순서대로 실행
- `__DEV` prefix 테이블로 프로젝트 진행 상태 관리 (아래 [__DEV Context 관리](#__dev-context-관리) 참조)

### Gateway

- `nginx:alpine`
- 설정은 `nginx/conf.d/default.conf` 한 파일에 라우팅 일원화

### Wiki

- Docusaurus 3 (Node 20 LTS 베이스)
- `wiki/wiki-docs/` 에 마크다운, `./wikidoc_publish.sh` 로 무중단 재빌드
- Private 문서는 Basic Auth 로 보호 (`.env` 의 `WIKI_AUTH_USER` / `WIKI_AUTH_PASS`)

---

## 환경 변수 & 보안 규약

환경 변수를 **두 파일 짝** 으로 운영한다. 운영 세부는 [`GUIDELINE.md`](../GUIDELINE.md) §8 참조.

| 파일 | git 추적 | 용도 |
|---|---|---|
| `.env` | ❌ (`.gitignore` 적용) | 로컬/서버에 채워 넣는 **실제 값**. 절대 외부 노출 금지. |
| `.env.example` | ✅ | 키 인터페이스 템플릿. 값은 `<change-me>` 또는 공개 가능한 기본값만. |

### 핵심 규칙

1. **`.env` 는 절대 노출하지 않는다.** git 커밋·로그·채팅·AI 프롬프트 어디에도 실제 값 금지.
2. **`.env` 와 `.env.example` 은 항상 동일한 키 인터페이스를 유지한다.** 한쪽에만 키가 있으면 배포본이 부팅에 실패한다.
3. **`.env` 에 키를 추가/삭제/이름변경하면 즉시 `.env.example` 에도 반영한다.**
4. **보안 정보는 절대 하드코딩하지 않는다.** 반드시 `.env` 값을 보간으로 참조.

---

## __DEV Context 관리

프로젝트 진행 상태(현재 스프린트·기능 목록·할일)를 **PostgreSQL DB** 에서 관리하여, 어드민 콘솔·위키·AI 컨텍스트에서 실시간으로 참조할 수 있게 한다.

### 왜 DB인가

md 파일 기반 추적은 갱신이 누락되기 쉽고 여러 소비자(위키·어드민·AI)가 동시에 읽기 어렵다. DB를 SoT(Source of Truth)로 두면:
- 어드민 콘솔에서 한 클릭으로 상태 순환
- 위키 홈에서 실시간 진행률 표시 (API fetch, 재빌드 불필요)
- AI가 API로 현재 상태를 즉시 파악

### `__DEV` prefix 규약

서비스 테이블과 혼동을 방지하기 위해 **`__DEV_` prefix** 를 사용한다.

| 테이블 | 역할 |
|---|---|
| `__DEV_context` | Key-Value 저장소 (현재 스프린트, 포커스, 블로커 등) |
| `__DEV_features` | 기능 목록 (카테고리별, 상태: PLANNED → IN_PROGRESS → DONE / DEFERRED) |
| `__DEV_todos` | 할일 관리 (우선순위: URGENT~LOW, 상태: TODO → IN_PROGRESS → DONE / BLOCKED) |

### 적용 방법

1. **테이블 생성**: `database/init/900_dev_context.sql` 을 DB 초기화 스크립트에 포함하거나 직접 실행
2. **시드 데이터**: `database/init/901_dev_context_seed.sql` 의 카테고리·기능명·할일을 프로젝트에 맞게 수정 후 실행
3. **백엔드 라우터**: API(`/api/dev/*`) + 어드민 HTML(`/admin/dev`) 라우터 구현
4. **위키 컴포넌트**: `/api/dev/summary` 를 fetch하여 프로그레스 표시

900번대 번호를 사용하여 서비스 마이그레이션(001~)과 분리한다. 상세 운영 절차는 [`ai-docs/workflow/dev-context-management.md`](../ai-docs/workflow/dev-context-management.md) 참조.

---

## 디렉터리 골격

```
Doness/
├── docker-compose.yml        # 서비스 오케스트레이션
├── nginx/conf.d/             # GW 라우팅 설정
├── frontend/                 # React + Vite + TypeScript
│   ├── Dockerfile            # Production (multi-stage → nginx)
│   ├── Dockerfile.dev        # Development (HMR)
│   └── src/
├── backend/                  # FastAPI + SQLAlchemy
│   ├── Dockerfile
│   └── app/
├── wiki/                     # Docusaurus 3
│   ├── Dockerfile
│   └── wiki-docs/
├── database/init/            # SQL 초기화 스크립트
├── skill.md                  # AI 진입 시 규약 강제
├── GUIDELINE.md              # AI 운용 규칙 (로컬 전용)
├── .env.example              # 환경 변수 키 인터페이스
├── wikidoc_publish.sh        # 위키 발행 스크립트
├── docs/REFERENCE.md         # 이 파일
└── ai-docs/                  # AI 컨텍스트 (로컬 전용, git ignore)
    ├── INDEX.md              # 산출물 지도
    ├── context/current.md    # 세션 캐리오버
    ├── spec/                 # 명세 (프로젝트별)
    ├── workflow/             # 반복 태스크 절차
    ├── task/                 # 활성/완료 태스크
    ├── trouble/              # 트러블슈팅 색인
    └── project_todo.md       # 다영역 협업 TODO
```

### 프로젝트 시작 체크리스트

1. `.gitignore` 하단의 `GUIDELINE.md` / `skill.md` / `ai-docs/` 3줄 주석 해제
2. `cp .env.example .env` → `<change-me>` 항목 채우기
3. `ai-docs/spec/` 에 프로젝트 명세 작성
4. `ai-docs/context/current.md` 초기 상태 기입
5. `docker compose --profile backend up --build -d` 로 전체 기동 확인
6. 첫 활성 태스크를 `ai-docs/task/active/${YYMMDD}_${title}.md` 로 시작
