"""원격 Whisper 서버 — GPU PC(예: 192.168.0.14)에서 실행하는 전사 마이크로서비스.

dRec 백엔드가 조각(webm 등)을 POST 하면 GPU 로 전사해 텍스트를 돌려준다.
dRec 쪽은 `DREC_WHISPER_REMOTE_URL=http://192.168.0.14:9000/transcribe` 만 설정하면 된다.

GPU PC 준비:
  pip install faster-whisper fastapi "uvicorn[standard]" python-multipart
  # CUDA + cuDNN 설치 필요. ffmpeg 도 PATH 에 있어야 한다.
  set WHISPER_MODEL=large-v3   (Windows: set / PowerShell: $env:WHISPER_MODEL=...)
  uvicorn whisper_server:app --host 0.0.0.0 --port 9000

모델/디바이스 env:
  WHISPER_MODEL   (기본 large-v3)   WHISPER_DEVICE (기본 cuda)   WHISPER_COMPUTE (기본 float16)

화자 분리(/diarize) env:
  HF_TOKEN          : pyannote 게이팅 모델 접근용 HuggingFace 토큰(필수). 없으면 /diarize 비활성.
  DIARIZE_MODEL     : pyannote 파이프라인 (기본 pyannote/speaker-diarization-3.1)
  DIARIZE_DEVICE    : cpu|cuda (기본 cpu — Blackwell torch 이슈 회피. 전사는 별개로 GPU 사용)

메모리(VRAM) 관리 env:
  WHISPER_IDLE_UNLOAD_SEC : 마지막 요청 후 이 시간(초) 동안 요청이 없으면 모델을 내려 VRAM/RAM 반환.
                            (기본 3600 = 1시간, 0 이면 내리지 않음). 모델은 첫 요청 때 자동 로드된다.

선행 기동/유지:
  POST /warmup   : 모델(whisper+pyannote)을 백그라운드로 미리 로드(즉시 반환, 멱등). 콜드 로드는 ~2.5분간 HTTP 무응답.
  POST /caffeine : ttl_sec(60..3600, 기본 900) 동안 유휴 해제를 막는다(녹음 중 유지용).
"""

import asyncio
import gc
import json
import logging
import os
import queue
import shutil
import sys
import tempfile
import threading
import time
import uuid
from contextlib import asynccontextmanager, contextmanager

# Windows 네이티브 실행: pip 로 설치한 nvidia-cublas-cu12 DLL 을 ctranslate2 가 찾도록 경로 등록.
# (cuDNN 은 ctranslate2 휠에 포함. Docker/Linux 에선 해당 없음)
if sys.platform == "win32":
    import site

    for _sp in site.getsitepackages():
        for _sub in ("nvidia/cublas/bin", "nvidia/cuda_nvrtc/bin"):
            _d = os.path.join(_sp, _sub)
            if os.path.isdir(_d):
                os.add_dll_directory(_d)
                os.environ["PATH"] = _d + os.pathsep + os.environ.get("PATH", "")

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request
from faster_whisper import WhisperModel, decode_audio

MODEL = os.environ.get("WHISPER_MODEL", "large-v3")
DEVICE = os.environ.get("WHISPER_DEVICE", "cuda")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "float16")

HF_TOKEN = os.environ.get("HF_TOKEN", "").strip()
DIARIZE_MODEL = os.environ.get("DIARIZE_MODEL", "pyannote/speaker-diarization-3.1")
DIARIZE_DEVICE = os.environ.get("DIARIZE_DEVICE", "cpu")

IDLE_UNLOAD_SEC = int(os.environ.get("WHISPER_IDLE_UNLOAD_SEC", "3600"))

log = logging.getLogger("uvicorn.error")

