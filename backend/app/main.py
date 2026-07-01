import asyncio
import glob
import json
import os
import shutil
import subprocess
import tempfile
import uuid

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Depends, BackgroundTasks, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy import select, or_

from .transcribe import transcribe, diarize, transcribe_with_timestamps
from .minutes import make_minutes, make_named_transcript
from .db import Session, Meeting, MeetingChunk, User, init_db
from .auth import current_user, issue_token, user_from_token_str

STATIC_DIR = os.environ.get("DREC_STATIC_DIR", "/app/web/dist")
DATA_DIR = os.environ.get("DREC_DATA_DIR", "/data")

# 세션별 SSE 큐: meeting_id → [Queue, ...]
_session_queues: dict[int, list[asyncio.Queue]] = {}


def _meeting_dir(meeting_id: int) -> str:
    return os.path.join(DATA_DIR, "audio", str(meeting_id))


def _full_audio_path(meeting_id: int) -> str:
    return os.path.join(_meeting_dir(meeting_id), "full.webm")


async def _push_event(meeting_id: int, event: dict) -> None:
    for q in _session_queues.get(meeting_id, []):
        await q.put(event)


app = FastAPI(title="dRec API", version="0.2.0")

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


# ── 인증 ────────────────────────────────────────────────────────────────────

@app.post("/api/auth/guest")
async def auth_guest():
    uid = str(uuid.uuid4())
    async with Session() as session:
        session.add(User(id=uid, provider="guest"))
        await session.commit()
    return {"token": issue_token(uid), "user_id": uid}


async def _owned(session, meeting_id: int, user: str) -> Meeting:
    m = await session.get(Meeting, meeting_id)
    if not m or m.user_id != user:
        raise HTTPException(status_code=404, detail="not found")
    return m


# ── SSE 스트림 ───────────────────────────────────────────────────────────────

@app.get("/api/sessions/{meeting_id}/events")
async def session_events(meeting_id: int, t: str = ""):
    """`EventSource`용 SSE 스트림. 토큰은 쿼리 파라미터 ?t= 로 전달."""
    user = user_from_token_str(t)
    async with Session() as session:
        await _owned(session, meeting_id, user)

    queue: asyncio.Queue = asyncio.Queue()
    _session_queues.setdefault(meeting_id, []).append(queue)

    async def generate():
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=20.0)
                    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                    if event.get("type") in ("done", "error"):
                        break
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            queues = _session_queues.get(meeting_id, [])
            if queue in queues:
                queues.remove(queue)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── 라이브 녹음 세션 ─────────────────────────────────────────────────────────

@app.post("/api/sessions")
async def create_session(title: str = Form(""), user: str = Depends(current_user)):
    async with Session() as session:
        canvas_id = f"drec-{uuid.uuid4().hex[:16]}"
        m = Meeting(title=title, status="recording", user_id=user, canvas_id=canvas_id)
        session.add(m)
        await session.commit()
        await session.refresh(m)
        return {"id": m.id, "canvas_id": m.canvas_id}


@app.post("/api/sessions/{meeting_id}/chunk")
async def add_chunk(
    meeting_id: int,
    background_tasks: BackgroundTasks,
    seq: int = Form(...),
    time_offset: float = Form(0.0),
    audio: UploadFile = File(...),
    user: str = Depends(current_user),
):
    """VAD 청크 1개를 비동기 전사 → SSE push. HTTP 응답은 즉시 반환."""
    async with Session() as session:
        await _owned(session, meeting_id, user)

    suffix = os.path.splitext(audio.filename or "")[1] or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await audio.read())
        tmp_path = tmp.name

    background_tasks.add_task(_process_chunk, meeting_id, seq, time_offset, tmp_path, suffix)
    return {"ok": True}


async def _process_chunk(meeting_id: int, seq: int, time_offset: float, tmp_path: str, suffix: str = ".webm") -> None:
    # 청크를 영구 보존 — 종료 시 concat으로 full audio 구성
    chunk_dir = os.path.join(_meeting_dir(meeting_id), "chunks")
    os.makedirs(chunk_dir, exist_ok=True)
    chunk_path = os.path.join(chunk_dir, f"seq_{seq:06d}{suffix}")
    try:
        shutil.move(tmp_path, chunk_path)
    except Exception:
        chunk_path = tmp_path  # move 실패 시 원본 경로 fallback

    try:
        result = await run_in_threadpool(transcribe_with_timestamps, chunk_path, time_offset)
        async with Session() as session:
            session.add(MeetingChunk(meeting_id=meeting_id, seq=seq, text=result["text"], time_offset=time_offset))
            await session.commit()
        for seg in result["segments"]:
            await _push_event(meeting_id, {"type": "segment", **seg})
        if not result["segments"] and result["text"]:
            await _push_event(meeting_id, {
                "type": "segment", "seq": seq,
                "text": result["text"], "start": time_offset, "end": round(time_offset + 3.0, 2),
            })
    except Exception as e:
        print(f"[chunk] meeting={meeting_id} seq={seq} 실패: {e}", flush=True)
    # chunk_path 삭제하지 않음


