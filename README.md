# dRec — 회의 녹음 → 회의록

회의를 **브라우저에서 라이브 녹음**하면, 60초 조각마다 **① Whisper 로 전사**(실시간 누적)하고, 종료 시 **② Claude(claude CLI)로 회의록**을 정리한다. 기존 녹음 파일 업로드도 지원한다.

> Claude 모델은 오디오를 직접 받지 못하므로, STT(1단계)는 `faster-whisper`, 회의록 정리(2단계)는 claude CLI 가 맡는 2단계 파이프라인이다.

## 라이브 슬라이스 전략

녹음 중 60초마다 조각을 전사하므로 **회의가 끝나는 순간 전사는 거의 완료** 상태 → 후처리 대기가 사라진다(긴 회의 1~2시간도 타임아웃 없이). CPU `small` 은 ~2~4배 실시간이라 60초 조각을 15~30초에 처리하여 실시간을 따라잡는다.

## 구조

`doil.me` 베이스 스택의 일부로, 단일 컨테이너가 외부 네트워크 `dev-net` 에 붙는다.
베이스 게이트웨이(`doil-gw`)가 TLS 종료 + `drec.doil.me → drec:8080` 프록시.

```
:443 (doil-gw) ── drec.doil.me ──▶ drec (단일 컨테이너)
                                     ├── FastAPI  /api/*  (세션·조각·회의록·이력)
                                     ├── 정적 프론트(React/Vite, MediaRecorder) /
                                     ├── faster-whisper (ffmpeg)  ← 1단계 STT (로컬 또는 원격 GPU)
                                     └── claude CLI (subprocess)  ← 2단계 회의록
                                    devdb(공유 Postgres) database `drec`
```

## 사전 준비

1. 베이스 스택의 `dev-net` + 공유 Postgres(`db`/`devdb`) 가동.
2. 전용 database 1회 생성: `docker exec -it db psql -U doil -d dev -c "CREATE DATABASE drec;"`
3. claude CLI OAuth 토큰: 호스트에서 `claude setup-token` → `.env` 의 `CLAUDE_CODE_OAUTH_TOKEN`.

## 실행

```bash
cp .env.example .env      # DB_PASSWORD, CLAUDE_CODE_OAUTH_TOKEN 등 채움
docker compose up -d --build
```

확인: `https://drec.doil.me/` (녹음 UI) · `https://drec.doil.me/api/health`
(마이크 사용은 HTTPS 필수 — drec.doil.me 로 접속)

## GPU 원격 전사 (선택)

이 호스트엔 GPU 가 없다. 별도 GPU PC 가 있으면 전사를 위임할 수 있다(쿠버네티스 불필요).

1. GPU PC(Windows): **NVIDIA 드라이버 + Docker Desktop**(WSL2 백엔드) 설치.
2. `tools/` 에서:
   ```bash
   docker build -f Dockerfile.whisper -t drec-whisper .
   docker run --gpus all -p 9000:9000 -v whisper_models:/root/.cache drec-whisper
   ```
3. dRec `.env`: `DREC_WHISPER_REMOTE_URL=http://<GPU-PC-IP>:9000/transcribe`
   → 이 한 줄이면 로컬 CPU 대신 원격 GPU 로 전사(예: large-v3, 2시간 회의가 수 분).

## 환경 변수

| 키 | 설명 |
|---|---|
| `DB_PASSWORD` | 공유 devdb 비밀번호(베이스 스택과 동일) |
| `DREC_WHISPER_REMOTE_URL` | 원격 GPU whisper 주소(비우면 로컬 CPU) |
| `DREC_WHISPER_MODEL` | 로컬 모드 모델 `tiny\|base\|small\|medium\|large-v3` (한국어 small↑) |
| `DREC_WHISPER_DEVICE` / `DREC_WHISPER_COMPUTE` | `cpu`/`int8` (로컬 GPU 면 `cuda`/`float16`) |
| `DREC_CLAUDE_MODEL` | 회의록 생성 모델 (기본 `claude-opus-4-8`) |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token` 발급 토큰 |

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/sessions` | 라이브 녹음 세션 생성 → `{id}` |
| POST | `/api/sessions/{id}/chunk` | 조각(seq+audio) 전사 → 그 텍스트 반환 |
| POST | `/api/sessions/{id}/finish` | 조각 조립 → 회의록 생성·저장 |
| POST | `/api/process` | 기존 파일 업로드 → 전사+회의록(한 번에) |
| GET | `/api/meetings` · `/api/meetings/{id}` | 이력 목록 / 단건 |
| GET | `/api/health` | 헬스체크 |
