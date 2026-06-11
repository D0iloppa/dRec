# dopl에 새 게임 추가하기 (as-built 레퍼런스)

> **현행 코드 기준** 실측 문서. 설계 의도는 [`game-platform-architecture.md`](game-platform-architecture.md)·[`game-platform.md`](game-platform.md) 참고.
> 이 문서는 "지금 코드가 실제로 어떻게 생겼고, 새 게임을 추가하려면 정확히 어디를 건드리는가"만 다룬다.
> 경로 기준: `dopl/` (모노레포 루트).

---

## 0. 한눈에 — 게임 1개 = 7개 신규 파일 + 6곳 배선

설계 문서가 말하는 `exports`의 `./server`/`./client` 분리는 **실제로는 적용돼 있지 않다.**
- 게임 **패키지(`packages/games/<g>`)는 서버 엔진 전용**(Phaser 미포함).
- **Phaser 씬은 클라 앱 안(`apps/client/src/games/<g>/`)에 직접** 둔다(패키지가 아님).
- 클라↔서버 공유 타입은 `@dopl/protocol` 하나뿐.

---

## 1. 신규 파일 7개 (게임당, 충돌 없음 — 전부 게임 전용 경로)

```
packages/games/<g>/package.json        # @dopl/game-<g>. mafia 것 복사 후 name만 변경
packages/games/<g>/tsconfig.json       # mafia 것 그대로 복사 (composite, refs core+protocol)
packages/games/<g>/src/index.ts        # GamePackage export (meta + createEngine)
packages/games/<g>/src/engine.ts       # GameEngine 구현 (서버 권위)
apps/client/src/games/<g>/<X>Scene.ts  # Phaser 씬
apps/client/public/games/<type>.svg            # 로비 썸네일 (플레이스홀더)
apps/client/public/games/<type>/*.svg          # 인게임 에셋 플레이스홀더 (씬 preload에서 load.svg)
```

레퍼런스로 가장 좋은 기존 게임:
- **역할·타이머·투표·은닉정보** → `packages/games/mafia/` + `apps/client/src/games/mafia/MafiaScene.ts`
- **턴제 카드** → `onecard`, **턴제 베팅** → `poker`, **턴제 완전공개** → `splendor`
- **실시간 액션**(서버는 얇은 중계, 시뮬은 클라) → `puyo`

---

## 2. 배선 6곳 (공유 파일 — ⚠️ 여기서 누락/충돌이 잘 난다)

| # | 파일 | 추가 내용 |
|---|------|-----------|
| 1 | `apps/server/src/games.ts` | `import { <g>Package } from '@dopl/game-<g>'` + `registry`에 `[<g>Package.meta.type]: <g>Package` |
| 2 | `apps/server/package.json` | `dependencies`에 `"@dopl/game-<g>": "*"` |
| 3 | `apps/server/tsconfig.json` | `references`에 `{ "path": "../../packages/games/<g>" }` |
| 4 | `tsconfig.json` (루트) | `references`에 `{ "path": "packages/games/<g>" }` |
| 5 | `apps/client/src/scenes/RoomScene.ts` | `<X>Scene` import + `GAME_SCENES`에 `'<type>': <X>Scene as unknown as new () => DoplGameScene` |
| 6 | `apps/client/src/scenes/LobbyScene.ts` | `GAME_DESC`에 `'<type>': '한 줄 설명'` |

> **⚠️ 병렬 작업 주의**: 이 6곳은 모든 게임이 공유한다. 여러 게임을 **병렬 서브에이전트로** 만들 때 각 에이전트가 이 파일들을 동시 편집하면 **마지막 쓰기만 남고 나머지는 유실**된다(실제로 겪음). 신규 파일 7개만 에이전트에 맡기고 **배선 6곳은 본인이 직렬로** 처리할 것.

