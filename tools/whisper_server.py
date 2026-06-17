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
"""

import os
import tempfile

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from faster_whisper import WhisperModel

MODEL = os.environ.get("WHISPER_MODEL", "large-v3")
DEVICE = os.environ.get("WHISPER_DEVICE", "cuda")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "float16")

HF_TOKEN = os.environ.get("HF_TOKEN", "").strip()
DIARIZE_MODEL = os.environ.get("DIARIZE_MODEL", "pyannote/speaker-diarization-3.1")
DIARIZE_DEVICE = os.environ.get("DIARIZE_DEVICE", "cpu")

app = FastAPI(title="dRec whisper server")
model = WhisperModel(MODEL, device=DEVICE, compute_type=COMPUTE)

_diar_pipeline = None


def _diarizer():
    """pyannote 파이프라인 lazy 로드(최초 /diarize 호출 시 1회)."""
    global _diar_pipeline
    if _diar_pipeline is None:
        import torch
        from pyannote.audio import Pipeline

        _diar_pipeline = Pipeline.from_pretrained(DIARIZE_MODEL, use_auth_token=HF_TOKEN)
        _diar_pipeline.to(torch.device(DIARIZE_DEVICE))
    return _diar_pipeline


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL, "device": DEVICE, "diarize": bool(HF_TOKEN)}


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


@app.post("/diarize")
async def diarize(audio: UploadFile = File(...), language: str = Form("ko")):
    """전체 오디오 → faster-whisper 전사(세그먼트) + pyannote 화자분리 → `[화자 N]` 라벨 텍스트.

    세그먼트별 화자는 diarization 타임라인과의 최대 시간겹침으로 배정한다.
    """
    if not HF_TOKEN:
        raise HTTPException(status_code=503, detail="HF_TOKEN 미설정 — diarization 비활성")

    suffix = os.path.splitext(audio.filename or "")[1] or ".audio"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await audio.read())
        path = tmp.name
    try:
        segments, _info = model.transcribe(path, language=language, vad_filter=True)
        segs = [(s.start, s.end, s.text.strip()) for s in segments if s.text.strip()]

        diar = _diarizer()(path)  # pyannote Annotation (turn → speaker)
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
    finally:
        os.unlink(path)
    return {"text": "\n".join(lines), "segments": out_segs}
