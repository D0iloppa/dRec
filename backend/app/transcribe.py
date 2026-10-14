"""1단계 STT — 오디오 조각을 텍스트로 전사한다(로컬 CPU 또는 원격 GPU).

  DREC_WHISPER_REMOTE_URL : 설정 시 원격 whisper 서버(GPU PC)로 POST.
                            비면 로컬 faster-whisper 로 전사.
  (로컬 모드)
  DREC_WHISPER_MODEL   : tiny|base|small|medium|large-v3 (기본 small)
  DREC_WHISPER_DEVICE  : cpu|cuda (기본 cpu)
  DREC_WHISPER_COMPUTE : int8|float16|float32 (기본 int8)
"""

import json
import os
import threading
import time
from functools import lru_cache
from typing import Callable

from .control import Cancelled, RunControl

# on_progress(stage, progress): stage "transcribe"|"diarize", progress 0..1 또는 None(알 수 없음).
# 워커 스레드에서 호출되므로 콜백은 스레드 안전해야 한다.
ProgressCb = Callable[[str, "float | None"], None]

REMOTE_URL = os.environ.get("DREC_WHISPER_REMOTE_URL", "").strip()
MODEL_SIZE = os.environ.get("DREC_WHISPER_MODEL", "small")
DEVICE = os.environ.get("DREC_WHISPER_DEVICE", "cpu")
COMPUTE = os.environ.get("DREC_WHISPER_COMPUTE", "int8")

DIARIZE_URL = os.environ.get("DREC_WHISPER_DIARIZE_URL", "").strip() or (
    REMOTE_URL.replace("/transcribe", "/diarize") if REMOTE_URL else ""
)


@lru_cache(maxsize=1)
def _model():
    from faster_whisper import WhisperModel
    return WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE)


def _transcribe_local(audio_path: str, language: str, on_progress: "ProgressCb | None" = None) -> str:
    segments, info = _model().transcribe(audio_path, language=language, vad_filter=True)
    texts = []
    for seg in segments:  # generator — 소비하면서 seg.end/duration 으로 진행률 계산
        if seg.text.strip():
            texts.append(seg.text.strip())
        if on_progress and info.duration:
            on_progress("transcribe", min(seg.end / info.duration, 1.0))
    return "\n".join(texts)


def _transcribe_remote(audio_path: str, language: str) -> str:
    import httpx
    with open(audio_path, "rb") as f:
        files = {"audio": (os.path.basename(audio_path), f, "application/octet-stream")}
        resp = httpx.post(REMOTE_URL, files=files, data={"language": language}, timeout=httpx.Timeout(600.0, connect=5.0))
    resp.raise_for_status()
    return (resp.json().get("text") or "").strip()


def transcribe(audio_path: str, language: str = "ko", on_progress: "ProgressCb | None" = None) -> str:
    """오디오 파일을 전사해 텍스트를 반환한다(원격 URL 있으면 원격, 실패 시 로컬 폴백)."""
    if REMOTE_URL:
        try:
            return _transcribe_remote(audio_path, language)
        except Exception as e:
            print(f"[transcribe] 원격 실패 → 로컬 폴백: {type(e).__name__}: {e}", flush=True)
    return _transcribe_local(audio_path, language, on_progress)


def _transcribe_with_timestamps_local(audio_path: str, time_offset: float, language: str) -> dict:
    segments_gen, _info = _model().transcribe(audio_path, language=language, vad_filter=True)
    segs, texts = [], []
    for seg in segments_gen:
        if seg.text.strip():
            segs.append({
                "start": round(seg.start + time_offset, 2),
                "end": round(seg.end + time_offset, 2),
                "text": seg.text.strip(),
            })
            texts.append(seg.text.strip())
    return {"text": " ".join(texts), "segments": segs}


