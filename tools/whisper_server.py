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
"""

import os
import tempfile

from fastapi import FastAPI, UploadFile, File, Form
from faster_whisper import WhisperModel

MODEL = os.environ.get("WHISPER_MODEL", "large-v3")
DEVICE = os.environ.get("WHISPER_DEVICE", "cuda")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "float16")

app = FastAPI(title="dRec whisper server")
model = WhisperModel(MODEL, device=DEVICE, compute_type=COMPUTE)


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL, "device": DEVICE}


@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...), language: str = Form("ko")):
    suffix = os.path.splitext(audio.filename or "")[1] or ".audio"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await audio.read())
        path = tmp.name
    try:
        segments, _info = model.transcribe(path, language=language, vad_filter=True)
        text = "\n".join(s.text.strip() for s in segments if s.text.strip())
    finally:
        os.unlink(path)
    return {"text": text}