_model = None
_diar_pipeline = None
_lock = threading.Lock()
_active = 0  # 처리 중인 요청 수 — 처리 중에는 내리지 않는다
_last_used = time.monotonic()
_flag_lock = threading.Lock()  # _warming/_keep_until 전용 — 모델 로드 중에도 막히지 않는 짧은 락
_warming = False              # /warmup 백그라운드 로드 진행 중
_keep_until = 0.0             # monotonic — 이 시각 전에는 유휴 해제 금지(/caffeine)


@contextmanager
def _busy():
    """처리 중 표시(유휴 해제 방지) + 종료 시 사용 시각 갱신. 모델은 로드하지 않는다."""
    global _active, _last_used
    with _lock:
        _active += 1
    try:
        yield
    finally:
        with _lock:
            _active -= 1
            _last_used = time.monotonic()


@contextmanager
def _whisper():
    """모델을 (없으면 로드해서) 빌려주고, 사용 시각을 갱신한다."""
    global _model, _active, _last_used
    with _lock:
        if _model is None:
            t0 = time.monotonic()
            _model = WhisperModel(MODEL, device=DEVICE, compute_type=COMPUTE)
            log.info("whisper 모델 로드: %s (%.1fs)", MODEL, time.monotonic() - t0)
        _active += 1
        model = _model
    try:
        yield model
    finally:
        with _lock:
            _active -= 1
            _last_used = time.monotonic()


def _diarizer():
    """pyannote 파이프라인 lazy 로드(최초 /diarize 호출 시 1회, 유휴 해제 후 재로드)."""
    global _diar_pipeline
    with _lock:
        if _diar_pipeline is None:
            import torch
            from pyannote.audio import Pipeline

            _diar_pipeline = Pipeline.from_pretrained(DIARIZE_MODEL, use_auth_token=HF_TOKEN)
            _diar_pipeline.to(torch.device(DIARIZE_DEVICE))
        return _diar_pipeline


def _unload_if_idle():
    global _model, _diar_pipeline
    with _lock:
        if _active or (_model is None and _diar_pipeline is None):
            return
        if time.monotonic() < _keep_until:  # /caffeine 유지 구간
            return
        idle = time.monotonic() - _last_used
        if idle < IDLE_UNLOAD_SEC:
            return
        _model = None
        _diar_pipeline = None
    gc.collect()
    log.info("유휴 %.0f분 — 모델 해제(VRAM 반환)", idle / 60)


async def _idle_watcher():
    while True:
        await asyncio.sleep(60)
        _unload_if_idle()


@asynccontextmanager
async def _lifespan(_app):
    task = asyncio.create_task(_idle_watcher()) if IDLE_UNLOAD_SEC > 0 else None
    threading.Thread(target=_worker, name="diarize-worker", daemon=True).start()  # job 워커(단일)
    yield
    if task:
        task.cancel()


app = FastAPI(title="dRec whisper server", lifespan=_lifespan)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": MODEL,
        "device": DEVICE,
        "diarize": bool(HF_TOKEN),
        "loaded": _model is not None,
        "idle_sec": round(time.monotonic() - _last_used),
        "idle_unload_sec": IDLE_UNLOAD_SEC,
        "diarize_loaded": _diar_pipeline is not None,
        "warming": _warming,
        "caffeine_sec": max(0, round(_keep_until - time.monotonic())),
    }


def _warm() -> None:
    global _warming
    try:
        with _whisper():  # 로드(필요 시) + 사용 시각 갱신
            pass
        if HF_TOKEN:
            _diarizer()
    except Exception as e:  # noqa: BLE001 — 백그라운드 스레드: 로그만 남긴다
        log.warning("warmup 실패: %s: %s", type(e).__name__, e)
    finally:
        with _flag_lock:
            _warming = False