설치·빌드:
```bash
cd dopl
npm install                       # 새 워크스페이스 심볼릭 링크
npm run build                     # tsc -b (packages + server)
cd apps/client && npx tsc --noEmit -p tsconfig.json   # 클라 타입체크
npm run build                     # 클라 vite 프로덕션 번들 확인
```
> 루트 `npm run build`(=`tsc -b`)는 `apps/server`까지만 본다. **클라(`apps/client`)는 별도 typecheck/build** 해야 한다(루트 tsconfig refs에 client 없음).

---

## 3. 서버 엔진 계약 (`packages/core/src/engine.ts`)

```ts
class <X>Engine extends GameEngine {
  constructor(private room: Room) { super(); }
  start(requesterId): void|Promise   // host+lobby 검증 → 상태 배정 → room.phase='playing'
  onAction(playerId, action: {kind, ...}): void|Promise  // 권위 판정. 불법이면 throw new Error('한국어')
  playerView(player, viewerId): Record  // 직렬화 시 참가자에 머지될 "그 viewer에게 보이는" 공개 필드
  viewFor(viewerId): unknown            // viewer 전용 게임 블롭 (씬이 읽음)
  results(): GameResult[]               // 종료 시 1인당 {userId, iqDelta, coinsDelta, won}
  onChat?(playerId, text)               // 채팅을 게임 입력으로 가로채기(스피드퀴즈 등). 미구현 시 일반 채팅
  chatVisible?(msg, viewerId): boolean  // vis 태그 채팅의 viewer별 가시성(마피아 밤채팅 등)
}
// index.ts:
export const <g>Package: GamePackage = {
  meta: { type:'<type>', label:'🎮 라벨', minPlayers, maxPlayers, category:'party'|'board' },
  createEngine: (room) => new <X>Engine(room),
};
```

### `Room` (packages/core/src/Room.ts) — 엔진이 쓰는 인프라
- `room.isHost(pid)`, `room.phase`('lobby'|'playing'|'ended'|커스텀), `room.hostId`, `room.code`, `room.title`
- `room.list()`/`connected()`/`player(id)` → `RoomPlayer{playerId,userId,name,connected,avatar, [임의 게임필드]}`
  - **게임별 상태는 RoomPlayer에 그냥 필드로 붙인다** (`p.alive`, `p.role`, `p.hand`, `p.iqDelta` 등). `serialize()`가 `playerView`를 머지.
- `room.startTimer(sec, cb)` / `room.clearTimer()` — 타이머 만료 후 `cb` 실행 → 자동으로 `onChange()`(=전체 broadcast). `timerEndsAt`는 자동 직렬화 → 씬이 카운트다운.
- `room.addChat(pid, text, vis?)` — `vis` 태그 시 `chatVisible` 훅으로 필터링.
- `onAction`이 **리턴하면 서버가 자동 broadcast**한다. 타이머 없이 중간 push가 필요하면 `this.room.onChange()` 직접 호출.

### 직렬화 → 씬으로 가는 모양 (`Room.serialize`)
```
RoomState = { code,type,phase,hostId,myId,timerEndsAt,
              players:[{id,name,connected,isHost,avatar, ...playerView}],
              chat:[...], game: viewFor(viewer) }
```
- **은닉정보 원칙**: 남의 손패/역할은 `viewFor`의 viewer 전용 필드(`myHand` 등)나 `playerView`의 조건부 노출로만. 절대 전체 broadcast에 넣지 말 것.
- `viewFor`는 관례상 `mode:'<type>'` 와 `log: string[]`(최근 ~40줄)를 포함 → **RoomScene 우측 "진행" 패널이 `game.log`를 렌더**.

### 경제(적립) 훅 — `apps/server/src/economy.ts`
- 게임은 economy를 **모른다**. 종료 시 각 `RoomPlayer`에 `iqDelta`/`coinsDelta`를 세팅하고 `results()`로 반환만.
- 서버(`realtime.ts`)가 `phase==='ended'` 1회 감지 시 `applyResults()` 호출(중복방지 `_paid` 플래그).
- IQ는 체감식 보정(상한 1000), XP=참가10+획득코인. 마피아 기준 수치: 승 iq≈+10~14 coins≈+30~45, 패 iq≈-2~3 coins 0.

