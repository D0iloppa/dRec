"""파이프라인 실행 1건(meeting 당 하나)의 중단 제어 — 일시정지/취소 요청을 실행 중인 워커에 전달한다.

in-memory 레지스트리라 프로세스 재시작 시 사라진다(재시작 복구는 db.recover_interrupted).
"""

import asyncio
import os
import signal
import subprocess
import threading
from typing import Callable


class Cancelled(Exception):
    """중단 요청이 관측됨(전사 폴링·GPU job·회의록 프로세스 공통). 호출자가 `action` 에 따라 상태를 정리한다."""


class RunControl:
    def __init__(self) -> None:
        self.stop = threading.Event()
        self.action: str | None = None  # "pause" | "cancel" — 요청된 동작(최초 요청 유지)
        self.job_id: str | None = None  # diarize: GPU job id
        self.transcript: list | None = None  # diarize: GPU 가 돌려준 원시 전사 [[start,end,text],…]
        self.proc: subprocess.Popen | None = None  # 실행 중인 외부 프로세스(claude CLI / ffmpeg)
        self.skip_diarize = False  # True 면 화자 분리를 건너뛰고 전사 결과만으로 진행(중단 아님)
        # 상태 전이 직렬화: 워커의 결과 기록과 취소 반영이 같은 락 안에서만 일어나 늦은 완료가 취소를 덮지 못한다.
        self.lock = asyncio.Lock()
        self._closers: list[Callable[[], None]] = []
        self._closers_lock = threading.Lock()

    def add_closer(self, fn: Callable[[], None]) -> Callable[[], None]:
        """중단 시 호출될 정리 콜백(블로킹 HTTP 클라이언트 close 등). 반환값으로 등록 해제.
        이미 중단된 뒤 등록하면 즉시 호출한다."""
        with self._closers_lock:
            self._closers.append(fn)
        if self.stop.is_set():
            _safe(fn)

        def remove() -> None:
            with self._closers_lock:
                if fn in self._closers:
                    self._closers.remove(fn)
        return remove

    def request(self, action: str) -> None:
        # 취소는 일시정지보다 우선(일시정지 정리 중에 취소가 오면 취소로 바뀐다)
        self.action = "cancel" if action == "cancel" else (self.action or action)
        self.stop.set()
        if self.proc is not None:
            kill_proc(self.proc)
        with self._closers_lock:
            closers = list(self._closers)
        for fn in closers:
            _safe(fn)

    def skip(self) -> None:
        self.skip_diarize = True

    def check(self) -> None:
        if self.stop.is_set():
            raise Cancelled()


def _safe(fn: Callable[[], None]) -> None:
    try:
        fn()
    except Exception:  # noqa: BLE001 — 정리 콜백 실패가 중단 요청 자체를 막으면 안 된다
        pass


def kill_proc(proc: subprocess.Popen) -> None:
    """프로세스 그룹째 종료(CLI 가 자식을 띄워 파이프를 붙잡고 있어도 communicate 가 풀리도록)."""
    if proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        proc.kill()


_runs: dict[int, RunControl] = {}


def begin(meeting_id: int) -> RunControl:
    ctl = _runs[meeting_id] = RunControl()
    return ctl


def get(meeting_id: int) -> RunControl | None:
    return _runs.get(meeting_id)


def end(meeting_id: int, ctl: RunControl) -> None:
    if _runs.get(meeting_id) is ctl:  # 재개로 이미 새 실행이 등록됐다면 건드리지 않는다
        del _runs[meeting_id]
