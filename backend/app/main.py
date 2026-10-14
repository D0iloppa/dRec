import asyncio
import glob
import json
import os
import shutil
import subprocess
import tempfile
import time
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Depends, BackgroundTasks, Request, Header
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy import select, or_, func
from starlette.middleware.gzip import GZipMiddleware

from .transcribe import transcribe, diarize, transcribe_with_timestamps
from .minutes import make_minutes, make_named_transcript
from .db import Session, Meeting, MeetingChunk, User, init_db, recover_interrupted, set_stage, set_progress
from . import control, push
from .control import Cancelled
from .gpu import router as gpu_router
from .auth import current_user, issue_token, user_from_token_str, user_from_header_or_token
from .accounts import init_accounts_db, set_password, verify_login

STATIC_DIR = os.environ.get("DREC_STATIC_DIR", "/app/web/dist")
DATA_DIR = os.environ.get("DREC_DATA_DIR", "/data")

# 세션별 SSE 큐: meeting_id → [Queue, ...]
_session_queues: dict[int, list[asyncio.Queue]] = {}


def _meeting_dir(meeting_id: int) -> str:
    return os.path.join(DATA_DIR, "audio", str(meeting_id))


def _full_audio_path(meeting_id: int) -> str:
    return os.path.join(_meeting_dir(meeting_id), "full.webm")


def _m4a_path(meeting_id: int) -> str:
    return os.path.join(_meeting_dir(meeting_id), "full.m4a")


def _ffmpeg_atomic(src_args: list[str], dst: str, out_args: list[str]) -> None:
    """ffmpeg 결과를 `dst.part` 로 쓴 뒤 rename — 쓰는 도중의 파일이 서빙/has_audio 로 노출되지 않게 한다."""
    tmp = dst + ".part"
    try:
        subprocess.run(["ffmpeg", "-y", *src_args, *out_args, "-f", "webm" if dst.endswith(".webm") else "mp4", tmp],
                       check=True, capture_output=True)
        os.replace(tmp, dst)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _make_full_webm(src_args: list[str], dst: str) -> None:
    _ffmpeg_atomic(src_args, dst, ["-vn", "-c:a", "libopus"])


