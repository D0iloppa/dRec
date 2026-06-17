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

# 화자 분리(diarization) 엔드포인트 — 원격 whisper 서버의 /diarize 로 유도(없으면 비활성).
DIARIZE_URL = os.environ.get("DREC_WHISPER_DIARIZE_URL", "").strip() or (
    REMOTE_URL.replace("/transcribe", "/diarize") if REMOTE_URL else ""
)


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


def diarize(audio_path: str, language: str = "ko") -> dict:
    """전체 오디오를 화자 분리 전사한다.

    반환: `{"text": "[화자 A] …\\n[화자 B] …", "segments": [{start,end,speaker,text}, …]}`.
      - text: 회의록/검색용(같은 화자 연속 구간 묶음)
      - segments: 자막 싱킹용 구간별 절대 타임스탬프
    원격 서버가 없거나 실패하면 RuntimeError(호출부가 일반 전사로 폴백).
    """
    if not DIARIZE_URL:
        raise RuntimeError("diarization 비활성 (DREC_WHISPER_DIARIZE_URL 없음)")

    import httpx

    with open(audio_path, "rb") as f:
        files = {"audio": (os.path.basename(audio_path), f, "application/octet-stream")}
        resp = httpx.post(DIARIZE_URL, files=files, data={"language": language}, timeout=1800)
    resp.raise_for_status()
    data = resp.json()
    text = (data.get("text") or "").strip()
    if not text:
        raise RuntimeError("diarization 결과가 비었습니다")
    return {"text": text, "segments": data.get("segments") or []}
