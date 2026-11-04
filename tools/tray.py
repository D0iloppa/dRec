"""dRec whisper 트레이 — 로그인 세션에서 실행되어 서버(:9000, 작업 스케줄러 S4U)를 HTTP 로 조회·제어한다.

서버는 세션 0 에서 돌기 때문에 UI 를 띄울 수 없으므로 트레이는 별도 프로세스다.
  - 아이콘 색: 회색=대기(sleep) · 초록=활성(모델 로드됨) · 파랑=처리 중 · 주황=깨우는 중/응답 없음 · 빨강=서버 꺼짐
  - 왼쪽 클릭 = Wake/Sleep 토글, 우클릭 = 상태·메모리·메뉴
실행:  E:\\drec\\whisper\\.venv\\Scripts\\dRec-tray.exe E:\\drec\\whisper\\tray.py   (HKCU Run 에 등록되어 로그인 시 자동 실행)
"""

import ctypes
import json
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request

import pystray
from PIL import Image, ImageDraw, ImageFont

BASE = os.environ.get("DREC_WHISPER_URL", "http://127.0.0.1:9000")
HERE = os.path.dirname(os.path.abspath(__file__))
POLL_SEC, POLL_FAST_SEC = 10, 3

COLORS = {
    "sleep": (128, 128, 128),
    "awake": (46, 160, 67),
    "busy": (47, 129, 247),
    "waking": (230, 140, 20),
    "noresp": (230, 140, 20),
    "down": (210, 50, 50),
}
LABELS = {
    "sleep": "대기 (sleep)",
    "awake": "활성 (모델 로드됨)",
    "busy": "처리 중",
    "waking": "깨우는 중…",
    "noresp": "응답 없음 (로드 중일 수 있음)",
    "down": "서버 꺼짐",
}


def _single_instance() -> bool:
    ctypes.windll.kernel32.CreateMutexW(None, False, "Local\\dRecWhisperTray")
    return ctypes.windll.kernel32.GetLastError() != 183  # ERROR_ALREADY_EXISTS


def _request(method: str, path: str, timeout: float = 3.0) -> dict:
    req = urllib.request.Request(BASE + path, method=method, data=b"" if method == "POST" else None)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def _gb(mb) -> str:
    return f"{mb / 1024:.1f} GB" if mb >= 1024 else f"{mb} MB"


