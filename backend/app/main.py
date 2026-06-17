import json
import os
import shutil
import subprocess
import tempfile
import uuid

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Depends
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy import select, or_

from .transcribe import transcribe, diarize
from .minutes import make_minutes
from .db import Session, Meeting, MeetingChunk, User, init_db
from .auth import current_user, issue_token, user_from_token_str

# 빌드된 프론트엔드 위치(멀티스테이지 Dockerfile 이 여기로 복사). 없으면 정적 서빙 생략.
STATIC_DIR = os.environ.get("DREC_STATIC_DIR", "/app/web/dist")

# 녹음 오디오 영속 저장 위치(compose 볼륨). 회의별 조각 + 합성본을 보관해 재생/화자분리에 쓴다.
DATA_DIR = os.environ.get("DREC_DATA_DIR", "/data")


def _meeting_dir(meeting_id: int) -> str:
    return os.path.join(DATA_DIR, "audio", str(meeting_id))


def _full_audio_path(meeting_id: int) -> str:
    return os.path.join(_meeting_dir(meeting_id), "full.webm")


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


# ── 인증 (게스트 uuid + JWT, OAuth 연동 대비) ───────────────────────────

@app.post("/api/auth/guest")
async def auth_guest():
    """게스트 계정을 uuid 로 등록하고 JWT 를 발급. (OAuth 연동 시 이 user 행에 provider/sub 채움)"""
    uid = str(uuid.uuid4())
    async with Session() as session:
        session.add(User(id=uid, provider="guest"))
        await session.commit()
    return {"token": issue_token(uid), "user_id": uid}


async def _owned(session, meeting_id: int, user: str) -> Meeting:
    """회의를 가져오되 소유자(user)가 아니면 404(존재 은폐)."""
    m = await session.get(Meeting, meeting_id)
    if not m or m.user_id != user:
        raise HTTPException(status_code=404, detail="not found")
    return m


# ── 라이브 녹음 세션 (브라우저가 60초 조각을 스트리밍) ──────────────────

@app.post("/api/sessions")
async def create_session(title: str = Form(""), user: str = Depends(current_user)):
    """녹음 세션 생성 → 즉시 id 반환."""
    async with Session() as session:
        m = Meeting(title=title, status="recording", user_id=user)
        session.add(m)
        await session.commit()
        await session.refresh(m)
        return {"id": m.id}


@app.post("/api/sessions/{meeting_id}/chunk")
async def add_chunk(meeting_id: int, seq: int = Form(...), audio: UploadFile = File(...), user: str = Depends(current_user)):
    """녹음 미리보기 조각 1개를 전사해 즉시 반환(실시간 표시용).

    이 조각은 **미리보기 전용** — 저장하지 않는다. 정식 전사/화자분리/재생은 종료 시
    업로드되는 연속 단일 녹음(`/audio`)을 쓴다. 폴백용으로 텍스트만 meeting_chunks 에 보관.
    """
    async with Session() as session:
        await _owned(session, meeting_id, user)

    suffix = os.path.splitext(audio.filename or "")[1] or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await audio.read())
        tmp_path = tmp.name
    try:
        text = await run_in_threadpool(transcribe, tmp_path)
    finally:
        os.unlink(tmp_path)

    async with Session() as session:
        session.add(MeetingChunk(meeting_id=meeting_id, seq=seq, text=text))
        await session.commit()
    return {"seq": seq, "text": text}


@app.post("/api/sessions/{meeting_id}/audio")
async def upload_session_audio(meeting_id: int, audio: UploadFile = File(...), user: str = Depends(current_user)):
    """종료 시 연속 단일 녹음 전체를 업로드 → 재생/화자분리용 seekable webm 으로 보관."""
    async with Session() as session:
        await _owned(session, meeting_id, user)
    mdir = _meeting_dir(meeting_id)
    os.makedirs(mdir, exist_ok=True)
    suffix = os.path.splitext(audio.filename or "")[1] or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await audio.read())
        src = tmp.name
    # MediaRecorder webm 은 seek 큐가 없을 수 있어 opus 로 remux(재생 탐색·싱킹 정확도 확보).
    try:
        await run_in_threadpool(
            lambda: subprocess.run(
                ["ffmpeg", "-y", "-i", src, "-c:a", "libopus", _full_audio_path(meeting_id)],
                check=True, capture_output=True,
            )
        )
    finally:
        os.unlink(src)
    return {"ok": True}


