"""로컬 Whisper(STT) 래퍼 — 오디오 파일을 텍스트로 전사한다.

Claude 모델은 오디오를 직접 받지 못하므로, 이 1단계는 faster-whisper 가 맡는다.
환경변수로 모델/디바이스를 조정한다(기본은 CPU 친화적 설정).
  DREC_WHISPER_MODEL   : tiny|base|small|medium|large-v3 (기본 small)
  DREC_WHISPER_DEVICE  : cpu|cuda (기본 cpu)
  DREC_WHISPER_COMPUTE : int8|float16|float32 (기본 int8)
"""

import os
from functools import lru_cache

from faster_whisper import WhisperModel

MODEL_SIZE = os.environ.get("DREC_WHISPER_MODEL", "small")
DEVICE = os.environ.get("DREC_WHISPER_DEVICE", "cpu")
COMPUTE = os.environ.get("DREC_WHISPER_COMPUTE", "int8")


@lru_cache(maxsize=1)
def _model() -> WhisperModel:
    # 첫 호출 시 모델을 1회 로드해 재사용한다.
    return WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE)


def transcribe(audio_path: str, language: str = "ko") -> str:
    """오디오 파일을 전사해 전체 텍스트를 반환한다."""
    segments, _info = _model().transcribe(audio_path, language=language, vad_filter=True)
    return "\n".join(seg.text.strip() for seg in segments if seg.text.strip())
