"""녹음 무음 감시(recwatch) + 조각 멱등/하트비트/다중 원본 업로드 테스트.
실행: DREC_JWT_SECRET=x python -m pytest backend/tests -q (다중 업로드 테스트는 ffmpeg 필요)"""
import io
import os
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone

os.environ.setdefault("DREC_JWT_SECRET", "test")
os.environ.setdefault("DREC_DATA_DIR", tempfile.mkdtemp())

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine, AsyncSession

from app import db, main, push, recwatch  # noqa: E402
from fastapi import UploadFile  # noqa: E402

LIMIT = 180.0


def W(**k):
    return recwatch._Watch(**{"since": 0.0, **k})


def test_due_rules():
    # 조각 없음 + 하트비트 최근 + 3분 경과 → 알림
    assert recwatch.due(W(last_seen=170.0), None, 180.0, LIMIT)
    # 아직 3분 안 됨
    assert not recwatch.due(W(last_seen=100.0), None, 179.0, LIMIT)
    # 일시정지 중엔 안 보냄
    assert not recwatch.due(W(last_seen=170.0, paused=True), None, 300.0, LIMIT)
    # 클라이언트 활동이 오래됨(탭 닫힘) → 안 보냄
    assert not recwatch.due(W(last_seen=10.0), None, 10.0 + recwatch.ACTIVE_WINDOW_SEC + 1, LIMIT)
    # 마지막 조각 이후 활동이 없음 → 안 보냄
    assert not recwatch.due(W(last_chunk=100.0, last_seen=100.0), None, 400.0, LIMIT)
    # 구 클라이언트: 회의 하트비트 없이 사용자 caffeine 만 → 알림
    assert recwatch.due(W(last_chunk=100.0, last_seen=100.0), 250.0, 290.0, LIMIT)
    # 같은 무음 구간엔 한 번만
    assert not recwatch.due(W(last_seen=170.0, notified_for=0.0), None, 400.0, LIMIT)
    # 감시 끔
    assert not recwatch.due(W(last_seen=170.0), None, 180.0, 0)


def test_resume_resets_baseline(monkeypatch):
    recwatch._watch.clear()
    t = [1000.0]
    monkeypatch.setattr(recwatch.time, "time", lambda: t[0])
    recwatch.on_chunk(7)
    recwatch.on_activity(7, "paused")
    t[0] = 2000.0
    recwatch.on_activity(7, "recording")  # 재개 → 기준점 = 지금
    w = recwatch._watch[7]
    t[0] = 2000.0 + LIMIT - 1
    recwatch.on_activity(7, "recording")  # 재개 후 하트비트
    assert not recwatch.due(w, None, t[0], LIMIT)
    assert recwatch.due(w, None, 2000.0 + LIMIT, LIMIT)


@pytest.fixture
async def env(monkeypatch):
    eng = create_async_engine("sqlite+aiosqlite://")
    S = async_sessionmaker(eng, class_=AsyncSession, expire_on_commit=False)
    async with eng.begin() as c:
        await c.run_sync(db.Base.metadata.create_all)
    for mod in (db, main, push, recwatch):
        monkeypatch.setattr(mod, "Session", S)
    sent = []
    monkeypatch.setattr(push, "notify", lambda user, title, body, url="/", tag="drec": sent.append((user, title, body, url, tag)))
    recwatch._watch.clear()
    recwatch._user_seen.clear()
    async with S() as s:
        s.add(db.Meeting(id=80, user_id="u1", title="주간회의", status="recording", created_at=datetime.now(timezone.utc)))
        s.add(db.Meeting(id=81, user_id="u1", title="", status="done", created_at=datetime.now(timezone.utc)))
        await s.commit()
    return S, sent


