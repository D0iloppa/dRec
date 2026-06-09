# 🎮 멀티 게임 플랫폼 구현계획

> `https://www.doil.me/sb/app` 에서 동작하는 **실시간 멀티플레이 게임 플랫폼**.
> 서버가 진행(사회자)을 주관하고, 게임 종류를 플러그인처럼 확장할 수 있는 구조로 설계.

---

## 📌 목표

- doil-sb를 **BFF(Backend-for-Frontend)** 로 정리하고, 그 위에 별도 React 프론트(`doil-app`)를 올린다.
- 첫 게임으로 **마피아**를 구현하되, **라이어게임 · 워들 · 추후 보드게임**을 같은 인프라 위에 쉽게 추가할 수 있게 만든다.
- 방 생성 시 **게임 타입을 지정**하고, 서버가 상태를 권위 있게 보유한다(치팅 방지).
- DB 없이 **in-memory** 로 시작(추후 영속화 여지).

---

## 🏗️ 아키텍처

```
브라우저 (doil-app, /sb/app)
   │  React SPA
   │  Socket.IO client  ── WebSocket ──┐
   ▼                                    ▼
Nginx (doil-gw)                   doil-sb (Express BFF)
   ├ /sb/app/        → 정적 서빙        ├ HTTP: /api, EJS 페이지
   ├ /sb/socket.io/  → WS 업그레이드 ──→ ├ Socket.IO (/games, path /sb/socket.io)
   └ /sb/            → BFF 프록시        └ 게임 엔진(in-memory)
```

### 게임 프레임워크 (게임 종류와 무관한 공통부)

```
Room(type) ──┬─ 'mafia'   → MafiaGame
             ├─ 'liar'    → LiarGame
             ├─ 'wordle'  → WordleGame
             └─ 'xxx'     → GameEngine 인터페이스만 구현하면 등록 끝

공통(Room):   방 생성/입장, 재접속 복구, 채팅, 페이즈 타이머, 역할별 상태 필터
게임별(Engine): start / onAction / playerView / viewFor
```

| 파일 | 역할 |
|------|------|
| `game/Room.js` | 공통 방 — 플레이어 식별·재접속·채팅·타이머·직렬화 |
| `game/registry.js` | 게임 타입 레지스트리 (새 게임 한 줄 등록) |
| `game/socket.js` | `/games` 네임스페이스 핸들러 (생성/입장/재접속/행동/채팅) |
| `game/engines/GameEngine.js` | 엔진 베이스 인터페이스 |
| `game/engines/*.js` | 게임별 규칙 엔진 |
| `game/util/hangul.js` | 한글 자모 분해 + 워들 채점 |

**새 게임 추가 절차**: `engines/`에 `GameEngine` 상속 엔진 작성 → `registry.js`에 추가 → 클라이언트에 뷰 컴포넌트 1개. 로비에 자동 노출.

---

## 🎲 게임별 규칙

### 🎭 마피아
- 서버가 사회자. 인원수에 따라 마피아 수 자동 배정(4~5명:1, 6~8명:2, 9명+:3).
- **밤**: 마피아(제거) · 의사(보호) · 경찰(조사). 전원 행동 시 또는 타이머(40s) 만료 시 정산.
- **낮**: 토론 후 처형 투표. 전원 투표 시 또는 타이머(60s) 만료 시 정산.
- **승리**: 마피아 전멸 → 시민 / 마피아 수 ≥ 시민 → 마피아.
- 역할별 정보 필터링(마피아끼리만 식별, 경찰 조사결과는 본인만).

### 🤥 라이어게임
- 라이어 1명만 제시어를 모름. 나머지는 제시어를 본다.
- **토론(describe)**: 채팅으로 설명(라이어는 아는 척). 호스트가 조기 종료 가능.
- **투표(vote)**: 라이어로 의심되는 사람 지목.
- 지목이 라이어 적중 → 라이어에게 **역전 추리** 기회(제시어 맞히면 라이어 승).
- 지목 실패/동률 → 라이어 승.

### 🟩 워들 (한글)
- 같은 2글자 정답을 두고 **멀티 레이스**, 각자 6회.
- **자모(초성/중성/종성) 단위 색 채점**: 🟩 위치 정확 · 🟨 다른 위치에 존재 · ⬜ 없음.
- 먼저 맞히면 승리, 전원 종료 시 정답 공개.

---

## 🧩 공통 기능

- **재접속 복구**: 클라이언트가 `localStorage`의 안정적 `playerId`로 자리 복구(새로고침 대응).
- **채팅**: 방 단위 실시간 채팅.
- **페이즈 타이머**: 서버가 `timerEndsAt`을 내려주고 클라이언트가 카운트다운.
- **역할별 상태 필터**: 직렬화 시 viewer 시점으로만 정보 노출.

---

## 🛠️ 인프라 / 배포

- **doil-sb (BFF)**: prod 전환 — 소스를 이미지에 굽고 `node app.js`로 직접 실행(nodemon 제거), `NODE_ENV=production`, healthcheck 추가.
  - 개발 핫리로드는 `docker-compose.dev.yml` 오버라이드.
- **doil-app**: `doil-react`와 동일한 빌더 패턴. Vite `base=/sb/app/`.
  - 배포: `./app_deploy.sh` → 빌드 후 `nginx/html/sb/app/`로 복사 + nginx reload.
- **Nginx**: `/sb/app/` 정적 서빙(SPA fallback) + `/sb/socket.io/` WebSocket 업그레이드 라우팅 추가.

```bash
# 클라이언트 배포
./app_deploy.sh

# 서버(prod) 기동 / 개발 핫리로드
docker compose up -d doil-sb
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d doil-sb
```

---

## 🗺️ 로드맵

- [x] 게임 프레임워크 + 마피아
- [x] 라이어게임
- [x] 워들(한글 자모)
- [ ] 추후 보드게임 추가
- [ ] 게임 상태 영속화(재시작 내성) — 필요 시 Redis/Postgres
- [ ] 페이즈별 세부 밸런스 · UI 개선

> **현재 상태**: in-memory, feature 브랜치(`feat/game-platform`)에서 개발 중. 서버 재시작 시 진행 중 게임은 소멸.