---

## 4. 클라 Phaser 씬 계약 (`MafiaScene` 미러)

- `RoomScene.mountGame()`이 **560×420 Phaser.Game**을 새로 띄워 씬 인스턴스를 마운트.
  - 주입: `scene.sendAction = (a) => socket.emit('action', a)`
  - 호출: `scene.pushState(roomState)` (상태 갱신마다)
- **종료 화면은 플랫폼이 그린다**: `RoomScene.renderEnded`가 `game.finalBoard`(`[{name, score?, iqDelta, coinsDelta, won}]`)로 결과표+「다시 하기」렌더. → 씬은 **'playing' 단계만** 신경 쓰면 된다.
- 씬 표준 골격:
```ts
export class <X>Scene extends Phaser.Scene {
  sendAction!: (a)=>void;
  private latest: RoomState|null = null;
  private ready = false;
  constructor(){ super('<type>'); }
  preload(){ this.load.svg(key, '/games/<type>/<f>.svg', {width,height}); }
  create(){ /* UI */ this.ready=true; if(this.latest) this.render(); }
  pushState(s){ this.latest=s; if(this.ready) this.render(); }
  update(){ /* timerEndsAt 카운트다운 */ }
  private render(){ /* this.latest.game(=viewFor) + .players 로 렌더 */ }
}
```
- 아바타 토큰은 `import { avatarTexture } from '../../avatarTexture'` 재사용(텍스처 준비 전 폴백 → 준비되면 `()=>this.render()`로 재렌더).
- 캔버스 안 텍스트 입력이 필요하면 `this.add.dom(x,y).createFromHTML('<input>')` 사용(라이어 힌트/추측 입력 참고).

### 로비 썸네일 규약
- 카탈로그는 `/games/<type>.png` → 실패 시 `/games/<type>.svg` → 실패 시 no-image(라벨만). (`LobbyScene.createRoomHtml`의 `<img onerror>` 체인.)
- 그래서 **SVG 플레이스홀더만 둬도** 로비에 뜬다. 실 PNG 제작 시 그냥 `<type>.png`를 추가하면 우선 사용.

---

## 5. 현재 게임 로스터

| type | label | 분류 | 인원 | 패턴 |
|------|-------|------|------|------|
| ox-quiz / common-quiz / speed-quiz | 퀴즈류 | party | — | DB 문제로더(`games.ts`의 `load*Questions`) |
| mafia | 🔪 마피아 | party | 4~10 | 역할·타이머·투표·vis채팅 |
| bang | 🤠 뱅! | board | 4~7 | 턴제·역할·반응(pending)·무기사거리 |
| splendor | 💎 스플랜더 | board | 2~4 | 턴제·완전공개·15점종료 |
| liar | 🤥 라이어게임 | party | 3~8 | 실시간·힌트·투표·라이어추측 역전 |
| onecard | 🃏 원카드 | party | 2~6 | 턴제·카드매칭·공격누적/스킵/방향 |
| poker | ♠️ 포커 | board | 2~6 | 턴제·텍사스홀덤·사이드팟·핸드평가기 |
| puyo | 🟢 뿌요뿌요 | board | 2 | 실시간·클라시뮬+서버 garbage중계(시드공유) |

> bang/splendor/liar/onecard/poker/puyo는 **1차(플레이스홀더 SVG) 구현**. 보류 항목은 각 `engine.ts` 헤더 주석의 `// 보류:` 참고(예: 뱅 캐릭터능력·파란카드, 포커 short-allin reopen 등).

---

## 6. DB가 필요한가?
- 퀴즈류만 DB(`quiz_*` 테이블)에서 문제 로드 — `games.ts`에 로더 추가 후 `Room.context`에 주입(`realtime.ts makeRoom`).
- 카드/보드게임(뱅·포커·원카드·스플랜더·라이어·뿌요)은 **덱·단어은행을 코드 내장** → 마이그레이션 불필요.
