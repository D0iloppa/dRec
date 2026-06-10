# SourcingSearcher

외주/커뮤니티 사이트를 **LLM(playwright headless MCP)이 직접 둘러보며** 개발 부업 영업대상을
발굴하고, 적합도·executive summary·영업전략을 담은 HTML 보고서를 메일로 보내는 단발 실행 에이전트.
상시기동 없음 — cron 이 깨울 때만 토큰을 소모한다.

```
agent_db 조회 → claude -p (+playwright MCP 로 사이트 탐색·판단, 기존 링크 제외)
             → JSON 리드 수신 → 해시 dedup(신규만) → HTML 보고서 → agent@doil.me 발송
             → agent_db 에 리드(status=reported)·실행기록 저장
             (신규 0건이면 발송 생략 — 매시간 빈 메일 방지)
```

## 구성

| 파일 | 역할 |
|---|---|
| `sourcingsearcher.py` | 오케스트레이터 (발굴·중복제거·보고서·발송) |
| `../agentdb.py` | **agent_db 중간계층** (해싱 dedup·리드 영속·진척도·실행기록) — 에이전트 공용 |
| `../sql/agent_db_init.sql` | agent_db 스키마 (진실의 원천) |
| `mcp.json` | playwright MCP 설정 (headless + 영속 프로필 `profile/`) |
| `login.mjs` | **최초 1회** 수동 로그인 헬퍼 (headed) |
| `run.sh` | 실행 래퍼 (PATH 보정 + `~/.agents.env` 의 토큰·DB DSN 로드) |
| `.env` | RECIPIENTS / PROFILE / SITES / MODEL |

## 데이터 계층 (agent_db)

격리된 별도 DB(`agent_db`, role `agent`, 컨테이너 `db`)에 저장 — `dev`/`mattermost` 와 분리.
접속은 `~/.agents.env` 의 `AGENT_DB_DSN`.

- `leads` — 발굴한 의뢰글. `url_hash`(정규화 URL sha256, dedup 키) · `status`(new→reported→
  interested→applied→won/lost/ignored, 진척도) · `plane_issue_id`(Plane 연계, 다음 단계) · 타임스탬프.
- `runs` — 매 실행의 기동/종료 시각, 발굴·신규 건수, 성공/에러.

URL 정규화로 추적 파라미터·트레일링 슬래시 차이를 흡수 → 2시간 간격으로 돌려도 같은 글 재수집 안 함.

## 1) 최초 로그인 (1회, WSLg 필요)

위시켓·OKKY 등 로그인해야 잘 보이는 사이트를 위해 영속 프로필에 로그인을 심어둔다.

```bash
cd agent/sourcingsearcher
DISPLAY=:0 node login.mjs      # .env 의 SITES 들이 탭으로 열림 → 직접 로그인 → 터미널에서 Enter
```

로그인 정보는 `profile/` 에 저장되고, 이후 cron(headless)이 이 프로필을 재사용한다.
로그인이 만료되면 다시 한 번 실행하면 된다.

## 2) 실행

```bash
cd agent/sourcingsearcher
./run.sh --dry     # 발굴 결과(JSON)만 출력 — 메일·상태갱신 안 함. 동작 확인용
./run.sh           # 전체 — 신규 일감 있으면 메일 발송 + seen 갱신
```

- 의존성: 파이썬 표준 + `psycopg2`(agent_db) + `claude` CLI + `@playwright/mcp`(npx 자동) + 로컬 `playwright`(login.mjs 용).
- 발신: `agent@doil.me` (postfix, DKIM 서명). 인증 계정은 루트 `.env` 의 `POSTFIX_SASL_USERS`.

## 3) cron 등록 (1시간 간격)

```bash
crontab -e
```

```cron
# 매시 정각 — SourcingSearcher 영업대상 발굴
0 * * * * /mnt/c/DEV/docker/agent/sourcingsearcher/run.sh >> /mnt/c/DEV/docker/agent/sourcingsearcher/state/cron.log 2>&1
```

> **비용 주의:** 매시간 LLM 이 여러 사이트를 브라우징·판단하므로 회당 토큰이 적지 않다.
> 수확 대비 부담되면 간격을 늘리거나(예: `0 */3 * * *`) 업무시간대만(`0 9-19 * * *`) 돌려도 된다.
> 신규 0건이면 메일은 안 나가지만 LLM 호출 비용은 발생한다.

> **WSL 주의:** WSL 이 내려가 있으면 cron 도 안 돈다. headless 브라우징도 WSL 가동이 전제.

## 사이트 추가/변경

`.env` 의 `SITES="이름|URL;이름|URL"` 편집. 로그인이 필요한 사이트를 추가했으면 `login.mjs` 재실행.
