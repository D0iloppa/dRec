"""1단계 STT — 오디오 조각을 텍스트로 전사한다(로컬 CPU 또는 원격 GPU).

Claude 모델은 오디오를 직접 받지 못하므로 이 단계는 faster-whisper 가 맡는다.

  DREC_WHISPER_REMOTE_URL : 설정 시 원격 whisper 서버(GPU PC)로 POST.
                            비면 로컬 faster-whisper 로 전사.
  (로컬 모드)
  DREC_WHISPER_MODEL   : tiny|base|small|medium|large-v3 (기본 small)
  DREC_WHISPER_DEVICE  : cpu|cuda (기본 cpu)
  DREC_WHISPER_COMPUTE : int8|float16|float32 (기본 int8)

원격 서버는 `tools/whisper_server.py`(GPU PC용) 참고. 계약: multipart 로
`audio` 파일 + `language` 필드를 받아 `{"text": "..."}` JSON 반환.
"""

import os
from functools import lru_cache

REMOTE_URL = os.environ.get("DREC_WHISPER_REMOTE_URL", "").strip()
MODEL_SIZE = os.environ.get("DREC_WHISPER_MODEL", "small")
DEVICE = os.environ.get("DREC_WHISPER_DEVICE", "cpu")
COMPUTE = os.environ.get("DREC_WHISPER_COMPUTE", "int8")


@lru_cache(maxsize=1)
def _model():
    from faster_whisper import WhisperModel  # 원격 모드면 import 자체가 불필요

    return WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE)


def _transcribe_local(audio_path: str, language: str) -> str:
    segments, _info = _model().transcribe(audio_path, language=language, vad_filter=True)
    return "\n".join(seg.text.strip() for seg in segments if seg.text.strip())


def _transcribe_remote(audio_path: str, language: str) -> str:
    import httpx

    with open(audio_path, "rb") as f:
        files = {"audio": (os.path.basename(audio_path), f, "application/octet-stream")}
        resp = httpx.post(REMOTE_URL, files=files, data={"language": language}, timeout=600)
    resp.raise_for_status()
    return (resp.json().get("text") or "").strip()


def transcribe(audio_path: str, language: str = "ko") -> str:
    """오디오 파일을 전사해 텍스트를 반환한다(원격 URL 있으면 원격, 없으면 로컬)."""
    if REMOTE_URL:
        return _transcribe_remote(audio_path, language)
    return _transcribe_local(audio_path, language)