async def test_check_once_alerts_once(env, monkeypatch):
    S, sent = env
    t = [datetime.now(timezone.utc).timestamp()]
    monkeypatch.setattr(recwatch.time, "time", lambda: t[0])
    recwatch.on_chunk(80)                 # seq 0 도착
    for _ in range(6):                    # 30초 간격 하트비트 3분
        t[0] += 30
        recwatch.on_activity(80, "recording")
    assert await recwatch.check_once(t[0]) == [80]
    assert sent[0][1] == "녹음이 들어오지 않습니다" and sent[0][3] == "/" and sent[0][4] == "rec-silence-80"
    t[0] += 60
    recwatch.on_activity(80, "recording")
    assert await recwatch.check_once(t[0]) == []   # 같은 무음 구간 → 억제
    recwatch.on_chunk(80)                           # 조각 재개 → 새 구간
    t[0] += 30
    recwatch.on_activity(80, "recording")
    t[0] += LIMIT
    recwatch.on_activity(80, "recording")
    assert await recwatch.check_once(t[0]) == [80]
    assert len(sent) == 2
    # finish 등으로 recording 을 벗어나면 감시 목록에서 빠진다
    async with S() as s:
        m = await s.get(db.Meeting, 80); m.status = "processing"; await s.commit()
    assert await recwatch.check_once(t[0] + 999) == [] and 80 not in recwatch._watch


async def test_endpoints_heartbeat_and_chunk_dedupe(env, monkeypatch):
    S, sent = env
    from fastapi import BackgroundTasks, HTTPException
    up = lambda name, data: UploadFile(file=io.BytesIO(data), filename=name)
    await main.session_heartbeat(80, main.HeartbeatBody(state="paused"), user="u1")
    assert recwatch._watch[80].paused
    await main.session_heartbeat(80, main.HeartbeatBody(), user="u1")
    assert not recwatch._watch[80].paused
    with pytest.raises(HTTPException):
        await main.session_heartbeat(80, main.HeartbeatBody(), user="u2")  # 타인 회의
    bt = BackgroundTasks()
    assert await main.add_chunk(80, bt, seq=0, time_offset=0.0, audio=up("chunk-0.webm", b"x" * 600), user="u1") == {"ok": True}
    assert len(bt.tasks) == 1 and recwatch._watch[80].last_chunk is not None
    os.unlink(bt.tasks[0].args[3])  # 임시 파일 정리
    async with S() as s:
        s.add(db.MeetingChunk(meeting_id=80, seq=0, text="안녕", time_offset=0.0)); await s.commit()
    bt = BackgroundTasks()
    r = await main.add_chunk(80, bt, seq=0, time_offset=0.0, audio=up("chunk-0.webm", b"x" * 600), user="u1")
    assert r.get("duplicate") is True and not bt.tasks  # 재전송 seq → 재처리 안 함


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg 필요")
async def test_multi_part_upload_concat(env, monkeypatch):
    S, _ = env
    monkeypatch.setattr(push, "notify_meeting", lambda *a: None)
    tmp = tempfile.mkdtemp()
    a, b = os.path.join(tmp, "a.webm"), os.path.join(tmp, "b.m4a")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=2", "-c:a", "libopus", a], check=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=660:d=3:sample_rate=44100", "-c:a", "aac", b], check=True)
    os.makedirs(main._meeting_dir(80), exist_ok=True)
    open(main._m4a_path(80), "wb").write(b"stale")
    files = [UploadFile(file=open(a, "rb"), filename="full-0.webm"), UploadFile(file=open(b, "rb"), filename="full-1.m4a")]
    assert await main.upload_session_audio(80, files, user="u1") == {"ok": True}
    async with S() as s:
        m = await s.get(db.Meeting, 80)
        assert 4.8 < m.audio_duration_sec < 5.3
    assert not os.path.exists(main._m4a_path(80))  # 낡은 m4a 폐기