def _transcribe_with_timestamps_remote(audio_path: str, time_offset: float, language: str) -> dict:
    import httpx
    with open(audio_path, "rb") as f:
        files = {"audio": (os.path.basename(audio_path), f, "application/octet-stream")}
        resp = httpx.post(REMOTE_URL, files=files, data={"language": language}, timeout=httpx.Timeout(600.0, connect=5.0))
    resp.raise_for_status()
    data = resp.json()
    text = (data.get("text") or "").strip()
    remote_segs = data.get("segments") or []
    segs = [
        {"start": round(s["start"] + time_offset, 2), "end": round(s["end"] + time_offset, 2), "text": s["text"]}
        for s in remote_segs if s.get("text", "").strip()
    ]
    if not segs and text:
        # 원격 서버가 segments 미지원 → 오프셋만 적용한 단일 세그먼트로 폴백
        segs = [{"start": time_offset, "end": round(time_offset + 5.0, 2), "text": text}]
    return {"text": text, "segments": segs}


def transcribe_with_timestamps(audio_path: str, time_offset: float = 0.0, language: str = "ko") -> dict:
    """오디오 청크를 전사하고 절대 타임스탬프 세그먼트를 반환한다.

    반환: `{"text": "...", "segments": [{"start", "end", "text"}, ...]}`
    time_offset: 이 청크가 시작되는 녹음 내 절대 위치(초).
    """
    if REMOTE_URL:
        try:
            return _transcribe_with_timestamps_remote(audio_path, time_offset, language)
        except Exception as e:
            print(f"[transcribe_ts] 원격 실패 → 로컬 폴백: {type(e).__name__}: {e}", flush=True)
    return _transcribe_with_timestamps_local(audio_path, time_offset, language)


POLL_INTERVAL = 2.0
JOB_DEADLINE = 2 * 3600       # 작업 전체 상한(초)
POLL_ERROR_GRACE = 600.0      # 연속 폴링 실패 허용 시간(초) — GPU 서버 콜드 로드(모델 적재) 중엔 수 분간 응답이 멎는다


def _diarize_sync(audio_path: str, language: str) -> dict:
    """구 GPU 서버 호환: 단일 동기 POST /diarize (진행률 없음)."""
    import httpx
    with open(audio_path, "rb") as f:
        files = {"audio": (os.path.basename(audio_path), f, "application/octet-stream")}
        resp = httpx.post(DIARIZE_URL, files=files, data={"language": language}, timeout=httpx.Timeout(1800.0, connect=5.0))
    resp.raise_for_status()
    return resp.json()


def _remote_cancel(jobs_url: str, job_id: str) -> None:
    """GPU job 취소 요청(best effort). 콜드 로드 중엔 서버가 무응답일 수 있어 백그라운드로 재시도한다."""
    import httpx

    def attempt() -> bool:
        try:
            r = httpx.post(f"{jobs_url}/{job_id}/cancel", timeout=httpx.Timeout(5.0, connect=3.0))
            return r.status_code < 500  # 404(만료/재시작)도 '이미 없음' 이므로 종료
        except httpx.HTTPError:
            return False

    if attempt():
        return

    def retry() -> None:
        deadline = time.monotonic() + POLL_ERROR_GRACE
        while time.monotonic() < deadline:
            time.sleep(5.0)
            if attempt():
                return

    threading.Thread(target=retry, name="gpu-cancel-retry", daemon=True).start()


