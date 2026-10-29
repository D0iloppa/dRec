"""녹음 무음 감시 — 녹음 중(finish 전) 세션에 조각이 N분 끊겼는데 클라이언트는 살아 있으면 Web Push 로 알린다.

배경(2026-10-29, meeting 80): iPad Safari 의 마이크 트랙이 시작 1초 만에 죽었지만 페이지는 살아 caffeine·캔버스
저장만 계속 보냈다. 서버는 그 상태를 알 수 있었는데도 아무도 몰랐다 → 이 감시가 그 신호를 사용자에게 돌려준다.

설계(가장 단순한 형태):
- 상태는 프로세스 메모리(재시작 시 소실 → 다시 들어오는 조각/하트비트부터 재추적, 기준점은 재시작 시각이라 알림이
  최대 N분 늦어질 뿐 오탐은 없다). DB 스키마 변경 없음.
- 조각 시각: `/chunk` 수신. 클라이언트 활동: 회의별 하트비트(`/sessions/{id}/heartbeat`, 신 클라이언트 30초 주기·
  recording/paused 상태 포함) + 캔버스 저장, 그리고 하위호환으로 사용자별 caffeine(구 클라이언트, 5분 주기).
- 판정(30초 주기 루프): status=recording 이고, 일시정지가 아니고, 활동이 최근(ACTIVE_WINDOW_SEC)이며,
  마지막 조각(없으면 감시 시작 시각) 이후 N분 경과 → 1회 알림. 같은 무음 구간(같은 last_chunk)엔 다시 보내지 않는다.
- 일시정지 감시(2026-10-29 실제 원인 = 시작 직후 오탭으로 3시간 일시정지): 하트비트가 paused 인 채로
  DREC_REC_PAUSE_ALERT_MIN(기본 5)분 넘게 이어지고 화면이 살아 있으면 "녹음이 일시정지 상태입니다" 푸시.
  같은 정지 구간엔 1회, 정지가 길어지면 PAUSE_REPEAT_SEC(15분) 간격으로 재알림. 재개하면 초기화.
"""

import asyncio
import os
import time
from dataclasses import dataclass

from sqlalchemy import select

from . import push
from .db import Session, Meeting

POLL_SEC = 30.0
# 구 클라이언트는 caffeine 이 5분 주기 → 그보다 넉넉히. 신 클라이언트 하트비트는 30초 주기.
ACTIVE_WINDOW_SEC = 6 * 60.0
# 감시 대상 상한: 이보다 오래된 recording 행은 버려진 세션으로 본다
MAX_AGE_SEC = 12 * 3600.0


PAUSE_REPEAT_SEC = 15 * 60.0


def pause_sec() -> float:
    """환경변수 DREC_REC_PAUSE_ALERT_MIN(분, 기본 5). 0 이하면 일시정지 알림 끔."""
    try:
        return float(os.environ.get("DREC_REC_PAUSE_ALERT_MIN", "5")) * 60.0
    except ValueError:
        return 300.0


def silence_sec() -> float:
    """환경변수 DREC_REC_SILENCE_ALERT_MIN(분, 기본 3). 0 이하면 감시 끔."""
    try:
        return float(os.environ.get("DREC_REC_SILENCE_ALERT_MIN", "3")) * 60.0
    except ValueError:
        return 180.0


@dataclass
class _Watch:
    since: float                      # 감시 시작(=조각이 없을 때의 기준점)
    last_chunk: float | None = None
    last_seen: float | None = None    # 이 회의의 하트비트/캔버스 저장
    paused: bool = False              # 하트비트가 알려준 클라이언트 상태(구 클라이언트는 모름 → False)
    notified_for: float | None = None  # 알림을 보낸 무음 구간의 기준점(중복 억제)
    paused_since: float | None = None  # 현재 정지 구간 시작(하트비트 기준)
    pause_notified_at: float | None = None  # 이 정지 구간의 마지막 일시정지 알림 시각


_watch: dict[int, _Watch] = {}
_user_seen: dict[str, float] = {}     # 사용자별 caffeine(구 클라이언트 호환용 활동 신호)
_task: asyncio.Task | None = None


def _get(meeting_id: int, now: float) -> _Watch:
    w = _watch.get(meeting_id)
    if w is None:
        w = _watch[meeting_id] = _Watch(since=now)
    return w


def on_chunk(meeting_id: int) -> None:
    now = time.time()
    w = _get(meeting_id, now)
    w.last_chunk = now
    w.last_seen = now


