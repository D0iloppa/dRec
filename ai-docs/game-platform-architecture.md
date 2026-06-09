# 게임 플랫폼 아키텍처 설계 (Phaser + 모노레포)

> 큐플레이 카피캣 멀티 게임 플랫폼의 **목표 아키텍처**. 구현 전 설계 문서.
> 결정사항: **npm workspaces 모노레포**, **인게임만 Phaser**(로비/메뉴/채팅은 React), **서버 권위(Node+Socket.IO)** 유지.
> **doil-sb를 모노레포 `apps/server`로 편입**(백엔드는 별도 서버 분리하지 않음). 전용 서브도메인 **`dopl.doil.me`**(DOPL = doil-playground)로 서비스.
> 관련: [`game-platform.md`](game-platform.md)(현행 프로토타입), [`agent-guidelines.md`](agent-guidelines.md).

---

## 1. 설계 원칙

- **서버 권위(authoritative)**: 게임 상태·판정은 전부 서버. 클라(Phaser)는 렌더 + 입력 전송만. 치팅 방지의 핵심.
- **게임 = 서브패키지**: 각 게임은 자기 완결적 패키지(서버 엔진 + Phaser 씬 + 공유 규칙). 추가는 패키지 1개 + registry 1줄.
- **타입별 룸**: 방 생성 시 `type`으로 게임 선택 (`ox-quiz`/`mafia`/`liar`/`wordle`/`bang`/…).
- **얇은 코어**: 공통(방·접속·채팅·타이머·소켓 프로토콜)은 `core`에. 게임별 규칙은 절대 코어로 새지 않는다.

---

## 2. 모노레포 구조 (npm workspaces)

```
doil-games/                      # 워크스페이스 루트 (package.json: "workspaces": [...])
├─ packages/
│  ├─ core/                      # 프레임워크: Room, registry, 소켓 프로토콜, GameEngine 베이스
│  ├─ protocol/                  # 클라↔서버 공유 메시지/상태 타입 (단일 출처)
│  └─ games/
│     ├─ ox-quiz/                # 게임 패키지 1개 = 아래 contract 구현
│     ├─ mafia/
│     ├─ liar/
│     ├─ wordle/
│     └─ bang/                   # 보드게임도 동일 계약
├─ apps/
│  ├─ server/                    # = 현 doil-sb 후신. Express + Socket.IO 호스트
│  └─ client/                    # = 현 doil-app 후신. React 셸 + Phaser 호스트
└─ package.json                  # workspaces 선언, 공통 스크립트
```

- 게임 패키지는 **서버용 진입점**(엔진)과 **클라용 진입점**(Phaser 씬)을 별도 export 한다 (`exports` 필드의 `./server`, `./client`). 서버 번들에 Phaser가, 클라 번들에 서버 코드가 안 섞이게.
- `core`/`protocol`은 server·client 양쪽이 의존.

> **열린 결정 (확인 필요)**
> - 패키지 매니저: **npm workspaces**(현행 유지, 최소 변경) vs pnpm(심볼릭·속도 우위). → 기본 npm 권장.
> - **TypeScript 도입**: 클라↔서버 공유 타입(`protocol`)이 핵심이라 TS가 강하게 권장됨. 단 현 코드는 JS. → 신규 패키지부터 TS, 기존은 점진 이전 권장.

---

## 3. 게임 패키지 계약 (contract)

각 게임 패키지는 다음을 제공한다 (언어 중립 표기):

```
meta            { type, label, minPlayers, maxPlayers, category: 'party' | 'board' }
ServerEngine    class — core의 GameEngine 구현:
                  start(requesterId)         게임 시작/상태 전이
                  onAction(playerId, action) 플레이어 입력 처리 (서버 권위 판정)
                  viewFor(playerId)          그 플레이어 시점의 직렬화 상태(역할별 필터)
                  playerView(player, viewer) 참가자 공개 필드
PhaserScene     createScene(ctx) — Phaser.Scene 팩토리:
                  - 서버가 push한 state를 받아 렌더
                  - 입력을 action으로 ctx.emit(action) 전송
sharedRules     순수 함수/상수 (서버·클라·테스트 공유). 예: 점수표, 자모 채점, 카드 정의
```

- **서버 엔진은 Phaser를 모른다. Phaser 씬은 규칙을 모른다.** 둘 다 `protocol`의 state/action 타입으로만 대화.
- 신규 게임 = 이 4개 채우고 registry 등록.

---

## 4. 런타임 흐름

```
[Phaser Scene]  --action(JSON)-->  [Socket.IO]  -->  [ServerEngine]
      ▲                                                   │
      └────────────  state(JSON, 역할별 필터)  ◀───────────┘
React 셸: 로비/방 선택/참가자/채팅/타이머 (DOM). 인게임 캔버스만 Phaser.
```

- 전용 오리진 `https://dopl.doil.me` — 클라(정적)는 루트 `/`, 서버는 같은 오리진의 `/socket.io`·`/api`.
- `/sb/app` base·`/sb/socket.io` 커스텀 path 폐기 → Vite `base='/'`, Socket.IO **기본 path `/socket.io`**.
- 메시지: `createRoom{type}` / `joinRoom` / `rejoin` / `start` / `action{kind,...}` / `chat` → 서버 `state` push.
- React 셸이 소켓을 소유하고, 인게임 진입 시 해당 게임의 Phaser 씬을 마운트해 `state`/`action`을 브리지.

---

## 5. 클라이언트 구성 (React 셸 + Phaser 호스트)