def _font(size):
    for name in ("segoeuib.ttf", "arialbd.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


_FONT = _font(40)


def _icon_image(state: str) -> Image.Image:
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse((2, 2, 62, 62), fill=COLORS[state] + (255,))
    d.text((32, 33), "W", font=_FONT, fill="white", anchor="mm")
    return img


class Tray:
    def __init__(self):
        self.health: dict = {}
        self.state = "down"
        self.wake_requested_at = 0.0
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.kick = threading.Event()
        self._img_cache = {s: _icon_image(s) for s in COLORS}
        self.icon = pystray.Icon("dRec whisper", self._img_cache["down"], "dRec whisper", menu=self._menu())

    # ── 상태 조회 ──────────────────────────────────────────────
    def refresh(self):
        try:
            h = _request("GET", "/health")
            if h.get("warming"):
                state = "waking"
            elif h.get("active") or h.get("jobs_pending"):
                state = "busy"
            elif h.get("loaded") or h.get("diarize_loaded"):
                state = "awake"
            else:
                state = "sleep"
        except (socket.timeout, TimeoutError):
            h, state = self.health, "noresp"  # 콜드 로드 중엔 HTTP 가 멎을 수 있다
        except urllib.error.URLError as e:
            if isinstance(e.reason, (socket.timeout, TimeoutError)):
                h, state = self.health, "noresp"
            else:
                h, state = {}, "down"
        except Exception:  # noqa: BLE001
            h, state = {}, "down"
        if state == "noresp" and time.monotonic() - self.wake_requested_at < 600:
            state = "waking"
        with self.lock:
            self.health, self.state = h, state
        self.icon.icon = self._img_cache[state]
        self.icon.title = self._tooltip()[:127]
        self.icon.update_menu()

    def _poll(self):
        while not self.stop.is_set():
            self.refresh()
            fast = self.state in ("waking", "noresp", "busy")
            self.kick.wait(POLL_FAST_SEC if fast else POLL_SEC)
            self.kick.clear()

    # ── 표시 텍스트 ────────────────────────────────────────────
    def _mem_text(self) -> str:
        h = self.health
        if "working_set_mb" not in h:
            return "메모리: -"
        return f"메모리: {_gb(h['working_set_mb'])} (커밋 {_gb(h['private_mb'])})"

    def _idle_text(self) -> str:
        h = self.health
        if self.state not in ("awake",) or "idle_sec" not in h:
            return ""
        if h.get("caffeine_sec"):
            return f"유지(caffeine) {h['caffeine_sec'] // 60}분 남음"
        left = max(0, h["idle_unload_sec"] - h["idle_sec"])
        return f"유휴 {h['idle_sec'] // 60}분 · 자동 sleep까지 {left // 60}분"

    def _tooltip(self) -> str:
        parts = [f"dRec whisper — {LABELS[self.state]}"]
        if "working_set_mb" in self.health and self.state != "down":
            parts.append(_gb(self.health["working_set_mb"]))
        return " · ".join(parts)

    # ── 동작 ──────────────────────────────────────────────────
    def _is_up(self) -> bool:
        return self.state in ("awake", "busy", "waking", "noresp")

    def toggle(self, icon=None, item=None):
        threading.Thread(target=self._toggle, daemon=True).start()

    def _toggle(self):
        try:
            if self._is_up():
                if self.state == "waking":
                    self.icon.notify("모델을 올리는 중이라 sleep 할 수 없습니다. 로드가 끝난 뒤 다시 시도하세요.", "dRec whisper")
                    return
                r = _request("POST", "/sleep", timeout=30)
                msg = "모델을 내렸습니다" if r.get("unloaded") else "이미 대기 상태입니다"
                if "working_set_mb" in r:
                    msg += f" — 메모리 {_gb(r['working_set_mb'])}"
                self.icon.notify(msg, "dRec whisper · Sleep")
            else:
                if self.state == "down":
                    self.icon.notify("서버가 꺼져 있습니다 (작업 스케줄러 'dRec whisper').", "dRec whisper")
                    return
                _request("POST", "/warmup", timeout=10)
                self.wake_requested_at = time.monotonic()
                self.icon.notify("모델 로드를 시작했습니다 (수 분 걸릴 수 있음).", "dRec whisper · Wake")
        except urllib.error.HTTPError as e:
            try:
                detail = json.loads(e.read()).get("detail", e.reason)
            except Exception:  # noqa: BLE001
                detail = e.reason
            self.icon.notify(f"실패: {detail}", "dRec whisper")
        except Exception as e:  # noqa: BLE001
            self.icon.notify(f"실패: {type(e).__name__}: {e}", "dRec whisper")
        finally:
            self.kick.set()

    def open_log(self, icon=None, item=None):
        os.startfile(os.path.join(HERE, "whisper.log"))

    def quit(self, icon=None, item=None):
        self.stop.set()
        self.kick.set()
        self.icon.stop()

    def _menu(self):
        Item = pystray.MenuItem
        return pystray.Menu(
            Item(lambda _: f"상태: {LABELS[self.state]}", None, enabled=False),
            Item(lambda _: self._mem_text(), None, enabled=False),
            Item(lambda _: self._idle_text(), None, enabled=False, visible=lambda _: bool(self._idle_text())),
            pystray.Menu.SEPARATOR,
            Item(lambda _: "Sleep (모델 해제)" if self._is_up() else "Wake (모델 로드)", self.toggle,
                 default=True, enabled=lambda _: self.state != "down"),
            pystray.Menu.SEPARATOR,
            Item("새로고침", lambda *_: self.kick.set()),
            Item("로그 열기", self.open_log),
            Item("트레이 종료", self.quit),
        )

    def run(self):
        threading.Thread(target=self._poll, daemon=True).start()
        self.icon.run()


if __name__ == "__main__":
    if not _single_instance():
        sys.exit(0)
    Tray().run()
