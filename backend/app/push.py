"""Web Push(VAPID) 발송 — 파이프라인 단계 완료 알림을 회의 소유자의 구독 기기들에 보낸다.

설계: 파이프라인은 알림 성패를 절대 모른다. notify*() 는 이벤트 루프에 fire-and-forget 태스크만 만들고,
실제 발송(pywebpush, 동기 requests)은 threadpool 에서 한다. 모든 예외는 여기서 삼킨다.
VAPID 키(DREC_VAPID_*)가 없으면 전부 no-op.
"""

import asyncio
import json
import os

from fastapi.concurrency import run_in_threadpool
from sqlalchemy import delete, select

from .db import Session, Meeting, PushSubscription

TTL_SEC = 24 * 3600
_tasks: set[asyncio.Task] = set()  # 약한 참조만 쥐는 이벤트 루프로부터 태스크를 보호


def _cfg() -> tuple[str, str, str]:
    return (
        os.environ.get("DREC_VAPID_PUBLIC_KEY", "").strip(),
        os.environ.get("DREC_VAPID_PRIVATE_KEY", "").strip(),
        os.environ.get("DREC_VAPID_SUBJECT", "mailto:user5@wellconn.co.kr").strip(),
    )


def enabled() -> bool:
    pub, priv, _ = _cfg()
    return bool(pub and priv and priv != "<change-me>")


def public_key() -> str:
    return _cfg()[0]


def _send_one(sub: dict, payload: str) -> int | None:
    """동기 1건 발송 → 만료(404/410)면 해당 HTTP 코드, 그 외 None. threadpool 에서 호출."""
    from pywebpush import webpush, WebPushException

    _, priv, subject = _cfg()
    try:
        webpush(
            subscription_info={"endpoint": sub["endpoint"], "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}},
            data=payload,
            vapid_private_key=priv,
            vapid_claims={"sub": subject},
            ttl=TTL_SEC,
        )
    except WebPushException as e:
        code = getattr(e.response, "status_code", None)
        if code in (404, 410):
            return code
        print(f"[push] 발송 실패 code={code}: {e}", flush=True)
    except Exception as e:
        print(f"[push] 발송 실패: {e}", flush=True)
    return None


async def _notify(user_id: str, title: str, body: str, url: str, tag: str) -> int:
    """user_id 의 모든 구독에 발송. 성공 시도한 기기 수 반환(테스트 응답용)."""
    if not enabled() or not user_id:
        return 0
    payload = json.dumps({"title": title, "body": body, "url": url, "tag": tag}, ensure_ascii=False)
    async with Session() as session:
        rows = (await session.execute(select(PushSubscription).where(PushSubscription.user_id == user_id))).scalars().all()
        subs = [{"id": r.id, "endpoint": r.endpoint, "p256dh": r.p256dh, "auth": r.auth} for r in rows]
    if not subs:
        return 0
    results = await asyncio.gather(*(run_in_threadpool(_send_one, s, payload) for s in subs))
    dead = [s["id"] for s, code in zip(subs, results) if code in (404, 410)]
    if dead:
        async with Session() as session:
            await session.execute(delete(PushSubscription).where(PushSubscription.id.in_(dead)))
            await session.commit()
    return len(subs) - len(dead)


def _spawn(coro) -> None:
    try:
        t = asyncio.get_running_loop().create_task(coro)
    except RuntimeError:  # 루프 밖 호출 — 알림은 부가 기능이라 포기
        coro.close()
        return
    _tasks.add(t)
    t.add_done_callback(_tasks.discard)


async def _safe(coro) -> None:
    try:
        await coro
    except Exception as e:
        print(f"[push] 무시된 오류: {e}", flush=True)


def notify(user_id: str, title: str, body: str, url: str = "/", tag: str = "drec") -> None:
    """비차단·예외 비전파. 이벤트 루프 스레드에서 호출."""
    if enabled():
        _spawn(_safe(_notify(user_id, title, body, url, tag)))


# 단계 이벤트 → 알림 제목. 본문은 "<회의 제목>".
EVENTS = {
    "uploaded": "업로드 완료",
    "transcribe_done": "전사 완료",
    "diarize_done": "화자 분리 완료",
    "done": "회의록 완료",
    "error": "처리 오류",
    "paused": "일시정지됨",
}


async def _notify_meeting(meeting_id: int, event: str) -> None:
    async with Session() as session:
        m = await session.get(Meeting, meeting_id)
        if not m or not m.user_id:
            return
        user_id, title = m.user_id, (m.title or "").strip() or "제목 없는 회의"
    await _notify(user_id, EVENTS[event], title, f"/m/{meeting_id}", f"meeting-{meeting_id}")


def notify_meeting(meeting_id: int, event: str) -> None:
    """회의 소유자에게 단계 알림. 같은 회의의 알림은 tag 로 기기에서 서로 교체된다."""
    if enabled():
        _spawn(_safe(_notify_meeting(meeting_id, event)))


async def send_test(user_id: str) -> int:
    return await _notify(user_id, "dRec 알림 테스트", "알림이 정상적으로 도착했어요", "/", "drec-test")


# ── API ──────────────────────────────────────────────────────────────────────
from fastapi import APIRouter, Depends, HTTPException, Request  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from .auth import current_user  # noqa: E402

router = APIRouter(prefix="/api/push")


class _Keys(BaseModel):
    p256dh: str
    auth: str


class SubscribeBody(BaseModel):
    endpoint: str
    keys: _Keys


class UnsubscribeBody(BaseModel):
    endpoint: str


@router.get("/vapid-public-key")
async def vapid_public_key(user: str = Depends(current_user)):
    if not enabled():
        raise HTTPException(status_code=503, detail="푸시 알림이 설정되지 않았습니다")
    return {"public_key": public_key()}


@router.post("/subscribe")
async def subscribe(body: SubscribeBody, request: Request, user: str = Depends(current_user)):
    """endpoint 기준 upsert — 같은 기기가 다른 계정으로 재구독하면 소유자가 바뀐다."""
    ua = (request.headers.get("user-agent") or "")[:512]
    async with Session() as session:
        row = (await session.execute(select(PushSubscription).where(PushSubscription.endpoint == body.endpoint))).scalar_one_or_none()
        if row:
            row.user_id, row.p256dh, row.auth, row.user_agent = user, body.keys.p256dh, body.keys.auth, ua
        else:
            session.add(PushSubscription(user_id=user, endpoint=body.endpoint, p256dh=body.keys.p256dh, auth=body.keys.auth, user_agent=ua))
        await session.commit()
    return {"ok": True}


@router.delete("/subscribe")
async def unsubscribe(body: UnsubscribeBody, user: str = Depends(current_user)):
    async with Session() as session:
        await session.execute(delete(PushSubscription).where(PushSubscription.endpoint == body.endpoint, PushSubscription.user_id == user))
        await session.commit()
    return {"ok": True}


@router.post("/test")
async def test_push(user: str = Depends(current_user)):
    if not enabled():
        raise HTTPException(status_code=503, detail="푸시 알림이 설정되지 않았습니다")
    return {"sent": await send_test(user)}
