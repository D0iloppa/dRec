# DOPL MVP 계획

> 큐플레이 카피캣 게임 플랫폼 MVP. dopl 모노레포 위, **JWT 인증**, **가입/로그인 필수**(OAuth 확장 고려).
> 렌더링: 인증·아바타·재화·로비·방은 **React+서버**(Phaser 무관). **인게임 렌더는 M3 첫 게임부터 Phaser**(신규 코드베이스라 두 번 만들지 않음).
> 아키텍처: [`game-platform-architecture.md`](game-platform-architecture.md). 접근: MVP 후 **피드백 루프로 개선**.

## 핵심 기능 (6)
1. 회원가입  2. 로그인  3. 아바타(꾸미기)  4. 게임 내 재화(coins)  5. 게임 방 만들기  6. 기본 게임 타입(서브패키지): 마피아·라이어·워들·OX퀴즈·상식퀴즈·(향후 추가)

## 데이터 모델 (기존 `db`/dev)
```
users(id, username UNIQUE, password_hash NULL허용, created_at)   -- password_hash NULL = OAuth 전용(향후 auth_identity로 연결)
user_profile(user_id, nickname, avatar JSONB, iq)               -- 기존 game_player.iq 이전 (M2)
user_wallet(user_id, coins)                                     -- (M2)
quiz_question / 게임별 콘텐츠 테이블                              -- 게임 패키지 소유
```
> OAuth(향후): `auth_identity(user_id, provider, provider_uid)` 테이블 추가로 드롭인. MVP엔 미구현.

## 코드 (dopl)
```
packages/protocol, core            공유 타입 / 프레임워크
apps/server  : Express + 인증/프로필/지갑 모듈 + Socket.IO + 게임 registry
apps/client  : React 셸(가입·로그인·아바타·지갑·로비) + 게임 UI (Phaser 후속)
packages/games/{ox-quiz, common-quiz, liar, mafia, wordle}
```
> 인증/지갑/아바타는 MVP에선 server 모듈(별도 패키지화는 과설계). 게임만 패키지.

## 마일스톤 (각 단계 검증 후 진행)
- **M1 인증 기반**: users + 회원가입/로그인(REST) + JWT + apps/server 기동 → 검증: 가입→로그인→`/auth/me`
- **M2 프로필·아바타·재화**: avatar 프리셋 + coins, iq 이전 → 검증: 내 프로필/지갑 조회·변경
- **M3 로비+방+첫 게임(OX퀴즈, Phaser)**: 인증 유저 소켓 + **Phaser 씬 첫 구현(이후 게임의 템플릿)** + Phaser↔React 브리지, 종료 시 IQ+coins 적립 → 검증: 로그인→플레이→재화 증가
- **M4+ 게임 추가**: 상식퀴즈→라이어→마피아→워들 패키지화(각각 Phaser 씬). M3 템플릿 패턴 따름.

## 상태
- M1 진행 중. dopl 골격(protocol/core/server 스텁) 완료.