@app.post("/api/sessions/{meeting_id}/finish")
async def finish_session(meeting_id: int, user: str = Depends(current_user)):
    """오디오 합성 → (가능하면) 화자분리 전사, 아니면 조각 조립 → 회의록 생성 → 저장."""
    async with Session() as session:
        m = await _owned(session, meeting_id, user)
        chunks = (
            await session.execute(
                select(MeetingChunk).where(MeetingChunk.meeting_id == meeting_id).order_by(MeetingChunk.seq)
            )
        ).scalars().all()
        live_transcript = "\n".join(c.text for c in chunks if c.text.strip())
        m.status = "processing"
        await session.commit()

    # 종료 시 업로드된 연속 단일 녹음(full.webm)으로 화자분리 전사 시도(실패 시 미리보기 조각 전사로 폴백).
    transcript = live_transcript
    segments_json = ""
    full_audio = _full_audio_path(meeting_id)
    if os.path.isfile(full_audio):
        try:
            result = await run_in_threadpool(diarize, full_audio)
            transcript = result["text"]
            segments_json = json.dumps(result["segments"], ensure_ascii=False)
        except Exception:
            try:
                transcript = await run_in_threadpool(transcribe, full_audio)  # 화자분리만 실패 → 전체 전사
            except Exception:
                transcript = live_transcript

    if not transcript.strip():
        async with Session() as session:
            m = await session.get(Meeting, meeting_id)
            m.status = "error"
            await session.commit()
        raise HTTPException(status_code=422, detail="전사 결과가 비었습니다")

    minutes = await run_in_threadpool(make_minutes, transcript)

    async with Session() as session:
        m = await session.get(Meeting, meeting_id)
        m.transcript = transcript
        m.segments = segments_json
        m.minutes = minutes
        m.status = "done"
        await session.commit()
    return {"id": meeting_id, "transcript": transcript, "minutes": minutes}


# ── 파일 업로드(기존 녹음 파일) ─────────────────────────────────────────

@app.post("/api/process")
async def process(audio: UploadFile = File(...), user: str = Depends(current_user)):
    """오디오 파일 업로드 → (가능하면) 화자분리 전사 → 회의록 → 저장(한 번에)."""
    async with Session() as session:
        m = Meeting(title=audio.filename or "audio", status="processing", user_id=user)
        session.add(m)
        await session.commit()
        await session.refresh(m)
        meeting_id = m.id

    # 재생/분석용으로 webm(opus) 단일 파일로 변환 저장.
    mdir = _meeting_dir(meeting_id)
    os.makedirs(mdir, exist_ok=True)
    suffix = os.path.splitext(audio.filename or "")[1] or ".audio"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await audio.read())
        src_path = tmp.name
    full_audio = _full_audio_path(meeting_id)
    try:
        await run_in_threadpool(
            lambda: subprocess.run(
                ["ffmpeg", "-y", "-i", src_path, "-c:a", "libopus", full_audio],
                check=True, capture_output=True,
            )
        )
    finally:
        os.unlink(src_path)

    segments_json = ""
    try:
        result = await run_in_threadpool(diarize, full_audio)
        transcript = result["text"]
        segments_json = json.dumps(result["segments"], ensure_ascii=False)
    except Exception:
        transcript = await run_in_threadpool(transcribe, full_audio)

    if not transcript.strip():
        async with Session() as session:
            m = await session.get(Meeting, meeting_id)
            m.status = "error"
            await session.commit()
        raise HTTPException(status_code=422, detail="전사 결과가 비었습니다 (무음/지원하지 않는 형식?)")

    minutes = await run_in_threadpool(make_minutes, transcript)
    async with Session() as session:
        m = await session.get(Meeting, meeting_id)
        m.transcript = transcript
        m.segments = segments_json
        m.minutes = minutes
        m.status = "done"
        await session.commit()
    return {"id": meeting_id, "transcript": transcript, "minutes": minutes}


