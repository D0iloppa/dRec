"""즉시 취소 + 화자 분리 건너뛰기 테스트.
실행: DREC_JWT_SECRET=x python -m pytest backend/tests -q

- 취소는 워커가 단계를 끝내길 기다리지 않고 즉시 상태를 바꾸며, 늦게 끝난 워커의 결과는 어떤 DB 쓰기도 하지 못한다.
- 화자 분리 건너뛰기는 전사가 나오는 즉시 GPU job 만 취소하고 화자 없는 전사본으로 계속한다.
"""
import asyncio
import os
import tempfile
import threading
import time
from datetime import datetime, timezone

os.environ.setdefault("DREC_JWT_SECRET", "test")
os.environ.setdefault("DREC_DATA_DIR", tempfile.mkdtemp())

import httpx  # noqa: E402
import pytest  # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine, AsyncSession  # noqa: E402

from app import control, db, main, push, recwatch  # noqa: E402
from app import transcribe as tr  # noqa: E402
from app.control import Cancelled  # noqa: E402

MID = 90


@pytest.fixture
async def env(monkeypatch):
    eng = create_async_engine("sqlite+aiosqlite://")
    S = async_sessionmaker(eng, class_=AsyncSession, expire_on_commit=False)
    async with eng.begin() as c:
        await c.run_sync(db.Base.metadata.create_all)
    for mod in (db, main, push, recwatch):
        monkeypatch.setattr(mod, "Session", S)
    monkeypatch.setattr(push, "notify_meeting", lambda *a: None)
    monkeypatch.setattr(main, "_make_m4a", lambda *a, **k: None)      # ffmpeg 불필요
    monkeypatch.setattr(main, "_probe_duration", lambda p: None)
    os.makedirs(main._meeting_dir(MID), exist_ok=True)
    open(main._full_audio_path(MID), "wb").write(b"x")                # 원본 오디오 존재
    async with S() as s:
        s.add(db.Meeting(id=MID, user_id="u1", title="t", status="processing", stage="prepare",
                         created_at=datetime.now(timezone.utc)))
        await s.commit()
    control._runs.clear()
    return S


async def _meeting(S):
    async with S() as s:
        return await s.get(db.Meeting, MID)


async def _wait(cond, timeout=5.0):
    end = time.monotonic() + timeout
    while not cond():
        assert time.monotonic() < end, "시간 초과"
        await asyncio.sleep(0.01)


async def test_cancel_is_immediate_and_late_result_is_discarded(env, monkeypatch):
    """GPU 단계가 취소를 무시하고 계속 돌다 늦게 '성공'으로 끝나도: 취소는 즉시 반영, 결과는 기록되지 않는다."""
    S = env
    started, release = threading.Event(), threading.Event()

    def slow_diarize(audio, lang, reporter, ctl, resume):
        started.set()
        release.wait(10)  # 취소를 관측하지 못하는 단계(동기 폴백처럼)
        return {"text": "[화자 A] 늦은 결과", "segments": [{"start": 0, "end": 1, "speaker": "화자 A", "text": "늦은 결과"}]}

    monkeypatch.setattr(main, "diarize", slow_diarize)
    task = asyncio.create_task(main._run_diarization(MID, ""))
    await _wait(started.is_set)

    t0 = time.monotonic()
    res = await main.cancel_meeting(MID, user="u1")
    assert time.monotonic() - t0 < 1.0                       # 단계 종료를 기다리지 않았다
    assert res["status"] == "uploaded" and res["pending_action"] is None
    m = await _meeting(S)
    assert m.status == "uploaded" and m.stage == "cancelled"  # UI 가 즉시 보는 상태

    release.set()                                            # 늦은 완료
    await task
    m = await _meeting(S)
    assert m.status == "uploaded" and m.stage == "cancelled"  # 되살아나지 않음
    assert m.transcript == "" and m.segments == ""
    assert control.get(MID) is None                           # 워커 슬롯 해제


async def test_cancel_during_minutes_keeps_transcript_and_ignores_late_minutes(env, monkeypatch):
    S = env
    async with S() as s:
        m = await s.get(db.Meeting, MID)
        m.status, m.stage, m.transcript = "processing_minutes", "minutes", "전사본"
        await s.commit()
    started, release = threading.Event(), threading.Event()

    def slow_minutes(text, timeout, ctl):
        started.set()
        release.wait(10)
        return "# 늦은 회의록"

    monkeypatch.setattr(main, "make_minutes", slow_minutes)
    task = asyncio.create_task(main._run_minutes(MID, "전사본", [], {}))
    await _wait(started.is_set)
    res = await main.cancel_meeting(MID, user="u1")
    assert res["status"] == "transcribed"
    release.set()
    await task
    m = await _meeting(S)
    assert m.status == "transcribed" and m.minutes == "" and m.transcript == "전사본"


async def test_cancel_after_completion_does_not_revert(env):
    S = env
    async with S() as s:
        m = await s.get(db.Meeting, MID)
        m.status, m.stage = "done", "done"
        await s.commit()
    assert await main._apply_stop(MID, "cancel") == "done"    # 이미 끝난 회의는 건드리지 않는다
    assert (await _meeting(S)).status == "done"


async def test_late_progress_does_not_overwrite_cancel(env):
    S = env
    assert await main._apply_stop(MID, "cancel") == "uploaded"
    await db.set_stage(MID, "transcribe", 0.5)                # 늦게 도착한 reporter 쓰기
    await db.set_progress(MID, "cancelled", 0.9)
    m = await _meeting(S)
    assert m.status == "uploaded" and m.stage == "cancelled" and m.progress is None