@app.post("/warmup")
def warmup():
    """모델 선행 로드. 즉시 반환 — 콜드 로드(~2.5분) 동안 HTTP 가 멎을 수 있으니 호출자는 응답을 기다리지 않는다."""
    global _warming, _last_used
    with _flag_lock:
        if _warming:
            return {"started": False}
        if _model is not None and (_diar_pipeline is not None or not HF_TOKEN):
            _last_used = time.monotonic()  # 이미 로드됨 — 유휴 타이머만 갱신
            return {"started": False}
        _warming = True
    threading.Thread(target=_warm, name="warmup", daemon=True).start()
    return {"started": True}


@app.post("/caffeine")
async def caffeine(request: Request):
    """ttl_sec(JSON 또는 form, 기본 900, 60..3600) 동안 유휴 해제를 막는다. 겹치면 더 긴 쪽."""
    global _keep_until
    ttl = 900
    try:
        if "json" in request.headers.get("content-type", ""):
            body = await request.json()
        else:
            body = dict(await request.form())
        ttl = int(float(body.get("ttl_sec", 900)))
    except Exception:  # noqa: BLE001 — 본문이 없거나 잘못되면 기본값
        pass
    ttl = max(60, min(3600, ttl))
    with _flag_lock:
        _keep_until = max(_keep_until, time.monotonic() + ttl)
        remain = round(_keep_until - time.monotonic())
    return {"caffeine_sec": remain}


@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...), language: str = Form("ko")):
    suffix = os.path.splitext(audio.filename or "")[1] or ".audio"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await audio.read())
        path = tmp.name
    try:
        with _whisper() as model:
            segments_gen, _info = model.transcribe(path, language=language, vad_filter=True)
            segs = [(round(s.start, 2), round(s.end, 2), s.text.strip()) for s in segments_gen if s.text.strip()]
    finally:
        os.unlink(path)
    return {
        "text": "\n".join(t for _, _, t in segs),
        "segments": [{"start": s, "end": e, "text": t} for s, e, t in segs],
    }


class _Cancelled(Exception):
    """job 취소 요청이 관측됨 — 전사 세그먼트 사이 또는 pyannote hook 에서 발생."""