# ── 이력 조회 ───────────────────────────────────────────────────────────

@app.get("/api/meetings")
async def list_meetings(q: str = "", user: str = Depends(current_user)):
    async with Session() as session:
        stmt = select(Meeting).where(Meeting.user_id == user).order_by(Meeting.created_at.desc())
        if q.strip():
            like = f"%{q.strip()}%"
            stmt = stmt.where(or_(Meeting.title.ilike(like), Meeting.minutes.ilike(like), Meeting.transcript.ilike(like)))
        rows = (await session.execute(stmt.limit(50))).scalars().all()
        return [
            {"id": m.id, "title": m.title, "status": m.status, "created_at": m.created_at.isoformat()}
            for m in rows
        ]


@app.get("/api/meetings/{meeting_id}")
async def get_meeting(meeting_id: int, user: str = Depends(current_user)):
    async with Session() as session:
        m = await _owned(session, meeting_id, user)
        return {
            "id": m.id,
            "title": m.title,
            "status": m.status,
            "transcript": m.transcript,
            "segments": json.loads(m.segments) if m.segments else [],
            "speaker_meta": json.loads(m.speaker_meta) if m.speaker_meta else {},
            "minutes": m.minutes,
            "created_at": m.created_at.isoformat(),
            "has_audio": os.path.isfile(_full_audio_path(m.id)),
        }


@app.get("/api/meetings/{meeting_id}/audio")
async def get_meeting_audio(meeting_id: int, t: str = ""):
    """<audio> 태그는 헤더를 못 실으므로 토큰을 쿼리(?t=)로 받아 소유권 검증."""
    user = user_from_token_str(t)
    async with Session() as session:
        await _owned(session, meeting_id, user)
    path = _full_audio_path(meeting_id)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="no audio")
    return FileResponse(path, media_type="audio/webm", filename=f"meeting-{meeting_id}.webm")


class MeetingPatch(BaseModel):
    title: str


@app.patch("/api/meetings/{meeting_id}")
async def rename_meeting(meeting_id: int, patch: MeetingPatch, user: str = Depends(current_user)):
    async with Session() as session:
        m = await _owned(session, meeting_id, user)
        m.title = patch.title
        await session.commit()
        return {"id": m.id, "title": m.title}


class SpeakerInfo(BaseModel):
    name: str = ""
    color: str = ""


class SpeakerMeta(BaseModel):
    meta: dict[str, SpeakerInfo]  # {"화자 A": {"name": "김부장", "color": "#e03e3e"}, …}


@app.patch("/api/meetings/{meeting_id}/speakers")
async def set_speaker_meta(meeting_id: int, body: SpeakerMeta, user: str = Depends(current_user)):
    async with Session() as session:
        m = await _owned(session, meeting_id, user)
        meta = {k: v.model_dump() for k, v in body.meta.items()}
        m.speaker_meta = json.dumps(meta, ensure_ascii=False)
        await session.commit()
        return {"id": m.id, "speaker_meta": meta}


@app.delete("/api/meetings/{meeting_id}")
async def delete_meeting(meeting_id: int, user: str = Depends(current_user)):
    async with Session() as session:
        m = await _owned(session, meeting_id, user)
        await session.delete(m)
        await session.commit()
    shutil.rmtree(_meeting_dir(meeting_id), ignore_errors=True)
    return {"ok": True}


# 정적 프론트엔드(SPA) 서빙 — /api 이후에 마운트해야 API 라우트가 가려지지 않는다.
if os.path.isdir(STATIC_DIR):
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
