# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Operational Rules — MANDATORY ENTRY ORDER

**Every new session must begin by reading these two files before anything else:**

1. [`ai-docs/INDEX.md`](ai-docs/INDEX.md) — document map (what exists and where)
2. [`ai-docs/context/current.md`](ai-docs/context/current.md) — last session state and next priorities

Do not perform a full-text search of the codebase. Load only the files you need based on the index. Full operational rules are in [`GUIDELINE.md`](GUIDELINE.md).

## Architecture

dRec is a **single container** that attaches to the base `doil.me` stack's external Docker network `dev-net`. The base gateway (`doil-gw`) terminates TLS and proxies `drec.doil.me → drec:8080`. There is no per-project gateway, DB, or wiki — those live in the base stack.

```
:443 (doil-gw) ── drec.doil.me ──▶ drec (single container)
                                     ├── FastAPI  /api/*   (transcribe / minutes / history)
                                     ├── static frontend (React/Vite)  /
                                     ├── faster-whisper (ffmpeg)   ← stage 1: STT
                                     └── claude CLI (subprocess)   ← stage 2: minutes
                                    devdb (shared Postgres) database `drec`
```

**Two-stage pipeline.** Claude models can't ingest audio, so STT is `faster-whisper` (stage 1, `backend/app/transcribe.py`) and minutes generation is the claude CLI invoked as a subprocess (stage 2, `backend/app/minutes.py`, auth via `CLAUDE_CODE_OAUTH_TOKEN`).

**Backend** (`backend/app/main.py`): FastAPI + SQLAlchemy (async) + asyncpg. Serves built frontend static from `/app/web/dist` and `/api/*`. uvicorn on port 8080.

**Frontend** (`frontend/`): React 18 + Vite + TypeScript. Built in the Dockerfile's first stage; the bundle is copied into the runtime image and served by FastAPI.

**Database**: shared Postgres (`devdb` alias), dedicated database `drec`. Tables created on startup via SQLAlchemy (`backend/app/db.py`).

## Commands

```bash
# 사전: dev-net + 공유 db 가동, `CREATE DATABASE drec` 1회, .env 작성
docker compose up -d --build      # 빌드 + 기동
docker compose logs -f drec       # 로그
docker compose up -d --build drec # 재빌드
```

Endpoints: `https://drec.doil.me/` (FE), `https://drec.doil.me/api/health` (BE).

## Environment Variables

`.env` and `.env.example` must always have **identical key sets**. `.env` is gitignored and never committed. `.env.example` is the committed interface template — secret values use `<change-me>`, public defaults use real values.

When adding/removing/renaming any key, update **both files simultaneously**. See `GUIDELINE.md §8` for the full security protocol.

## Document Management (SoT Mapping)

| Type | Location | Index to update |
|---|---|---|
| Active task | `ai-docs/task/active/${YYMMDD}_${title}.md` | `current.md` active task line |
| Completed task | `ai-docs/task/${YYMMDD}/${file}.md` | `task/archive.md` |
| Troubleshooting | `ai-docs/trouble/${YYMMDD}/${YYMMDD}_${title}_troubleshooting.md` | `trouble/index.md` |
| Architecture / infra | `ai-docs/context/architecture.md` etc. | `INDEX.md` |
| Spec / plan | `ai-docs/spec/${file}.md` | `INDEX.md` |
| Cross-domain TODO | `ai-docs/project_todo.md` category section | already indexed |
| Workflow procedures | `ai-docs/workflow/${name}.md` | `workflow/README.md` + `INDEX.md` |

One fact in one place. `current.md` owns current state; `INDEX.md` owns artifact locations.

After any significant change (feature complete, bug fixed, structural change), update `ai-docs/context/current.md` so the next session can pick up from INDEX.md + current.md alone.

## __DEV Context (Progress Tracking)

Project progress is tracked in the DB, not markdown files. After the DB is running:

- `__DEV_context`: key-value store (`current_focus`, `current_sprint`, `blocker`, `next_milestone`) with status emoji (🔧 in-progress / ✅ done / ⏸ waiting / ❌ cancelled)
- `__DEV_features`: feature-level status (`PLANNED → IN_PROGRESS → DONE / DEFERRED`)
- `__DEV_todos`: task-level status (`TODO → IN_PROGRESS → DONE / BLOCKED`)

**Report-first protocol**: update `current_focus` to in-progress *before* making changes; update to done *after* verification. Do not mark DONE simultaneously with implementation.

**Future direction**: consider extracting `__DEV Context` into a dedicated MCP container so Claude Code can read/write project state directly via MCP tool calls instead of going through the backend API. This would make progress tracking a first-class Claude Code integration rather than a side-channel. Implementation is out of scope for this boilerplate — note it in `ai-docs/project_todo.md` when the time comes.

## Git Hygiene

`GUIDELINE.md`, `skill.md`, and `ai-docs/` are **not committed** (`.gitignore` — uncomment those 3 lines after cloning for a real project). `.env` is never committed.