def _diarize_file(path: str, language: str, on_progress=None, cancel=None, transcript=None, on_transcript=None) -> dict:
    """전사(세그먼트) + pyannote 화자분리 → `{text, segments}`. /diarize 와 job 워커가 공유.

    on_progress(state, progress, duration): "transcribing"(progress=s.end/duration) → "diarizing"(None).
    cancel: threading.Event — 설정되면 _Cancelled (전사: 세그먼트마다, 화자분리: pyannote hook 에서 확인).
    transcript: [[start,end,text],…] 가 주어지면 전사를 건너뛰고 화자분리·화자배정만 수행.
    on_transcript(segs): 전사가 끝난 직후(화자분리 시작 전) 원시 세그먼트 전달 — 일시정지 체크포인트용.
    """
    def check():
        if cancel is not None and cancel.is_set():
            raise _Cancelled()

    check()
    # 화자분리까지 끝날 때까지 '사용 중' 으로 잡아 유휴 해제를 막는다 (전사를 건너뛰면 whisper 는 로드하지 않는다)
    with (_busy() if transcript is not None else _whisper()) as model:
        duration = None
        if transcript is not None:
            segs = [(float(a), float(b), str(t)) for a, b, t in transcript]
        else:
            segments, info = model.transcribe(path, language=language, vad_filter=True)
            duration = info.duration
            segs = []
            for s in segments:  # generator — 소비하면서 진행률 보고
                check()
                if s.text.strip():
                    segs.append((s.start, s.end, s.text.strip()))
                if on_progress and info.duration:
                    on_progress("transcribing", min(s.end / info.duration, 1.0), info.duration)
            if on_transcript:
                on_transcript([[round(a, 2), round(b, 2), t] for a, b, t in segs])
        check()

        # 오디오는 PyAV(faster-whisper)로 디코딩해 파형으로 넘긴다 — torchaudio 파일 백엔드
        # (Windows 에선 ffmpeg 버전 호환 문제)에 의존하지 않기 위함.
        import torch

        if on_progress and duration is not None:
            on_progress("diarizing", None, duration)
        audio = decode_audio(path, sampling_rate=16000)
        if duration is None:  # 전사를 건너뛴 경우 길이는 디코딩 결과에서
            duration = len(audio) / 16000.0
            if on_progress:
                on_progress("diarizing", None, duration)

        wav = torch.from_numpy(audio).unsqueeze(0)
        kwargs = {}
        if cancel is not None:
            def hook(*_a, **_k):  # pyannote 3.1: hook(step_name, artifact, file=, total=, completed=) — 시그니처에 의존하지 않는다
                check()
            kwargs["hook"] = hook
        diar = _diarizer()({"waveform": wav, "sample_rate": 16000}, **kwargs)  # pyannote Annotation (turn → speaker)
        turns = [(t.start, t.end, spk) for t, _, spk in diar.itertracks(yield_label=True)]

    def speaker_of(start: float, end: float) -> str:
        best, best_ov = None, 0.0
        for ts, te, spk in turns:
            ov = max(0.0, min(end, te) - max(start, ts))
            if ov > best_ov:
                best, best_ov = spk, ov
        return best or "UNK"

    # 원시 화자 라벨(SPEAKER_00…) → 등장 순서대로 화자 A·B·C…
    label_map: dict[str, str] = {}

    def label(spk: str) -> str:
        if spk not in label_map:
            label_map[spk] = chr(ord("A") + len(label_map))  # 0→A,1→B…
        return label_map[spk]

    # segments: 자막 싱킹용 구간별 타임스탬프(절대시간) + 화자 + 텍스트.
    # lines: 회의록/검색용 — 같은 화자 연속 구간을 묶은 표시 텍스트.
    out_segs = []
    lines, cur_spk, cur_text = [], None, []
    for start, end, text in segs:
        spk_label = label(speaker_of(start, end))
        out_segs.append({"start": round(start, 2), "end": round(end, 2), "speaker": f"화자 {spk_label}", "text": text})
        if spk_label != cur_spk:
            if cur_text:
                lines.append(f"[{cur_spk}] " + " ".join(cur_text))
            cur_spk, cur_text = spk_label, [text]
        else:
            cur_text.append(text)
    if cur_text:
        lines.append(f"[{cur_spk}] " + " ".join(cur_text))
    return {"text": "\n".join(lines), "segments": out_segs}


@app.post("/diarize")
async def diarize(audio: UploadFile = File(...), language: str = Form("ko")):
    """[동기·호환용] 전체 오디오 → 전사 + 화자분리를 한 요청 안에서 수행. 진행률은 /diarize/jobs 사용.

    세그먼트별 화자는 diarization 타임라인과의 최대 시간겹침으로 배정한다.
    """
    if not HF_TOKEN:
        raise HTTPException(status_code=503, detail="HF_TOKEN 미설정 — diarization 비활성")

    suffix = os.path.splitext(audio.filename or "")[1] or ".audio"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await audio.read())
        path = tmp.name
    try:
        return _diarize_file(path, language)
    finally:
        os.unlink(path)


# ── 비동기 job API ────────────────────────────────────────────────────────────
# GPU 는 직렬 자원 → 프로세스 내 단일 워커 스레드가 큐를 순서대로 처리한다.
# 상태: queued → transcribing(progress 0..1) → diarizing(progress null) → done | error | cancelled
# (transcript 필드를 주면 전사를 건너뛰고 바로 diarizing)
# 워커는 _diarize_file → _whisper() 로 job 전 구간 모델을 '사용 중' 으로 잡으므로 유휴 해제가 끼어들지 않는다.
JOB_TTL = int(os.environ.get("JOB_TTL_SEC", "3600"))  # 끝난 job 보관 시간

_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()
_queue: "queue.Queue[str]" = queue.Queue()


