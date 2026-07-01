"""1단계 STT — 오디오 조각을 텍스트로 전사한다(로컬 CPU 또는 원격 GPU).

  DREC_WHISPER_REMOTE_URL : 설정 시 원격 whisper 서버(GPU PC)로 POST.
                            비면 로컬 faster-whisper 로 전사.
  (로컬 모드)
  DREC_WHISPER_MODEL   : tiny|base|small|medium|large-v3 (기본 small)
  DREC_WHISPER_DEVICE  : cpu|cuda (기본 cpu)
  DREC_WHISPER_COMPUTE : int8|float16|float32 (기본 int8)
"""

import os
from functools import lru_cache

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


def _transcribe_local(audio_path: str, language: str) -> str:
    segments, _info = _model().transcribe(audio_path, language=language, vad_filter=True)
    return "\n".join(seg.text.strip() for seg in segments if seg.text.strip())


def _transcribe_remote(audio_path: str, language: str) -> str:
    import httpx
    with open(audio_path, "rb") as f:
        files = {"audio": (os.path.basename(audio_path), f, "application/octet-stream")}
        resp = httpx.post(REMOTE_URL, files=files, data={"language": language}, timeout=httpx.Timeout(600.0, connect=5.0))
    resp.raise_for_status()
    return (resp.json().get("text") or "").strip()


def transcribe(audio_path: str, language: str = "ko") -> str:
    """오디오 파일을 전사해 텍스트를 반환한다(원격 URL 있으면 원격, 실패 시 로컬 폴백)."""
    if REMOTE_URL:
        try:
            return _transcribe_remote(audio_path, language)
        except Exception as e:
            print(f"[transcribe] 원격 실패 → 로컬 폴백: {type(e).__name__}: {e}", flush=True)
    return _transcribe_local(audio_path, language)


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


def diarize(audio_path: str, language: str = "ko") -> dict:
    """전체 오디오를 화자 분리 전사한다.

    반환: `{"text": "[화자 A] …\\n[화자 B] …", "segments": [{start,end,speaker,text}, …]}`.
    """
    if not DIARIZE_URL:
        raise RuntimeError("diarization 비활성 (DREC_WHISPER_DIARIZE_URL 없음)")

    import httpx
    with open(audio_path, "rb") as f:
        files = {"audio": (os.path.basename(audio_path), f, "application/octet-stream")}
        resp = httpx.post(DIARIZE_URL, files=files, data={"language": language}, timeout=httpx.Timeout(1800.0, connect=5.0))
    resp.raise_for_status()
    data = resp.json()
    text = (data.get("text") or "").strip()
    if not text:
        raise RuntimeError("diarization 결과가 비었습니다")
    return {"text": text, "segments": data.get("segments") or []}