@app.post("/api/sessions/{meeting_id}/audio")
async def upload_session_audio(meeting_id: int, audio: UploadFile = File(...), user: str = Depends(current_user)):
    """종료 시 연속 단일 녹음 전체를 업로드 → seekable webm 으로 보관."""
    async with Session() as session:
        await _owned(session, meeting_id, user)
    mdir = _meeting_dir(meeting_id)
    os.makedirs(mdir, exist_ok=True)
    suffix = os.path.splitext(audio.filename or "")[1] or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await audio.read())
        src = tmp.name
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
async def finish_session(meeting_id: int, background_tasks: BackgroundTasks, user: str = Depends(current_user)):
    """오디오 업로드 후 호출. 화자분리를 백그라운드에서 시작하고 즉시 리턴."""
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

    background_tasks.add_task(_run_diarization, meeting_id, live_transcript)
    return {"id": meeting_id, "status": "processing"}


async def _run_diarization(meeting_id: int, live_transcript: str) -> None:
    """백그라운드: 화자분리 → DB 업데이트 → SSE push."""
    transcript = live_transcript
    segments_json = ""
    full_audio = _full_audio_path(meeting_id)

    # full audio 없으면 저장된 청크들을 concat해서 생성
    if not os.path.isfile(full_audio):
        chunk_dir = os.path.join(_meeting_dir(meeting_id), "chunks")
        chunks = sorted(glob.glob(os.path.join(chunk_dir, "seq_*.webm"))) if os.path.isdir(chunk_dir) else []
        if chunks:
            os.makedirs(os.path.dirname(full_audio), exist_ok=True)
            concat_list = os.path.join(chunk_dir, "concat.txt")
            with open(concat_list, "w") as f:
                for c in chunks:
                    f.write(f"file '{os.path.abspath(c)}'\n")
            try:
                await run_in_threadpool(
                    lambda: subprocess.run(
                        ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", concat_list,
                         "-c:a", "libopus", full_audio],
                        check=True, capture_output=True,
                    )
                )
                print(f"[diarize] {len(chunks)}개 청크 → full audio concat 완료", flush=True)
            except Exception as e:
                print(f"[diarize] concat 실패: {e}", flush=True)

    if os.path.isfile(full_audio):
        try:
            result = await run_in_threadpool(diarize, full_audio)
            transcript = result["text"]
            segments_json = json.dumps(result["segments"], ensure_ascii=False)
        except Exception as e:
            print(f"[diarize] 실패 → 전체 전사 폴백: {e}", flush=True)
            try:
                transcript = await run_in_threadpool(transcribe, full_audio)
            except Exception as e2:
                print(f"[transcribe] 폴백도 실패: {e2}", flush=True)

    async with Session() as session:
        m = await session.get(Meeting, meeting_id)
        if not m:
            return
        if not transcript.strip():
            m.status = "error"
            await session.commit()
            await _push_event(meeting_id, {"type": "error", "message": "전사 결과가 비었습니다"})
            return
        m.transcript = transcript
        m.segments = segments_json
        m.status = "transcribed"
        await session.commit()

    segments = json.loads(segments_json) if segments_json else []
    await _push_event(meeting_id, {"type": "diarize", "segments": segments})


# ── 회의록 생성 ──────────────────────────────────────────────────────────────

class SpeakerInfo(BaseModel):
    name: str = ""
    color: str = ""


class MinutesRequest(BaseModel):
    speaker_meta: dict[str, SpeakerInfo] = {}