- **React**: 로비(게임 타입 선택), 방/대기실, 참가자 목록, 채팅, 타이머, 결과 요약 — DOM이 편한 것 전부.
- **Phaser**: `<GameCanvas type=...>` 컴포넌트가 게임 패키지의 `createScene`을 로드해 캔버스 렌더. 서버 `state`를 씬에 주입, 씬의 입력을 `action`으로 셸에 콜백.
- 한 게임에 Phaser가 과한 경우(예: OX의 텍스트 위주)에도 **연출(아바타 O/X 이동, 탈락 모션)** 은 Phaser로 — 큐플레이 느낌의 핵심.

---

## 아이디어 백로그

- **ohno 연계 퀴즈**: ohno 프로젝트의 오답노트 문제를 quiz 콘텐츠로 출제. ox-quiz/quiz 패키지가 `quiz_question` 외에 ohno 소스를 어댑터로 끌어오는 형태. 실제 오답 데이터로 콘텐츠 차별화. (구현 미정, 추후 DSB 티켓화)

## 6. 데이터/영속 (기존 db 재사용)

- 현 스키마 유지·확장: `game_player(iq…)`, `quiz_question`. 게임별 콘텐츠 테이블은 해당 게임 패키지가 소유(예: `liar_word`, `wordle_word`, `bang_card`).
- IQ(레벨 대체)는 플랫폼 공통 — `core` 또는 `apps/server`의 공용 repo가 관리, 게임 종료 시 증감.

---

## 7. 마이그레이션 경로 (현행 → 모노레포)

검증 가능한 단계 (카파시 #4):
```
1. 워크스페이스 골격 생성(packages/core, protocol, apps/server, apps/client)  → 검증: npm i, 빈 빌드 통과
2. core 추출: 현 doil-sb/game의 Room/registry/socket/db를 core+server로 이전   → 검증: 기존 소켓 스모크 테스트 통과
3. ox-quiz 패키지화 + Phaser 씬 최초 구현(현 React quiz를 대체)              → 검증: /sb/app에서 OX 플레이
4. mafia/liar/wordle 순차 패키지화 + Phaser 씬                               → 검증: 게임별 스모크
5. 빌드/배포 스크립트 갱신(app_deploy.sh → 워크스페이스 빌드)                 → 검증: 배포 후 라이브
6. bang(보드) 신규 패키지로 추가 — 계약만 채우면 됨                          → 검증: 보드 플로우
```

- 기존 React 게임 뷰(마피아·라이어·워들·quiz)는 **Phaser 씬으로 재구현** 대상. 서버 엔진 로직은 대부분 재사용(이미 서버 권위 구조).

---

## 8. 빌드 / 배포 영향

- **백엔드 배치(확정)**: `doil-sb`를 모노레포 `apps/server`로 편입. 별도 게임서버를 새로 띄우지 않음 — 단일 서버가 게임 패키지를 직접 import하면서 기존 `/api`(필요 시 `/sb`)도 유지. nginx 업스트림은 단일(`apps/server:3000`).
  - 게임 엔진이 모노레포 패키지이므로 그 소비자(서버)도 같은 워크스페이스에 있어야 import·타입공유·동시빌드가 공짜. 별도 repo 유지(cross-repo publish/link)는 비용만 큼.
  - BFF와 게임서버의 수명주기가 정말 갈라지면 그때 `apps/server`에서 분리(A→B는 쉬움).
- **서브도메인(확정)**: `dopl.doil.me`. 도메인 직접 소유라 DNS 추가 용이. 인증서는 SAN(ZeroSSL, 와일드카드 아님)이라 **`dopl.doil.me`를 SAN에 추가해 재발급** 필요(기존 zerossl-bot 사용).
  - nginx: `dopl.doil.me` server 블록 신설 — 루트 `/`는 클라 정적, `/socket.io`·`/api`는 `apps/server`로 프록시(WS 업그레이드 포함).
  - 레거시 `www.doil.me/sb/app`·`/sb/socket.io`는 폐기 또는 `dopl.doil.me`로 301.
- `app_deploy.sh`/compose 빌더가 **워크스페이스 빌드**(client/server)를 가리키도록 수정.
- 서버는 `apps/server`를 prod 이미지로 굽고 `node`로 실행(현 doil-sb prod 패턴 유지).

---

## 9. 보드게임(Bang) 고려

- 카드·턴·거리(distance)·역할 같은 복잡 상태도 **동일 계약**으로 수용 — `category: 'board'`, 턴 기반 `onAction`, 정보 은닉(손패)은 `viewFor` 필터로.
- 보드게임 특유 요소(턴 순서, 타이머 선택, 애니메이션 큐)는 게임 패키지 내부에서 처리. 코어는 모름.

---

## 10. 다음 액션 (이 설계 확정 후)

확정됨: 모노레포(npm workspaces) · 인게임만 Phaser · **doil-sb→apps/server 편입** · **dopl.doil.me**.

남은 열린 결정 2건:
- **패키지 매니저**: npm workspaces 권장(현행 유지) vs pnpm.
- **TypeScript 도입 범위**: 공유 `protocol` 타입 때문에 강하게 권장 — 신규 패키지부터 TS, 기존 점진 이전.

발급/착수 체크리스트:
- [ ] `dopl.doil.me` DNS 레코드 추가 (도메인 직접 소유 → 용이)
- [ ] 인증서 SAN에 `dopl.doil.me` 추가 후 재발급 (zerossl-bot)
- [ ] nginx `dopl.doil.me` server 블록 (루트 정적 + `/socket.io`·`/api` 프록시)
- [ ] 1단계 워크스페이스 골격 스캐폴딩
- [ ] Plane DSB에 "Phaser 모노레포 마이그레이션" 티켓 등록