def test_pause_alert_rules(monkeypatch):
    recwatch._watch.clear()
    t = [1000.0]
    monkeypatch.setattr(recwatch.time, "time", lambda: t[0])
    recwatch.on_activity(9, "recording")
    recwatch.on_activity(9, "paused")          # 정지 시작 = 1000
    w = recwatch._watch[9]
    P = 300.0
    t[0] = 1000 + P - 1; recwatch.on_activity(9, "paused")
    assert not recwatch.pause_due(w, t[0], P)  # 5분 미만
    t[0] = 1000 + P; recwatch.on_activity(9, "paused")
    assert w.paused_since == 1000.0 and recwatch.pause_due(w, t[0], P)
    w.pause_notified_at = t[0]
    t[0] += 60; recwatch.on_activity(9, "paused")
    assert not recwatch.pause_due(w, t[0], P)  # 같은 정지 구간 — 억제
    t[0] = 1000 + P + recwatch.PAUSE_REPEAT_SEC; recwatch.on_activity(9, "paused")
    assert recwatch.pause_due(w, t[0], P)      # 15분 뒤 재알림
    assert not recwatch.pause_due(w, t[0] + recwatch.ACTIVE_WINDOW_SEC + 1, P)  # 화면 없음
    recwatch.on_activity(9, "recording")       # 재개 → 초기화
    assert w.paused_since is None and not recwatch.pause_due(w, t[0], P)
    assert not recwatch.due(w, None, t[0], LIMIT)  # 무음 알림도 재개 시점부터 다시 계산


async def test_check_once_pause_push(env, monkeypatch):
    S, sent = env
    t = [datetime.now(timezone.utc).timestamp()]
    monkeypatch.setattr(recwatch.time, "time", lambda: t[0])
    recwatch.on_chunk(80)
    recwatch.on_activity(80, "paused")
    for _ in range(10):                         # 30초 하트비트 5분
        t[0] += 30
        recwatch.on_activity(80, "paused")
    assert await recwatch.check_once(t[0]) == [80]
    assert sent[-1][1] == "녹음이 일시정지 상태입니다" and sent[-1][4] == "rec-paused-80"
    t[0] += 30; recwatch.on_activity(80, "paused")
    assert await recwatch.check_once(t[0]) == []   # 억제(무음 알림도 일시정지라 안 감)
    assert len(sent) == 1


async def test_resumed_but_no_chunks_alerts(env, monkeypatch):
    """E: 재개 후 하트비트는 recording 인데 조각이 안 오면 N분 후 무음 알림."""
    S, sent = env
    t = [datetime.now(timezone.utc).timestamp()]
    monkeypatch.setattr(recwatch.time, "time", lambda: t[0])
    recwatch.on_chunk(80)
    recwatch.on_activity(80, "paused")
    t[0] += 600; recwatch.on_activity(80, "paused")
    recwatch._watch[80].pause_notified_at = t[0]  # 일시정지 알림은 이미 보냄
    t[0] += 30; recwatch.on_activity(80, "recording")   # 재개
    for _ in range(5):
        t[0] += 30; recwatch.on_activity(80, "recording")
    assert await recwatch.check_once(t[0]) == []          # 2.5분 — 아직
    t[0] += 30; recwatch.on_activity(80, "recording")
    assert await recwatch.check_once(t[0]) == [80]        # 재개 후 3분
    assert sent[-1][1] == "녹음이 들어오지 않습니다"


async def test_diag_append(env):
    from fastapi import HTTPException
    from starlette.requests import Request
    req = Request({"type": "http", "headers": [(b"user-agent", b"iPad Safari")]})
    r = await main.session_diag(80, main.DiagBody(events=[{"t": 1, "ev": "pause"}, {"t": 2, "ev": "resume_ok", "gen": 1}]), req, user="u1")
    assert r["written"] == 2
    lines = open(os.path.join(main._meeting_dir(80), "diag.jsonl"), encoding="utf-8").read().splitlines()
    import json as _j
    assert [_j.loads(x)["ev"] for x in lines[-2:]] == ["pause", "resume_ok"] and _j.loads(lines[-1])["ua"] == "iPad Safari"
    with pytest.raises(HTTPException):
        await main.session_diag(80, main.DiagBody(events=[]), req, user="u2")
