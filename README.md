# dRec — 회의 녹음 → 회의록

회의 오디오를 업로드하면 **① 로컬 Whisper 로 전사**하고 **② Claude(claude CLI)로 회의록**으로 정리한다.

> Claude 모델은 오디오를 직접 받지 못하므로, STT(1단계)는 `faster-whisper`, 회의록 정리(2단계)는 claude CLI 가 맡는 2단계 파이프라인이다.

## 구조

`doil.me` 베이스 스택의 일부로, 단일 컨테이너가 외부 네트워크 `dev-net` 에 붙는다.
베이스 게이트웨이(`doil-gw`)가 TLS 종료 + `drec.doil.me → drec:8080` 프록시.

```
:443 (doil-gw) ── drec.doil.me ──▶ drec (단일 컨테이너)
                                     ├── FastAPI  /api/*  (전사·회의록·이력)
                                     ├── 정적 프론트(React/Vite) /
                                     ├── faster-whisper (ffmpeg)  ← 1단계 STT
                                     └── claude CLI (subprocess)  ← 2단계 회의록
                                    devdb(공유 Postgres) database `drec`
```

## 사전 준비

1. 베이스 스택의 `dev-net` 네트워크와 공유 Postgres(`db`/`devdb`) 가 떠 있어야 한다.
2. 전용 database 1회 생성:
   ```bash
   docker exec -it db psql -U doil -d dev -c "CREATE DATABASE drec;"
   ```
3. claude CLI OAuth 토큰 발급(호스트에서):
   ```bash
   claude setup-token   # 출력 토큰을 .env 의 CLAUDE_CODE_OAUTH_TOKEN 에 넣는다
   ```

## 실행

```bash
cp .env.example .env      # DB_PASSWORD, CLAUDE_CODE_OAUTH_TOKEN 등 채움
docker compose up -d --build
```

확인: `https://drec.doil.me/` (업로드 UI) · `https://drec.doil.me/api/health`

## 환경 변수

| 키 | 설명 |
|---|---|
| `DB_PASSWORD` | 공유 devdb 비밀번호(베이스 스택과 동일) |
| `DREC_WHISPER_MODEL` | `tiny\|base\|small\|medium\|large-v3` (한국어는 small↑) |
| `DREC_WHISPER_DEVICE` / `DREC_WHISPER_COMPUTE` | `cpu`/`int8` (GPU 면 `cuda`/`float16`) |
| `DREC_CLAUDE_MODEL` | 회의록 생성 모델 (기본 `claude-opus-4-8`) |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token` 발급 토큰 |

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/process` | 오디오 업로드 → 전사 + 회의록 (DB 저장) |
| GET | `/api/meetings` | 최근 회의 기록 목록 |
| GET | `/api/meetings/{id}` | 단일 기록(전사본+회의록) |
| GET | `/api/health` | 헬스체크 |