@app.post("/api/meetings/{meeting_id}/minutes")
async def generate_minutes(
    meeting_id: int,
    body: MinutesRequest,
    background_tasks: BackgroundTasks,
    user: str = Depends(current_user),
):
    """화자 메타를 적용해 named_transcript + 회의록 생성 (백그라운드)."""
    async with Session() as session:
        m = await _owned(session, meeting_id, user)
        if m.status not in ("transcribed", "done", "error"):
            raise HTTPException(status_code=400, detail=f"전사 완료 후 요청 가능 (현재: {m.status})")
        meta = {k: v.model_dump() for k, v in body.speaker_meta.items()}
        m.speaker_meta = json.dumps(meta, ensure_ascii=False)
        m.status = "processing_minutes"
        transcript = m.transcript
        segments = json.loads(m.segments) if m.segments else []
        await session.commit()

    background_tasks.add_task(_run_minutes, meeting_id, transcript, segments, meta)
    return {"id": meeting_id, "status": "processing_minutes"}


async def _run_minutes(meeting_id: int, transcript: str, segments: list, speaker_meta: dict) -> None:
    """백그라운드: named_transcript 생성 + AI 회의록 생성 → DB 업데이트 → SSE push."""
    try:
        named = await run_in_threadpool(make_named_transcript, transcript, segments, speaker_meta)
        minutes = await run_in_threadpool(make_minutes, named)
        async with Session() as session:
            m = await session.get(Meeting, meeting_id)
            if not m:
                return
            m.named_transcript = named
            m.minutes = minutes
            m.status = "done"
            await session.commit()
        await _push_event(meeting_id, {"type": "done"})
    except Exception as e:
        print(f"[minutes] meeting={meeting_id} 실패: {e}", flush=True)
        async with Session() as session:
            m = await session.get(Meeting, meeting_id)
            if m:
                m.status = "error"
                await session.commit()
        await _push_event(meeting_id, {"type": "error", "message": str(e)})


@app.post("/api/meetings/{meeting_id}/regenerate")
async def regenerate_meeting(meeting_id: int, background_tasks: BackgroundTasks, user: str = Depends(current_user)):
    """원천 오디오 기반으로 화자분리·회의록 전체 재실행."""
    async with Session() as session:
        m = await _owned(session, meeting_id, user)
        if not os.path.isfile(_full_audio_path(meeting_id)):
            raise HTTPException(status_code=404, detail="원천 오디오 없음 — 재생성 불가")
        live_transcript = m.transcript
        m.status = "processing"
        m.segments = ""
        m.named_transcript = ""
        m.minutes = ""
        await session.commit()

    background_tasks.add_task(_run_diarization, meeting_id, live_transcript)
    return {"id": meeting_id, "status": "processing"}


# ── 파일 업로드(기존 녹음) ───────────────────────────────────────────────────

@app.post("/api/process")
async def process(audio: UploadFile = File(...), user: str = Depends(current_user)):
    """오디오 파일 업로드 → 화자분리 전사 → meeting 생성 (즉시 done 또는 transcribed 상태)."""
    async with Session() as session:
        m = Meeting(title=audio.filename or "audio", status="processing", user_id=user)
        session.add(m)
        await session.commit()
        await session.refresh(m)
        meeting_id = m.id

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
        raise HTTPException(status_code=422, detail="전사 결과가 비었습니다")

    async with Session() as session:
        m = await session.get(Meeting, meeting_id)
        m.transcript = transcript
        m.segments = segments_json
        m.status = "transcribed"
        await session.commit()
    return {"id": meeting_id, "status": "transcribed"}


# ── 이력 조회 ────────────────────────────────────────────────────────────────

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
            "named_transcript": m.named_transcript,
            "segments": json.loads(m.segments) if m.segments else [],
            "speaker_meta": json.loads(m.speaker_meta) if m.speaker_meta else {},
            "minutes": m.minutes,
            "created_at": m.created_at.isoformat(),
            "has_audio": os.path.isfile(_full_audio_path(m.id)),
            "canvas_id": m.canvas_id or f"drec-{m.id}",
        }


@app.get("/api/meetings/{meeting_id}/canvas")
async def get_canvas(meeting_id: int, user: str = Depends(current_user)):
    async with Session() as session:
        m = await _owned(session, meeting_id, user)
        return {"canvas_data": m.canvas_data or ""}


@app.put("/api/meetings/{meeting_id}/canvas")
async def put_canvas(meeting_id: int, request: Request, user: str = Depends(current_user)):
    body = await request.json()
    async with Session() as session:
        m = await _owned(session, meeting_id, user)
        m.canvas_data = json.dumps(body)
        await session.commit()
    return {"ok": True}


@app.get("/api/meetings/{meeting_id}/audio")
async def get_meeting_audio(meeting_id: int, t: str = ""):
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


class SpeakerMeta(BaseModel):
    meta: dict[str, SpeakerInfo]


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


if os.path.isdir(STATIC_DIR):
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
