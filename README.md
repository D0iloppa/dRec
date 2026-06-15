# d0il gateway

> `doil.me` 서버 인프라 + 서비스 소스 백업 저장소. 프로덕션 서버에서 실제로 도는 것의 source of truth.

모든 컨테이너는 외부 도커 네트워크 `dev-net` 을 공유한다(사전 생성 필요). nginx(`doil-gw`)가 경로/서브도메인으로 라우팅한다.

## 진행 중인 프로젝트 / 서비스

| 프로젝트 | 위치 | 스택 | 상태 |
|---|---|---|---|
| **게이트웨이 홈** | `doil-react/` | React+Vite | 운영 — `doil.me`, `page_deploy.sh` 로 발행 |
| **개발 위키** | `doil-wiki/` | Docusaurus | 운영 — `/wiki/` |
| **doil-sb (BFF)** | `doil-sb/` | Express | 운영 — `/api/`, `/sb/`. **독립 git repo**(중첩) |
| **DOPL** | `dopl/` | React+Phaser/소켓 | 개발 중 — `dopl.doil.me`, 멀티플레이 게임 플랫폼 |
| **Can I Eat (cie)** | `cie/` | React+Vite / Express / PG | 운영 — `cie.doil.me`. **별도 repo**(아래) |
| **DoilTimes** | `agent/doiltimes/` | Python + claude CLI | 운영 — `/times/`, 매일 뉴스 요약·발행(cron) |
| **SourcingSearcher** | `agent/sourcingsearcher/` | Python 에이전트 | 개발 중 — 조달 검색 자동화 |
| Oh!NO / SaigonRider | (외부 컨테이너) | — | `ohno.doil.me` / `saigon.doil.me` |

### 인프라 컨테이너
nginx(`doil-gw`) · 공유 Postgres(`db`, dev-net 별칭 `devdb`) · Mattermost · Plane · CouchDB(Obsidian Sync) · imgproxy(CDN) · postfix(메일) · certbot(SSL).

## 별도 repo 로 분리된 프로젝트

| 프로젝트 | repo | 이 repo 와의 관계 |
|---|---|---|
| **Can I Eat** | `github.com/D0iloppa/cie` | `cie/` 는 여기선 **gitignore**(서브모듈 아님). 자체 compose 로 dev-net 에 구동, 게이트웨이가 `cie.doil.me → cie:3000` 프록시. nginx conf(`nginx/conf.d/cie.doil.me.conf`)만 이 repo 가 보유 |
| **doil-sb** | (중첩 git) | `doil-sb/` 는 자체 `.git` 보유 — 커밋 시 어느 repo 인지 주의 |

## DB 규칙 — 공유 컨테이너, 프로젝트별 database
Postgres 컨테이너는 공유 `db`(별칭 `devdb`) 하나만 쓰고, 프로젝트별로 전용 database 를 둔다.
- `dev` — doil-sb/게임 등 공용 / `cie` — Can I Eat 전용 / `mattermost` — Mattermost
- 신규: `docker compose exec -T db psql -U doil -d dev -c 'CREATE DATABASE <proj> OWNER doil;'`
- `db` 별칭이 `ohno_db` 와 dev-net 에서 충돌(라운드로빈 인증실패)하므로 소비자는 **`DB_HOST=devdb`** 로 붙는다.

## 파일 구조 (요약)

```
docker/
├─ docker-compose.yml        # 인프라 서비스 정의 (cie 는 자체 compose)
├─ nginx/
│  ├─ conf.d/*.conf          # 사이트별 라우팅 (doil.me, cie.doil.me, plane, saigon, mac …)
│  ├─ html/                  # 정적 산출물 (doil-react 빌드, /times 발행물)
│  └─ live/                  # SSL 인증서 (gitignore)
├─ doil-react/               # 게이트웨이 홈 (src/App.jsx 에 서비스 카드)
├─ doil-wiki/                # Docusaurus
├─ doil-sb/                  # Express BFF (독립 repo)
├─ dopl/                     # 게임 플랫폼
├─ cie/                      # Can I Eat (gitignore, 별도 repo)
├─ dev_db/init/              # 공유 Postgres 초기 스키마/시드
├─ agent/
│  ├─ doiltimes/             # 뉴스 발행 에이전트 (claude CLI)
│  └─ sourcingsearcher/      # 조달 검색 에이전트
├─ ai-docs/                  # 에이전트 가이드라인 문서
├─ page_deploy.sh            # React 빌드→nginx/html 복사→reload
├─ wikidoc_publish.sh        # 위키 빌드+무중단 발행
└─ 인증서갱신.md             # SSL 재발급/적용 절차 (전체 SAN 목록)
```

## 자주 쓰는 명령

```bash
docker compose up -d                 # 인프라 기동 (dev-net 선행)
./page_deploy.sh                     # 메인 홈 재발행
./wikidoc_publish.sh [--no-build]    # 위키 발행
cd cie && docker compose up -d --build   # Can I Eat 배포(별도 repo)
```

## 제외 항목 (.gitignore)
`cie/` (별도 repo) · `lsh_*` (레거시) · `postgres_lsh/` · `nginx/live/`(SSL) · `nginx/cdn/`·`cdn_storage/` · `*.env` · `*.sql` 덤프.