def _diarize_job(audio_path: str, language: str, on_progress: "ProgressCb | None",
                 ctl: "RunControl | None" = None, transcript: "list | None" = None) -> dict | None:
    """비동기 job API(POST /diarize/jobs + 폴링). 서버가 job API 미지원(404/405)이면 None.

    ctl: job_id/transcript 를 기록하고 stop 이 설정되면 GPU job 을 취소한 뒤 Cancelled.
    transcript: [[start,end,text],…] — 주면 GPU 가 전사를 건너뛴다(재개).
    """
    import httpx
    jobs_url = DIARIZE_URL.rstrip("/") + "/jobs"
    if ctl:
        ctl.check()
    data = {"language": language}
    if transcript:
        data["transcript"] = json.dumps(transcript, ensure_ascii=False)
    with open(audio_path, "rb") as f:
        files = {"audio": (os.path.basename(audio_path), f, "application/octet-stream")}
        resp = httpx.post(jobs_url, files=files, data=data, timeout=httpx.Timeout(600.0, connect=5.0))
    if resp.status_code in (404, 405):
        return None
    resp.raise_for_status()
    job_id = resp.json()["job_id"]
    if ctl:
        ctl.job_id = job_id

    def stop_job() -> None:
        # 일시정지가 전사 직후에 걸리면 마지막 폴링 이후의 전사 결과를 놓칠 수 있어 취소 전에 한 번 더 받아 둔다.
        try:
            st = httpx.get(f"{jobs_url}/{job_id}", timeout=httpx.Timeout(5.0, connect=3.0)).json()
            if ctl.transcript is None and st.get("transcript"):
                ctl.transcript = st["transcript"]
        except Exception:  # noqa: BLE001 — 무응답이어도 취소는 진행
            pass
        _remote_cancel(jobs_url, job_id)
        raise Cancelled()

    deadline = time.monotonic() + JOB_DEADLINE
    failing_since = None
    while time.monotonic() < deadline:
        if ctl:
            if ctl.stop.wait(POLL_INTERVAL):
                stop_job()
        else:
            time.sleep(POLL_INTERVAL)
        try:
            r = httpx.get(f"{jobs_url}/{job_id}", timeout=httpx.Timeout(15.0, connect=5.0))
            r.raise_for_status()  # 404 = 서버 재시작 등으로 job 유실 → 예외(상위에서 폴백)
            st = r.json()
            failing_since = None
        except httpx.HTTPStatusError:
            raise
        except httpx.HTTPError:
            failing_since = failing_since or time.monotonic()
            if time.monotonic() - failing_since >= POLL_ERROR_GRACE:
                raise
            continue
        if ctl and st.get("transcript"):
            ctl.transcript = st["transcript"]
        state = st.get("state")
        if state == "done":
            return st.get("result") or {}
        if state == "error":
            raise RuntimeError(f"원격 diarize 실패: {st.get('error')}")
        if state == "cancelled":
            raise Cancelled()
        if on_progress:
            if state == "diarizing":
                on_progress("diarize", None)
            else:  # queued | transcribing
                on_progress("transcribe", st.get("progress") if state == "transcribing" else 0.0)
    raise TimeoutError("diarize job 시간 초과")


def diarize(audio_path: str, language: str = "ko", on_progress: "ProgressCb | None" = None,
            ctl: "RunControl | None" = None, transcript: "list | None" = None) -> dict:
    """전체 오디오를 화자 분리 전사한다.

    job API 우선(진행률 콜백 지원) → 구 서버(404/405)면 동기 /diarize 로 폴백(진행률 없음).
    반환: `{"text": "[화자 A] …\\n[화자 B] …", "segments": [{start,end,speaker,text}, …]}`.
    ctl(RunControl): 중단 요청 시 Cancelled. 동기 폴백은 중도 취소가 불가 → 끝난 뒤 결과를 버리고 Cancelled.
    transcript: 이전 전사 결과 — job API 서버만 사용(동기 폴백은 전체 재실행).
    """
    if not DIARIZE_URL:
        raise RuntimeError("diarization 비활성 (DREC_WHISPER_DIARIZE_URL 없음)")

    data = _diarize_job(audio_path, language, on_progress, ctl, transcript)
    if data is None:
        if on_progress:
            on_progress("transcribe", None)
        data = _diarize_sync(audio_path, language)
        if ctl:
            ctl.check()
    text = (data.get("text") or "").strip()
    if not text:
        raise RuntimeError("diarization 결과가 비었습니다")
    return {"text": text, "segments": data.get("segments") or []}
