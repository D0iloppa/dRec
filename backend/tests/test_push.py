"""푸시 알림 단계 전환 테스트 — sqlite + pywebpush 목. 실행: DREC_JWT_SECRET=x python -m pytest backend/tests -q"""
import asyncio
import base64
import os
import tempfile

os.environ.setdefault("DREC_JWT_SECRET", "test")
os.environ["DREC_DATA_DIR"] = tempfile.mkdtemp()

import pytest
from cryptography.hazmat.primitives import serialization as ser
from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine, AsyncSession

b64 = lambda x: base64.urlsafe_b64encode(x).rstrip(b"=").decode()
_k = ec.generate_private_key(ec.SECP256R1())
os.environ["DREC_VAPID_PUBLIC_KEY"] = b64(_k.public_key().public_bytes(ser.Encoding.X962, ser.PublicFormat.UncompressedPoint))
os.environ["DREC_VAPID_PRIVATE_KEY"] = b64(_k.private_numbers().private_value.to_bytes(32, "big"))

from app import db, main, push  # noqa: E402


@pytest.fixture
async def env(monkeypatch):
    eng = create_async_engine("sqlite+aiosqlite://")
    S = async_sessionmaker(eng, class_=AsyncSession, expire_on_commit=False)
    async with eng.begin() as c:
        await c.run_sync(db.Base.metadata.create_all)
    for mod in (db, main, push):
        monkeypatch.setattr(mod, "Session", S)
    sent = []

    def fake_webpush(subscription_info, data, vapid_private_key, vapid_claims, ttl):
        sent.append((subscription_info["endpoint"], data, ttl))

    import pywebpush
    monkeypatch.setattr(pywebpush, "webpush", fake_webpush)
    async with S() as s:
        s.add(db.PushSubscription(user_id="u1", endpoint="https://push/1", p256dh="p", auth="a"))
        s.add(db.Meeting(id=1, user_id="u1", title="주간회의", status="processing"))
        s.add(db.Meeting(id=2, user_id="u1", title="", status="processing_minutes"))
        await s.commit()
    return S, sent


async def drain():
    await asyncio.sleep(0.2)
    while push._tasks:
        await asyncio.gather(*list(push._tasks))


def titles(sent):
    import json
    return [json.loads(d)["title"] for _, d, _ in sent]


async def test_stage_transitions(env, monkeypatch):
    S, sent = env
    import json
    loop = asyncio.get_running_loop()
    # transcribe -> diarize (worker thread 에서 호출되는 reporter)
    rep = main._ProgressReporter(1, loop, "transcribe")
    await loop.run_in_executor(None, rep, "diarize", None)
    await drain()
    assert titles(sent) == ["전사 완료"]
    p = json.loads(sent[0][1])
    assert p["body"] == "주간회의" and p["url"] == "/m/1" and p["tag"] == "meeting-1" and sent[0][2] == 86400

    # 화자분리 완료 + 오류(빈 전사)
    async def fake_diarize(*a, **k):
        return {"text": "안녕", "segments": []}
    monkeypatch.setattr(main, "diarize", lambda *a, **k: {"text": "안녕", "segments": []})
    monkeypatch.setattr(main, "_make_m4a", lambda mid: None)
    os.makedirs(main._meeting_dir(1), exist_ok=True)
    open(main._full_audio_path(1), "wb").write(b"x")
    async with S() as s:
        m = await s.get(db.Meeting, 1); m.audio_duration_sec = 1.0; await s.commit()
    sent.clear()
    await main._diarization_steps(1, "", False, None, main.control.begin(1))
    await drain()
    assert titles(sent) == ["화자 분리 완료"]

    # 회의록 완료 / 오류 (제목 없는 회의)
    monkeypatch.setattr(main, "make_named_transcript", lambda *a: "n")
    monkeypatch.setattr(main, "make_minutes", lambda *a: "# m")
    async with S() as s:
        m = await s.get(db.Meeting, 2); m.stage = "minutes"; await s.commit()
    sent.clear()
    await main._run_minutes(2, "t", [], {})
    await drain()
    assert titles(sent) == ["회의록 완료"] and json.loads(sent[0][1])["body"] == "제목 없는 회의"

    def boom(*a): raise RuntimeError("x")
    monkeypatch.setattr(main, "make_minutes", boom)
    async with S() as s:
        m = await s.get(db.Meeting, 2); m.stage = "minutes"; m.status = "processing_minutes"; await s.commit()
    sent.clear()
    await main._run_minutes(2, "t", [], {})
    await drain()
    assert titles(sent) == ["처리 오류"]


async def test_pause_and_recovery(env):
    S, sent = env
    async with S() as s:
        m = await s.get(db.Meeting, 1); m.stage = "transcribe"; await s.commit()
    assert await main._apply_stop(1, "pause") == "paused"
    await drain()
    assert titles(sent) == ["일시정지됨"]
    sent.clear()
    assert await main._apply_stop(1, "cancel") == "uploaded"  # 취소는 알림 없음
    await drain()
    assert sent == []
    ids = await db.recover_interrupted()  # meeting 2 (processing_minutes)
    for i in ids:
        push.notify_meeting(i, "paused")
    await drain()
    assert ids == [2] and titles(sent) == ["일시정지됨"]


async def test_dead_subscription_deleted_and_noop(env, monkeypatch):
    S, sent = env
    import pywebpush
    from sqlalchemy import select

    class R: status_code = 410
    def gone(**k): raise pywebpush.WebPushException("gone", response=R())
    monkeypatch.setattr(pywebpush, "webpush", gone)
    assert await push.send_test("u1") == 0
    async with S() as s:
        assert (await s.execute(select(db.PushSubscription))).first() is None
    monkeypatch.setenv("DREC_VAPID_PRIVATE_KEY", "")
    push.notify("u1", "t", "b")  # no-op, 예외 없음
    assert not push._tasks


def test_real_vapid_signing():
    """실제 pywebpush 가 생성 키로 암호화·서명해 로컬 HTTP 엔드포인트에 POST 한다."""
    import http.server, threading
    from pywebpush import webpush
    got = {}

    class H(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            got["auth"] = self.headers.get("Authorization", ""); got["ttl"] = self.headers.get("TTL")
            self.rfile.read(int(self.headers["Content-Length"])); self.send_response(201); self.end_headers()
        def log_message(self, *a): pass
    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    client = ec.generate_private_key(ec.SECP256R1())
    sub = {"endpoint": f"http://127.0.0.1:{srv.server_port}/x", "keys": {
        "p256dh": b64(client.public_key().public_bytes(ser.Encoding.X962, ser.PublicFormat.UncompressedPoint)),
        "auth": b64(os.urandom(16))}}
    r = webpush(sub, '{"a":1}', vapid_private_key=os.environ["DREC_VAPID_PRIVATE_KEY"],
                vapid_claims={"sub": "mailto:user5@wellconn.co.kr"}, ttl=86400)
    srv.shutdown()
    assert r.status_code == 201 and got["auth"].startswith("vapid ") and got["ttl"] == "86400"
