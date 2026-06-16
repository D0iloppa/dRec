import os
import tempfile

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select

from .transcribe import transcribe
from .minutes import make_minutes
from .db import Session, Meeting, init_db

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


@app.post("/api/process")
async def process(audio: UploadFile = File(...)):
    """오디오 업로드 → (1) 로컬 Whisper 전사 → (2) claude CLI 회의록 → DB 저장."""
    suffix = os.path.splitext(audio.filename or "")[1] or ".audio"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await audio.read())
        tmp_path = tmp.name
    try:
        transcript = transcribe(tmp_path)
        if not transcript.strip():
            raise HTTPException(status_code=422, detail="전사 결과가 비었습니다 (무음/지원하지 않는 형식?)")
        minutes = make_minutes(transcript)
    finally:
        os.unlink(tmp_path)

    async with Session() as session:
        meeting = Meeting(filename=audio.filename or "audio", transcript=transcript, minutes=minutes)
        session.add(meeting)
        await session.commit()
        await session.refresh(meeting)
        meeting_id = meeting.id

    return {"id": meeting_id, "transcript": transcript, "minutes": minutes}


@app.get("/api/meetings")
async def list_meetings():
    """최근 회의 기록 목록(요약 메타)."""
    async with Session() as session:
        rows = (await session.execute(select(Meeting).order_by(Meeting.created_at.desc()).limit(50))).scalars().all()
        return [{"id": m.id, "filename": m.filename, "created_at": m.created_at.isoformat()} for m in rows]


@app.get("/api/meetings/{meeting_id}")
async def get_meeting(meeting_id: int):
    async with Session() as session:
        m = await session.get(Meeting, meeting_id)
        if not m:
            raise HTTPException(status_code=404, detail="not found")
        return {
            "id": m.id,
            "filename": m.filename,
            "transcript": m.transcript,
            "minutes": m.minutes,
            "created_at": m.created_at.isoformat(),
        }


# 정적 프론트엔드(SPA) 서빙 — /api 이후에 마운트해야 API 라우트가 가려지지 않는다.
if os.path.isdir(STATIC_DIR):
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
