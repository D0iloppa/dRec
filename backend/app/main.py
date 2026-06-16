import os
import tempfile

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select

from .transcribe import transcribe
from .minutes import make_minutes
from .db import Session, Meeting, MeetingChunk, init_db

# 빌드된 프론트엔드 위치(멀티스테이지 Dockerfile 이 여기로 복사). 없으면 정적 서빙 생략.
STATIC_DIR = os.environ.get("DREC_STATIC_DIR", "/app/web/dist")

app = FastAPI(title="dRec API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def _startup():
    await init_db()


@app.get("/api/health")
async def health():
    return {"status": "ok"}


async def _transcribe_file(upload: UploadFile) -> str:
    """업로드 파일을 임시 저장 후 전사(전사 자체는 threadpool 에서 — 이벤트루프 비차단)."""
    suffix = os.path.splitext(upload.filename or "")[1] or ".audio"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await upload.read())
        tmp_path = tmp.name
    try:
        return await run_in_threadpool(transcribe, tmp_path)
    finally:
        os.unlink(tmp_path)


# ── 라이브 녹음 세션 (브라우저가 60초 조각을 스트리밍) ──────────────────

@app.post("/api/sessions")
async def create_session(title: str = Form("")):
    """녹음 세션 생성 → 즉시 id 반환."""
    async with Session() as session:
        m = Meeting(title=title, status="recording")
        session.add(m)
        await session.commit()
        await session.refresh(m)
        return {"id": m.id}


@app.post("/api/sessions/{meeting_id}/chunk")
async def add_chunk(meeting_id: int, seq: int = Form(...), audio: UploadFile = File(...)):
    """녹음 조각 1개 전사 → seq 와 함께 저장하고 그 텍스트를 즉시 반환(실시간 표시용)."""
    async with Session() as session:
        if not await session.get(Meeting, meeting_id):
            raise HTTPException(status_code=404, detail="session not found")

    text = await _transcribe_file(audio)

    async with Session() as session:
        session.add(MeetingChunk(meeting_id=meeting_id, seq=seq, text=text))
        await session.commit()
    return {"seq": seq, "text": text}


@app.post("/api/sessions/{meeting_id}/finish")
async def finish_session(meeting_id: int):
    """조각을 seq 순으로 조립 → 회의록 생성 → 저장."""
    async with Session() as session:
        m = await session.get(Meeting, meeting_id)
        if not m:
            raise HTTPException(status_code=404, detail="session not found")
        chunks = (
            await session.execute(
                select(MeetingChunk).where(MeetingChunk.meeting_id == meeting_id).order_by(MeetingChunk.seq)
            )
        ).scalars().all()
        transcript = "\n".join(c.text for c in chunks if c.text.strip())
        m.transcript = transcript
        m.status = "processing"
        await session.commit()

    if not transcript.strip():
        async with Session() as session:
            m = await session.get(Meeting, meeting_id)
            m.status = "error"
            await session.commit()
        raise HTTPException(status_code=422, detail="전사 결과가 비었습니다")

    minutes = await run_in_threadpool(make_minutes, transcript)

    async with Session() as session:
        m = await session.get(Meeting, meeting_id)
        m.minutes = minutes
        m.status = "done"
        await session.commit()
    return {"id": meeting_id, "transcript": transcript, "minutes": minutes}


# ── 파일 업로드(기존 녹음 파일) ─────────────────────────────────────────

@app.post("/api/process")
async def process(audio: UploadFile = File(...)):
    """오디오 파일 업로드 → 전사 → 회의록 → 저장(한 번에)."""
    transcript = await _transcribe_file(audio)
    if not transcript.strip():
        raise HTTPException(status_code=422, detail="전사 결과가 비었습니다 (무음/지원하지 않는 형식?)")
    minutes = await run_in_threadpool(make_minutes, transcript)

    async with Session() as session:
        m = Meeting(title=audio.filename or "audio", status="done", transcript=transcript, minutes=minutes)
        session.add(m)
        await session.commit()
        await session.refresh(m)
        meeting_id = m.id
    return {"id": meeting_id, "transcript": transcript, "minutes": minutes}


# ── 이력 조회 ───────────────────────────────────────────────────────────

@app.get("/api/meetings")
async def list_meetings():
    async with Session() as session:
        rows = (await session.execute(select(Meeting).order_by(Meeting.created_at.desc()).limit(50))).scalars().all()
        return [
            {"id": m.id, "title": m.title, "status": m.status, "created_at": m.created_at.isoformat()}
            for m in rows
        ]


@app.get("/api/meetings/{meeting_id}")
async def get_meeting(meeting_id: int):
    async with Session() as session:
        m = await session.get(Meeting, meeting_id)
        if not m:
            raise HTTPException(status_code=404, detail="not found")
        return {
            "id": m.id,
            "title": m.title,
            "status": m.status,
            "transcript": m.transcript,
            "minutes": m.minutes,
            "created_at": m.created_at.isoformat(),
        }


# 정적 프론트엔드(SPA) 서빙 — /api 이후에 마운트해야 API 라우트가 가려지지 않는다.
if os.path.isdir(STATIC_DIR):
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