def on_activity(meeting_id: int, state: str | None = None) -> None:
    """하트비트(state=recording|paused) 또는 캔버스 저장(state=None)."""
    now = time.time()
    w = _get(meeting_id, now)
    w.last_seen = now
    if state == "paused":
        if not w.paused:
            w.paused_since = now
            w.pause_notified_at = None
        w.paused = True
    elif state == "recording":
        if w.paused:  # 재개 — 일시정지 동안은 조각이 없는 게 정상이므로 기준점을 지금으로
            w.since = now
            w.last_chunk = None
        w.paused = False
        w.paused_since = None
        w.pause_notified_at = None


def on_user_activity(user: str) -> None:
    _user_seen[user] = time.time()


def forget(meeting_id: int) -> None:
    _watch.pop(meeting_id, None)


def due(w: _Watch, user_seen: float | None, now: float, limit: float) -> bool:
    """알림을 보내야 하는가(순수 함수 — 테스트 대상)."""
    if limit <= 0 or w.paused:
        return False
    seen = max(x for x in (w.last_seen, user_seen, 0.0) if x is not None)
    if now - seen > ACTIVE_WINDOW_SEC:
        return False  # 클라이언트가 없다(탭 닫힘 등) — 알려 봐야 받을 화면이 없거나 이미 끝난 세션
    base = w.last_chunk or w.since
    if seen <= base:
        return False  # 마지막 조각 이후 클라이언트 활동이 없다
    return now - base >= limit and w.notified_for != base


def pause_due(w: _Watch, now: float, limit: float) -> bool:
    """일시정지 알림을 보내야 하는가(순수 함수). 화면이 살아 있을 때만(하트비트가 최근)."""
    if limit <= 0 or not w.paused or w.paused_since is None:
        return False
    if w.last_seen is None or now - w.last_seen > ACTIVE_WINDOW_SEC:
        return False
    if now - w.paused_since < limit:
        return False
    return w.pause_notified_at is None or now - w.pause_notified_at >= PAUSE_REPEAT_SEC


async def check_once(now: float | None = None) -> list[int]:
    """recording 세션을 훑어 알림 대상에 푸시. 알림 보낸 회의 id 목록 반환."""
    now = time.time() if now is None else now
    limit = silence_sec()
    plimit = pause_sec()
    async with Session() as session:
        rows = (await session.execute(
            select(Meeting.id, Meeting.user_id, Meeting.title, Meeting.created_at).where(Meeting.status == "recording")
        )).all()
    live = set()
    sent = []
    for mid, user_id, title, created_at in rows:
        if created_at is not None and now - created_at.timestamp() > MAX_AGE_SEC:
            continue
        live.add(mid)
        w = _get(mid, now)
        name = (title or "").strip() or "제목 없는 회의"
        if pause_due(w, now, plimit):
            w.pause_notified_at = now
            mins = int((now - (w.paused_since or now)) // 60)
            push.notify(user_id or "", "녹음이 일시정지 상태입니다",
                        f"{name} — {mins}분째 일시정지 중입니다. 회의 중이라면 재개하세요.",
                        "/", f"rec-paused-{mid}")
            print(f"[recwatch] meeting={mid} {mins}분 일시정지 알림", flush=True)
            sent.append(mid)
            continue
        if not due(w, _user_seen.get(user_id or ""), now, limit):
            continue
        base = w.last_chunk or w.since
        w.notified_for = base
        mins = int((now - base) // 60)
        push.notify(user_id or "", "녹음이 들어오지 않습니다",
                    f"{name} — {mins}분째 녹음 조각이 없습니다. 마이크 상태를 확인하세요.",
                    "/", f"rec-silence-{mid}")
        print(f"[recwatch] meeting={mid} {mins}분 무음 알림", flush=True)
        sent.append(mid)
    for mid in list(_watch):  # finish/삭제된 세션 정리
        if mid not in live:
            _watch.pop(mid, None)
    return sent


async def _loop() -> None:
    while True:
        await asyncio.sleep(POLL_SEC)
        try:
            await check_once()
        except Exception as e:  # 감시는 부가 기능 — 절대 죽지 않는다
            print(f"[recwatch] 점검 실패: {e}", flush=True)


def start() -> None:
    global _task
    if _task is None and (silence_sec() > 0 or pause_sec() > 0):
        _task = asyncio.get_running_loop().create_task(_loop())


def stop() -> None:
    global _task
    if _task is not None:
        _task.cancel()
        _task = None