def _prune_jobs() -> None:
    now = time.time()
    with _jobs_lock:
        for jid in [j for j, v in _jobs.items() if v["state"] in ("done", "error", "cancelled") and now - v["finished_at"] > JOB_TTL]:
            del _jobs[jid]


def _worker() -> None:
    while True:
        jid = _queue.get()
        job = _jobs.get(jid)
        if job is None:
            continue
        with _jobs_lock:
            if job["state"] == "cancelled":  # 대기 중 취소됨(파일은 취소 시점에 정리)
                continue
            job["state"], job["progress"] = ("diarizing", None) if job["given"] is not None else ("transcribing", 0.0)

        def on_progress(state: str, progress, duration):
            job["state"], job["progress"], job["duration"] = state, progress, duration

        def on_transcript(segs):
            job["transcript"] = segs

        try:
            if job["given"] is not None:
                job["transcript"] = job["given"]
            job["result"] = _diarize_file(job["path"], job["language"], on_progress,
                                          cancel=job["cancel"], transcript=job["given"], on_transcript=on_transcript)
            job["state"], job["progress"] = "done", 1.0
        except _Cancelled:
            job["state"], job["progress"] = "cancelled", None
        except Exception as e:  # noqa: BLE001 — 에러를 job 상태로 노출
            job["state"], job["error"] = "error", f"{type(e).__name__}: {e}"
        finally:
            job["finished_at"] = time.time()
            try:
                os.unlink(job["path"])
            except OSError:
                pass
            _prune_jobs()


@app.post("/diarize/jobs")
async def diarize_job_create(audio: UploadFile = File(...), language: str = Form("ko"), transcript: str = Form("")):
    """transcript(JSON `[[start,end,text],…]`, 선택): 주어지면 전사를 건너뛰고 화자분리·배정만 수행(재개용)."""
    if not HF_TOKEN:
        raise HTTPException(status_code=503, detail="HF_TOKEN 미설정 — diarization 비활성")
    given = None
    if transcript.strip():
        try:
            given = [[float(a), float(b), str(t)] for a, b, t in json.loads(transcript)]
        except (ValueError, TypeError) as e:
            raise HTTPException(status_code=400, detail=f"transcript 형식 오류: {e}")
    suffix = os.path.splitext(audio.filename or "")[1] or ".audio"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        shutil.copyfileobj(audio.file, tmp, length=1024 * 1024)
        path = tmp.name
    jid = uuid.uuid4().hex
    with _jobs_lock:
        _jobs[jid] = {"state": "queued", "progress": None, "path": path, "language": language,
                      "duration": None, "result": None, "error": None, "finished_at": 0.0,
                      "cancel": threading.Event(), "given": given, "transcript": None}
    _queue.put(jid)
    _prune_jobs()
    return {"job_id": jid}


@app.get("/diarize/jobs/{job_id}")
def diarize_job_get(job_id: str):
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found (만료 또는 서버 재시작)")
    out = {"state": job["state"], "progress": job["progress"], "duration": job["duration"]}
    if job["transcript"] is not None:  # 전사 완료 후(화자분리 중/취소/오류 포함) — 클라이언트가 체크포인트로 보관
        out["transcript"] = job["transcript"]
    if job["state"] == "done":
        out["result"] = job["result"]
    if job["state"] == "error":
        out["error"] = job["error"]
    return out


@app.post("/diarize/jobs/{job_id}/cancel")
def diarize_job_cancel(job_id: str):
    """queued → 즉시 cancelled. 진행 중 → 플래그만 세우고 워커가 다음 확인 지점에서 cancelled 로 전이. 끝난 job 은 무해."""
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="job not found (만료 또는 서버 재시작)")
        if job["state"] in ("done", "error", "cancelled"):
            return {"state": job["state"]}
        job["cancel"].set()
        if job["state"] == "queued":
            job["state"], job["finished_at"] = "cancelled", time.time()
            try:
                os.unlink(job["path"])
            except OSError:
                pass
        return {"state": job["state"]}