def _make_m4a(meeting_id: int) -> None:
    dst = _m4a_path(meeting_id)
    if not os.path.isfile(dst):
        _ffmpeg_atomic(["-i", _full_audio_path(meeting_id)], dst,
                       ["-vn", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart"])


def _probe_duration(path: str) -> float | None:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
        return float(out) if out else None
    except Exception as e:
        print(f"[ffprobe] 실패: {e}", flush=True)
        return None


def _save_upload(audio: UploadFile, suffix: str) -> str:
    """업로드를 청크 단위로 디스크에 복사(전체를 메모리에 올리지 않음). 동기 — threadpool 에서 호출."""
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        shutil.copyfileobj(audio.file, tmp, length=1024 * 1024)
        return tmp.name


async def _store_full_audio(meeting_id: int, audio: UploadFile, default_suffix: str) -> None:
    """업로드 원본 → full.webm(원자적 remux) + 길이 DB 저장."""
    os.makedirs(_meeting_dir(meeting_id), exist_ok=True)
    suffix = os.path.splitext(audio.filename or "")[1] or default_suffix
    src = await run_in_threadpool(_save_upload, audio, suffix)
    try:
        await run_in_threadpool(_make_full_webm, ["-i", src], _full_audio_path(meeting_id))
    finally:
        os.unlink(src)
    await _save_duration(meeting_id)


async def _save_duration(meeting_id: int) -> None:
    dur = await run_in_threadpool(_probe_duration, _full_audio_path(meeting_id))
    if dur is not None:
        async with Session() as session:
            m = await session.get(Meeting, meeting_id)
            if m:
                m.audio_duration_sec = dur
                await session.commit()


def _mark_stage(m: Meeting, stage: str) -> None:
    """ORM 객체에 stage 전환 반영(커밋은 호출자). set_stage 의 동기 대응 — 이미 세션을 쥔 엔드포인트용."""
    m.stage = stage
    m.progress = None
    m.stage_started_at = datetime.now(timezone.utc).replace(tzinfo=None)


class _ProgressReporter:
    """threadpool 스레드(diarize/transcribe)에서 호출되는 진행률 콜백 → 이벤트 루프의 DB 쓰기.

    - stage 전환은 `.result()` 로 완료를 기다린다(순서 보장, 드묾).
    - progress 는 fire-and-forget + 스로틀(Δ≥0.01 또는 ≥2s). set_progress 가 WHERE stage=… 로 가드하므로
      늦게 도착해도 다음 stage 를 덮어쓰지 않는다.
    """

    def __init__(self, meeting_id: int, loop: asyncio.AbstractEventLoop, stage: str = "transcribe"):
        self.meeting_id, self.loop, self.stage = meeting_id, loop, stage
        self._last_p: float | None = None
        self._last_t = 0.0

    def __call__(self, stage: str, progress: float | None) -> None:
        try:
            if stage != self.stage:
                prev = self.stage
                self.stage, self._last_p, self._last_t = stage, None, 0.0
                asyncio.run_coroutine_threadsafe(set_stage(self.meeting_id, stage, progress), self.loop).result(timeout=30)
                if prev == "transcribe" and stage == "diarize":
                    self.loop.call_soon_threadsafe(push.notify_meeting, self.meeting_id, "transcribe_done")
                return
            if progress is None:
                return
            now = time.monotonic()
            if self._last_p is not None and progress - self._last_p < 0.01 and now - self._last_t < 2.0:
                return
            self._last_p, self._last_t = progress, now
            asyncio.run_coroutine_threadsafe(set_progress(self.meeting_id, stage, round(progress, 4)), self.loop)
        except Exception as e:  # 진행률은 부가 정보 — 실패가 파이프라인을 깨면 안 됨
            print(f"[progress] 기록 실패: {e}", flush=True)


async def _push_event(meeting_id: int, event: dict) -> None:
    for q in _session_queues.get(meeting_id, []):
        await q.put(event)


app = FastAPI(title="dRec API", version="0.2.0")

app.include_router(gpu_router)
app.include_router(push.router)

class _StaticOptimize:
    """정적 프론트 응답만 gzip 압축 + 해시 에셋 장기 캐시. /api/*(오디오 Range·SSE 포함)는 건드리지 않는다."""

    def __init__(self, app):
        self.app = app
        self.gzip = GZipMiddleware(app, minimum_size=1024)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["path"].startswith("/api/"):
            return await self.app(scope, receive, send)
        if scope["path"].startswith("/assets/"):
            async def cached_send(message):
                if message["type"] == "http.response.start" and message["status"] == 200:
                    message["headers"] = [h for h in message["headers"] if h[0].lower() != b"cache-control"] + [
                        (b"cache-control", b"public, max-age=31536000, immutable")
                    ]
                await send(message)

            return await self.gzip(scope, receive, cached_send)
        return await self.gzip(scope, receive, send)


app.add_middleware(_StaticOptimize)
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
    recovered = await recover_interrupted()
    if recovered:
        print(f"[startup] 처리 중이던 회의 {len(recovered)}건 → paused", flush=True)
        for mid in recovered:  # 회의당 1건
            push.notify_meeting(mid, "paused")
    init_accounts_db()


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


class LoginRequest(BaseModel):
    username: str
    password: str


@app.post("/api/auth/login")
async def auth_login(req: LoginRequest):
    """id/pw 로그인. 계정 생성은 CLI(`-m app.create_account_cli`)로만 — 회원가입 없음."""
    if not verify_login(req.username, req.password):
        raise HTTPException(status_code=401, detail="invalid credentials")
    return {"token": issue_token(req.username), "user_id": req.username}


class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str


@app.post("/api/auth/change-password")
async def auth_change_password(req: ChangePasswordRequest, user: str = Depends(current_user)):
    """로그인 상태에서 본인 비밀번호 변경. 기존 비밀번호 검증 후 덮어쓴다.

    401 대신 400 — 프론트 authedFetch 는 401을 "토큰 무효"로 해석해 자동 로그아웃시키므로,
    기존 비밀번호 오타는 그와 구분해야 한다.
    """
    if not verify_login(user, req.old_password):
        raise HTTPException(status_code=400, detail="invalid credentials")
    set_password(user, req.new_password)
    return {"ok": True}


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


_KST = timezone(timedelta(hours=9))


async def _default_title(session, user: str) -> str:
    """'YYYY-MM-DD n번째 회의' — KST 기준 오늘 이 사용자가 만든 회의 수 + 1. (삭제 시 n 중복 가능: 수용된 한계)"""
    now = datetime.now(_KST)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    n = (await session.execute(
        select(func.count()).select_from(Meeting).where(
            Meeting.user_id == user, Meeting.created_at >= start, Meeting.created_at < start + timedelta(days=1)
        )
    )).scalar_one()
    return f"{start:%Y-%m-%d} {n + 1}번째 회의"


# ── 라이브 녹음 세션 ─────────────────────────────────────────────────────────

@app.post("/api/sessions")
async def create_session(title: str = Form(""), user: str = Depends(current_user)):
    async with Session() as session:
        canvas_id = f"drec-{uuid.uuid4().hex[:16]}"
        title = title.strip() or await _default_title(session, user)
        m = Meeting(title=title, status="recording", user_id=user, canvas_id=canvas_id)
        session.add(m)
        await session.commit()
        await session.refresh(m)
        return {"id": m.id, "canvas_id": m.canvas_id, "title": m.title}


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
    await _store_full_audio(meeting_id, audio, ".webm")
    push.notify_meeting(meeting_id, "uploaded")
    return {"ok": True}


@app.post("/api/sessions/{meeting_id}/finish")
async def finish_session(meeting_id: int, background_tasks: BackgroundTasks, user: str = Depends(current_user)):
    """오디오 업로드 후 호출. 화자분리를 백그라운드에서 시작하고 즉시 리턴."""
    async with Session() as session:
        m = await _owned(session, meeting_id, user)
        live_transcript = await _chunk_transcript(session, meeting_id)
        m.status = "processing"
        _mark_stage(m, "prepare")
        await session.commit()

    background_tasks.add_task(_run_diarization, meeting_id, live_transcript)
    return {"id": meeting_id, "status": "processing"}


async def _chunk_transcript(session, meeting_id: int) -> str:
    chunks = (
        await session.execute(
            select(MeetingChunk).where(MeetingChunk.meeting_id == meeting_id).order_by(MeetingChunk.seq)
        )
    ).scalars().all()
    return "\n".join(c.text for c in chunks if c.text.strip())


async def _apply_stop(meeting_id: int, action: str | None, transcript: list | None = None) -> str | None:
    """일시정지/취소를 DB 에 반영.

    pause  → paused (stage 유지, checkpoint 저장: 전사 결과가 있으면 diarize 단계로 보존).
    cancel → 전사/화자분리면 uploaded(stage=cancelled, 오디오 유지), 회의록이면 transcribed(전사 유지).
    paused 에서의 취소도 같은 경로 — 어느 단계였는지는 checkpoint 로 판단한다.
    """
    async with Session() as session:
        m = await session.get(Meeting, meeting_id)
        if not m:
            return None
        prev = json.loads(m.checkpoint) if m.checkpoint else {}
        is_minutes = m.status == "processing_minutes" or (m.status == "paused" and prev.get("stage") == "minutes")
        if action == "cancel":
            m.checkpoint = ""
            m.progress = None
            if is_minutes:
                m.status = "transcribed"
                _mark_stage(m, "done")
            else:
                m.status = "uploaded"
                _mark_stage(m, "cancelled")
        else:
            stage = "minutes" if is_minutes else ("diarize" if transcript else (m.stage or "prepare"))
            cp = {"stage": stage}
            if transcript and not is_minutes:
                cp["transcript"] = transcript
            m.status = "paused"
            m.checkpoint = json.dumps(cp, ensure_ascii=False)
            m.stage = stage
            m.progress = None
        await session.commit()
        if m.status == "paused":
            push.notify_meeting(meeting_id, "paused")
        return m.status


async def _run_diarization(meeting_id: int, live_transcript: str, auto_minutes: bool = False,
                           resume_transcript: list | None = None) -> None:
    """백그라운드 실행기: 중단 제어(control) 등록 + 일시정지/취소 정리. 실제 작업은 _diarization_steps."""
    ctl = control.begin(meeting_id)
    try:
        async with Session() as session:  # 시작 전에 이미 일시정지/취소/삭제됐다면 실행하지 않는다
            m = await session.get(Meeting, meeting_id)
            if not m or m.status != "processing":
                return
        await _diarization_steps(meeting_id, live_transcript, auto_minutes, resume_transcript, ctl)
    except Cancelled:
        await _apply_stop(meeting_id, ctl.action, ctl.transcript)
    finally:
        control.end(meeting_id, ctl)


async def _diarization_steps(meeting_id: int, live_transcript: str, auto_minutes: bool,
                             resume_transcript: list | None, ctl: "control.RunControl") -> None:
    """prepare(full.webm·길이·m4a) → transcribe → diarize → DB 업데이트 → SSE push.

    stage 는 호출 측(_mark_stage)이 prepare 로 이미 설정해 둔다. status 의미는 불변.
    중단 요청은 단계 경계와 diarize() 안에서 Cancelled 로 올라온다.
    """
    transcript = live_transcript
    segments_json = ""
    full_audio = _full_audio_path(meeting_id)
    loop = asyncio.get_running_loop()

    # full audio 없으면 저장된 청크들을 concat해서 생성 (업로드된 full.webm 이 있으면 건너뜀)
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
                await run_in_threadpool(_make_full_webm, ["-f", "concat", "-safe", "0", "-i", concat_list], full_audio)
                await _save_duration(meeting_id)
                print(f"[diarize] {len(chunks)}개 청크 → full audio concat 완료", flush=True)
            except Exception as e:
                print(f"[diarize] concat 실패: {e}", flush=True)

    if os.path.isfile(full_audio):
        try:
            async with Session() as session:
                have_dur = (await session.get(Meeting, meeting_id)).audio_duration_sec is not None
            if not have_dur:
                await _save_duration(meeting_id)
            await run_in_threadpool(_make_m4a, meeting_id)  # 재생용 경량본 — 실패해도 파이프라인 계속(webm 폴백)
        except Exception as e:
            print(f"[diarize] m4a 생성 실패(무시): {e}", flush=True)

        ctl.check()
        first = "diarize" if resume_transcript else "transcribe"
        await set_stage(meeting_id, first, None if resume_transcript else 0.0)
        reporter = _ProgressReporter(meeting_id, loop, first)
        try:
            result = await run_in_threadpool(diarize, full_audio, "ko", reporter, ctl, resume_transcript)
            transcript = result["text"]
            segments_json = json.dumps(result["segments"], ensure_ascii=False)
        except Cancelled:
            raise
        except Exception as e:
            print(f"[diarize] 실패 → 전체 전사 폴백: {e}", flush=True)
            await set_stage(meeting_id, "transcribe", None)
            reporter = _ProgressReporter(meeting_id, loop)
            try:
                transcript = await run_in_threadpool(transcribe, full_audio, "ko", reporter)
            except Exception as e2:
                print(f"[transcribe] 폴백도 실패: {e2}", flush=True)
            ctl.check()  # 폴백 전사는 중도 취소 불가 — 끝난 뒤 결과를 버린다

    ctl.check()

    async with Session() as session:
        m = await session.get(Meeting, meeting_id)
        if not m:
            return
        if not transcript.strip():
            m.status = "error"
            _mark_stage(m, "error")
            await session.commit()
            push.notify_meeting(meeting_id, "error")
            await _push_event(meeting_id, {"type": "error", "message": "전사 결과가 비었습니다"})
            return
        m.transcript = transcript
        m.segments = segments_json
        m.status = "transcribed"
        _mark_stage(m, "done")
        await session.commit()
    push.notify_meeting(meeting_id, "diarize_done")

    segments = json.loads(segments_json) if segments_json else []
    await _push_event(meeting_id, {"type": "diarize", "segments": segments})

    if auto_minutes:
        # 화면 없는 워치 클라이언트용: 전사 성공 시 이어서 회의록까지 자동 생성 (speaker_meta 없음)
        async with Session() as session:
            m = await session.get(Meeting, meeting_id)
            _mark_stage(m, "minutes")  # status 는 기존대로 transcribed 유지
            await session.commit()
        await _run_minutes(meeting_id, transcript, segments, {})


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
        _mark_stage(m, "minutes")
        transcript = m.transcript
        segments = json.loads(m.segments) if m.segments else []
        await session.commit()

    background_tasks.add_task(_run_minutes, meeting_id, transcript, segments, meta)
    return {"id": meeting_id, "status": "processing_minutes"}


async def _run_minutes(meeting_id: int, transcript: str, segments: list, speaker_meta: dict) -> None:
    """백그라운드: named_transcript 생성 + AI 회의록 생성 → DB 업데이트 → SSE push. 일시정지/취소 시 CLI 를 죽인다."""
    ctl = control.begin(meeting_id)
    try:
        async with Session() as session:  # 시작 전에 이미 일시정지/취소/삭제됐다면 실행하지 않는다
            m = await session.get(Meeting, meeting_id)
            if not m or m.stage != "minutes" or m.status not in ("processing_minutes", "transcribed"):
                return
        named = await run_in_threadpool(make_named_transcript, transcript, segments, speaker_meta)
        minutes = await run_in_threadpool(make_minutes, named, 300, ctl)
        ctl.check()
        async with Session() as session:
            m = await session.get(Meeting, meeting_id)
            if not m:
                return
            m.named_transcript = named
            m.minutes = minutes
            m.status = "done"
            _mark_stage(m, "done")
            await session.commit()
        push.notify_meeting(meeting_id, "done")
        await _push_event(meeting_id, {"type": "done"})
    except Cancelled:
        await _apply_stop(meeting_id, ctl.action)
    except Exception as e:
        print(f"[minutes] meeting={meeting_id} 실패: {e}", flush=True)
        async with Session() as session:
            m = await session.get(Meeting, meeting_id)
            if m:
                m.status = "error"
                _mark_stage(m, "error")
                await session.commit()
        push.notify_meeting(meeting_id, "error")
        await _push_event(meeting_id, {"type": "error", "message": str(e)})
    finally:
        control.end(meeting_id, ctl)


def _prepare_transcription(m: Meeting) -> str:
    """전사(화자분리) 재실행 준비: 기존 결과 초기화 + status=processing. 커밋은 호출자가 담당. live_transcript(폴백용) 반환."""
    live_transcript = m.transcript
    m.status = "processing"
    _mark_stage(m, "prepare")
    m.segments = ""
    m.named_transcript = ""
    m.minutes = ""
    m.checkpoint = ""
    return live_transcript


@app.post("/api/meetings/{meeting_id}/regenerate")
async def regenerate_meeting(meeting_id: int, background_tasks: BackgroundTasks, user: str = Depends(current_user)):
    """원천 오디오 기반으로 화자분리·회의록 전체 재실행."""
    async with Session() as session:
        m = await _owned(session, meeting_id, user)
        if not os.path.isfile(_full_audio_path(meeting_id)):
            raise HTTPException(status_code=404, detail="원천 오디오 없음 — 재생성 불가")
        live_transcript = _prepare_transcription(m)
        await session.commit()

    background_tasks.add_task(_run_diarization, meeting_id, live_transcript)
    return {"id": meeting_id, "status": "processing"}


@app.post("/api/meetings/{meeting_id}/transcribe")
async def transcribe_meeting(meeting_id: int, background_tasks: BackgroundTasks, user: str = Depends(current_user)):
    """업로드 확정(uploaded) 후 전사 실행, 또는 실패한 전사의 수동 재시도."""
    async with Session() as session:
        m = await _owned(session, meeting_id, user)
        if m.status not in ("uploaded", "transcribed", "error"):
            raise HTTPException(status_code=400, detail=f"전사 가능한 상태가 아님 (현재: {m.status})")
        if not os.path.isfile(_full_audio_path(meeting_id)):
            raise HTTPException(status_code=404, detail="원천 오디오 없음")
        live_transcript = _prepare_transcription(m)
        await session.commit()

    background_tasks.add_task(_run_diarization, meeting_id, live_transcript)
    return {"id": meeting_id, "status": "processing"}


# ── 일시정지 / 재개 / 취소 ───────────────────────────────────────────────────

async def _stop_request(meeting_id: int, user: str, action: str) -> dict:
    allowed = ("processing", "processing_minutes") + (("paused",) if action == "cancel" else ())
    async with Session() as session:
        m = await _owned(session, meeting_id, user)
        if m.status not in allowed:
            raise HTTPException(status_code=400, detail=f"{action} 불가한 상태 (현재: {m.status})")
        status = m.status
    ctl = control.get(meeting_id) if status != "paused" else None
    if ctl is not None:
        ctl.request(action)  # 워커가 정리를 마치면 status 가 바뀐다(폴링으로 반영)
        return {"id": meeting_id, "status": status, "pending_action": ctl.action}
    # 살아있는 워커가 없다(paused 이거나 재시작 직후 등) → 직접 반영
    return {"id": meeting_id, "status": await _apply_stop(meeting_id, action), "pending_action": None}


@app.post("/api/meetings/{meeting_id}/pause")
async def pause_meeting(meeting_id: int, user: str = Depends(current_user)):
    """현재 단계를 즉시 멈추고 완료된 단계의 결과는 보존. 재개는 중단된 단계를 처음부터 다시."""
    return await _stop_request(meeting_id, user, "pause")


@app.post("/api/meetings/{meeting_id}/cancel")
async def cancel_meeting(meeting_id: int, user: str = Depends(current_user)):
    """멈추고 되돌린다: 전사/화자분리 → uploaded(오디오 유지), 회의록 → transcribed(전사 유지)."""
    return await _stop_request(meeting_id, user, "cancel")


@app.post("/api/meetings/{meeting_id}/resume")
async def resume_meeting(meeting_id: int, background_tasks: BackgroundTasks, user: str = Depends(current_user)):
    async with Session() as session:
        m = await _owned(session, meeting_id, user)
        if m.status != "paused":
            raise HTTPException(status_code=400, detail=f"재개 불가한 상태 (현재: {m.status})")
        cp = json.loads(m.checkpoint) if m.checkpoint else {}
        stage = cp.get("stage")
        if stage == "minutes":
            if not m.transcript:
                raise HTTPException(status_code=400, detail="전사 결과 없음 — 재개 불가")
            transcript = m.transcript
            segments = json.loads(m.segments) if m.segments else []
            meta = json.loads(m.speaker_meta) if m.speaker_meta else {}
            m.status = "processing_minutes"
            _mark_stage(m, "minutes")
            m.checkpoint = ""
            await session.commit()
            background_tasks.add_task(_run_minutes, meeting_id, transcript, segments, meta)
            return {"id": meeting_id, "status": "processing_minutes"}

        if not os.path.isfile(_full_audio_path(meeting_id)):
            raise HTTPException(status_code=404, detail="원천 오디오 없음 — 재개 불가")
        saved = cp.get("transcript") if stage == "diarize" else None
        live_transcript = m.transcript or await _chunk_transcript(session, meeting_id)
        m.status = "processing"
        _mark_stage(m, "diarize" if saved else "prepare")
        m.checkpoint = ""
        await session.commit()
    background_tasks.add_task(_run_diarization, meeting_id, live_transcript, False, saved)
    return {"id": meeting_id, "status": "processing"}


# ── 파일 업로드(기존 녹음) ───────────────────────────────────────────────────

@app.post("/api/uploads")
async def upload_recording(
    background_tasks: BackgroundTasks,
    audio: UploadFile = File(...),
    title: str | None = Form(None),
    auto_minutes: bool = Form(False),
    user: str = Depends(current_user),
):
    """업로드 확정 단계: meeting 생성 + 오디오 remux까지만 동기 수행하고 즉시 반환, 전사는 백그라운드로 이어감."""
    async with Session() as session:
        m = Meeting(title=(title or "").strip() or await _default_title(session, user), status="processing", user_id=user)
        session.add(m)
        await session.commit()
        await session.refresh(m)
        meeting_id = m.id

    await _store_full_audio(meeting_id, audio, ".audio")
    # remux 실패 시 예외가 그대로 전파되어 500 응답 — meeting row는 status="processing"인 채 고아로 남는다.
    # 업로드 확정 실패이므로 클라이언트가 재업로드해야 하며, 고아 row/파일 정리는 이번 범위 밖(운영 정리 대상).

    async with Session() as session:
        m = await session.get(Meeting, meeting_id)
        m.status = "uploaded"
        await session.commit()
    push.notify_meeting(meeting_id, "uploaded")

    background_tasks.add_task(_start_transcription_after_upload, meeting_id, auto_minutes)
    return {"id": meeting_id, "status": "uploaded"}


async def _start_transcription_after_upload(meeting_id: int, auto_minutes: bool) -> None:
    """업로드 백그라운드 태스크: status=processing 커밋 후 _run_diarization 실행 (uploaded 중복 전사 방지용)."""
    async with Session() as session:
        m = await session.get(Meeting, meeting_id)
        if not m:
            return
        m.status = "processing"
        _mark_stage(m, "prepare")
        await session.commit()
    await _run_diarization(meeting_id, "", auto_minutes)


@app.post("/api/process")
async def process(audio: UploadFile = File(...), user: str = Depends(current_user)):
    """[DEPRECATED] 오디오 파일 업로드 → 화자분리 전사를 한 요청 안에서 동기 수행 (즉시 done 또는 transcribed 상태).
    신규 클라이언트는 /api/uploads(즉시 반환 + 백그라운드 전사)를 사용할 것. 하위호환을 위해 유지."""
    async with Session() as session:
        m = Meeting(title=audio.filename or "audio", status="processing", user_id=user)
        session.add(m)
        await session.commit()
        await session.refresh(m)
        meeting_id = m.id

    await _store_full_audio(meeting_id, audio, ".audio")
    full_audio = _full_audio_path(meeting_id)

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
            _mark_stage(m, "error")
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


def _checkpoint_view(raw: str | None) -> dict | None:
    """체크포인트 요약(전사 본문은 싣지 않는다): {"stage", "has_transcript"}."""
    if not raw:
        return None
    cp = json.loads(raw)
    return {"stage": cp.get("stage"), "has_transcript": bool(cp.get("transcript"))}


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
            "has_audio": os.path.isfile(_full_audio_path(m.id)),  # full.webm 은 atomic rename 으로만 생김 → 완성본만 true
            "has_m4a": os.path.isfile(_m4a_path(m.id)),
            "audio_duration_sec": m.audio_duration_sec,
            "stage": m.stage,
            "checkpoint": _checkpoint_view(m.checkpoint),
            "pending_action": getattr(control.get(m.id), "action", None),
            "progress": m.progress if m.stage == "transcribe" else None,
            "stage_started_at": (m.stage_started_at.isoformat() + "Z") if m.stage_started_at else None,
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
async def get_meeting_audio(meeting_id: int, t: str = "", format: str = "webm", authorization: str = Header("")):
    """재생용 오디오. inline + Range 지원(FileResponse, starlette>=0.39 — fastapi 0.115.5 는 >=0.40).
    인증: `Authorization: Bearer`(우선, 서버 간 호출) 또는 `?t=`(<audio src>)."""
    user = user_from_header_or_token(authorization, t)
    async with Session() as session:
        await _owned(session, meeting_id, user)
    if format == "m4a":
        path, mime, ext = _m4a_path(meeting_id), "audio/mp4", "m4a"
    elif format == "webm":
        path, mime, ext = _full_audio_path(meeting_id), "audio/webm", "webm"
    else:
        raise HTTPException(status_code=400, detail="format must be webm|m4a")
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="no audio")
    return FileResponse(path, media_type=mime, filename=f"meeting-{meeting_id}.{ext}", content_disposition_type="inline")


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
    # SPA 딥링크(/m/{id} — 푸시 알림 클릭·새로고침)는 index.html 로 돌려준다.
    @app.get("/m/{_path:path}", include_in_schema=False)
    async def spa_fallback(_path: str):
        return FileResponse(os.path.join(STATIC_DIR, "index.html"))

    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
