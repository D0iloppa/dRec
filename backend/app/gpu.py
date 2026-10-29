"""GPU whisper 서버 상태 조회 / 선행 기동(warmup) / 유지(caffeine) 프록시. 브라우저는 GPU 서버에 직접 닿지 않는다."""

import time
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import recwatch
from . import transcribe as tr
from .auth import current_user

router = APIRouter(prefix="/api/gpu", dependencies=[Depends(current_user)])

WARMING_WINDOW = 300.0  # 콜드 로드 중 서버는 ~2.5분 무응답 — warmup 요청 후 이 시간까지는 '깨우는 중' 으로 본다

_warmup_at: float | None = None  # 마지막 warmup 요청 시각(epoch, 프로세스 메모리)


def _base() -> str:
    """GPU 서버 base URL — 기존 env(REMOTE_URL/DIARIZE_URL)에서 scheme://host:port 만 취한다. 미설정이면 ''."""
    p = urlsplit(tr.DIARIZE_URL or tr.REMOTE_URL)
    return f"{p.scheme}://{p.netloc}" if p.netloc else ""


def _age() -> float | None:
    return None if _warmup_at is None else time.time() - _warmup_at


@router.get("/health")
async def gpu_health():
    out = {"reachable": False, "configured": bool(_base()), "loaded": False, "diarize_loaded": False, "warming": False,
           "idle_sec": None, "idle_unload_sec": None, "caffeine_sec": 0,
           "warmup_requested_at": _warmup_at, "warmup_age_sec": _age()}
    base = _base()
    recent = _warmup_at is not None and (_age() or 0) < WARMING_WINDOW
    if not base:
        return out
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(3.0, connect=2.0)) as c:
            r = await c.get(f"{base}/health")
        r.raise_for_status()
        h = r.json()
    except (httpx.HTTPError, ValueError):
        out["warming"] = recent  # 콜드 로드 중 무응답 구간
        return out
    loaded = bool(h.get("loaded"))
    diar = bool(h.get("diarize_loaded", loaded))  # 구 서버는 필드 없음 → loaded 로 대체
    out.update(
        reachable=True, loaded=loaded, diarize_loaded=diar,
        warming=bool(h.get("warming")) or (recent and not (loaded and diar)),
        idle_sec=h.get("idle_sec"), idle_unload_sec=h.get("idle_unload_sec"),
        caffeine_sec=int(h.get("caffeine_sec") or 0),
    )
    return out


async def _post(path: str, **kw) -> dict | None:
    base = _base()
    if not base:
        raise HTTPException(status_code=503, detail="GPU 서버 미설정")
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(5.0, connect=3.0)) as c:
            r = await c.post(f"{base}{path}", **kw)
        r.raise_for_status()
        return r.json()
    except (httpx.HTTPError, ValueError):
        return None  # 로드 중 무응답이거나 구 서버(404) — 호출자는 실패를 치명적으로 보지 않는다


@router.post("/warmup")
async def gpu_warmup():
    global _warmup_at
    _warmup_at = time.time()
    res = await _post("/warmup")
    return {"requested": True, "reachable": res is not None, "started": bool(res and res.get("started"))}


class CaffeineRequest(BaseModel):
    ttl_sec: int = 900


@router.post("/caffeine")
async def gpu_caffeine(req: CaffeineRequest | None = None, user: str = Depends(current_user)):
    recwatch.on_user_activity(user)  # 녹음 화면이 5분마다 보낸다 → 구 클라이언트의 생존 신호(무음 감시)
    res = await _post("/caffeine", json={"ttl_sec": (req or CaffeineRequest()).ttl_sec})
    return {"reachable": res is not None, "caffeine_sec": int((res or {}).get("caffeine_sec") or 0)}