async def test_cancel_overrides_pending_pause():
    ctl = control.RunControl()
    ctl.request("pause")
    ctl.request("cancel")
    assert ctl.action == "cancel" and ctl.stop.is_set()


def test_closers_run_on_request_and_when_added_late():
    ctl = control.RunControl()
    calls = []
    remove = ctl.add_closer(lambda: calls.append("a"))
    ctl.add_closer(lambda: calls.append("b"))
    remove()                                                   # 해제된 것은 호출되지 않는다
    ctl.request("cancel")
    assert calls == ["b"]
    ctl.add_closer(lambda: calls.append("late"))               # 이미 중단됨 → 즉시 호출
    assert calls == ["b", "late"]


# ── 화자 분리 건너뛰기 ──────────────────────────────────────────────────────

def _mock_gpu(monkeypatch, state="diarizing", transcript=None):
    """GPU job API 가짜: POST /diarize/jobs → job id, GET → 고정 상태. 취소 호출을 기록한다."""
    cancels = []

    def handler(req: httpx.Request) -> httpx.Response:
        if req.method == "POST":
            return httpx.Response(200, json={"job_id": "j1"})
        body = {"state": state, "progress": None}
        if transcript is not None:
            body["transcript"] = transcript
        return httpx.Response(200, json=body)

    real = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda *a, **k: real(transport=httpx.MockTransport(handler)))
    monkeypatch.setattr(tr, "DIARIZE_URL", "http://gpu/diarize")
    monkeypatch.setattr(tr, "POLL_INTERVAL", 0.01)
    monkeypatch.setattr(tr, "_remote_cancel", lambda url, jid: cancels.append(jid))
    return cancels


async def test_skip_during_diarizing_returns_transcript_only(monkeypatch, tmp_path):
    cancels = _mock_gpu(monkeypatch, transcript=[[0, 1, "안녕하세요"], [1, 2, " "], [2, 3, "회의 시작합니다"]])
    audio = tmp_path / "a.webm"
    audio.write_bytes(b"x")
    ctl = control.RunControl()
    ctl.skip()
    out = await asyncio.to_thread(tr.diarize, str(audio), "ko", None, ctl, None)
    assert out == {"text": "안녕하세요\n회의 시작합니다", "segments": []}
    assert cancels == ["j1"]                                   # GPU 의 화자 분리만 취소
    assert not ctl.stop.is_set()                               # 중단(Cancelled)이 아니다


async def test_skip_waits_for_transcript_while_transcribing(monkeypatch, tmp_path):
    """전사 중에 건너뛰기: 전사 결과가 아직 없으면 job 을 계속 돌리다 전사가 나오는 즉시 끊는다."""
    cancels = _mock_gpu(monkeypatch, state="transcribing")
    audio = tmp_path / "a.webm"
    audio.write_bytes(b"x")
    ctl = control.RunControl()
    task = asyncio.create_task(asyncio.to_thread(tr.diarize, str(audio), "ko", None, ctl, None))
    await asyncio.sleep(0.1)
    ctl.skip()
    await asyncio.sleep(0.1)
    assert not task.done() and cancels == []                   # 아직 전사 결과 없음 → 계속 기다림
    ctl.request("cancel")                                      # 폴링 스레드 정리
    with pytest.raises(Cancelled):
        await asyncio.wait_for(task, 2.0)


async def test_skip_with_saved_transcript_needs_no_gpu(monkeypatch):
    monkeypatch.setattr(tr, "DIARIZE_URL", "http://gpu/diarize")
    ctl = control.RunControl()
    ctl.skip()
    out = tr.diarize("unused", "ko", None, ctl, [[0, 1, "저장된"], [1, 2, "전사"]])
    assert out == {"text": "저장된\n전사", "segments": []}


async def test_cancel_stops_polling_job_and_cancels_remote(monkeypatch, tmp_path):
    cancels = _mock_gpu(monkeypatch, state="transcribing")
    audio = tmp_path / "a.webm"
    audio.write_bytes(b"x")
    ctl = control.RunControl()
    task = asyncio.create_task(asyncio.to_thread(tr.diarize, str(audio), "ko", None, ctl, None))
    await asyncio.sleep(0.1)
    t0 = time.monotonic()
    ctl.request("cancel")
    with pytest.raises(Cancelled):
        await asyncio.wait_for(task, 2.0)
    assert time.monotonic() - t0 < 1.0 and cancels == ["j1"]


async def test_pipeline_skip_completes_with_transcript_only(env, monkeypatch):
    """파이프라인: 화자 분리 없이(diarize=False) 끝나면 transcribed + segments 비어 있음(= '회의록만 생성' 경로)."""
    S = env
    seen = {}

    def fake_diarize(audio, lang, reporter, ctl, resume):
        seen["skip"] = ctl.skip_diarize
        return {"text": "화자 없는 전사", "segments": []}

    monkeypatch.setattr(main, "diarize", fake_diarize)
    await main._run_diarization(MID, "", False, None, False)
    m = await _meeting(S)
    assert seen["skip"] is True
    assert m.status == "transcribed" and m.transcript == "화자 없는 전사" and m.segments == ""


async def test_skip_endpoint_flags_running_worker_and_persists(env):
    S = env
    ctl = control.begin(MID)
    res = await main.skip_diarize(MID, user="u1")
    assert res["diarize"] is False and res["pending_skip"] is True and ctl.skip_diarize
    assert (await _meeting(S)).diarize is False
    async with S() as s:
        m = await s.get(db.Meeting, MID)
        m.status, m.stage = "done", "done"
        await s.commit()
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        await main.skip_diarize(MID, user="u1")               # 건너뛸 단계가 없다
