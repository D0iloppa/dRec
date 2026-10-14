"""파이프라인 실행 1건(meeting 당 하나)의 중단 제어 — 일시정지/취소 요청을 실행 중인 워커에 전달한다.

in-memory 레지스트리라 프로세스 재시작 시 사라진다(재시작 복구는 db.recover_interrupted).
"""

import os
import signal
import subprocess
import threading


class Cancelled(Exception):
    """중단 요청이 관측됨(전사 폴링·GPU job·회의록 프로세스 공통). 호출자가 `action` 에 따라 상태를 정리한다."""


class RunControl:
    def __init__(self) -> None:
        self.stop = threading.Event()
        self.action: str | None = None  # "pause" | "cancel" — 요청된 동작(최초 요청 유지)
        self.job_id: str | None = None  # diarize: GPU job id
        self.transcript: list | None = None  # diarize: GPU 가 돌려준 원시 전사 [[start,end,text],…]
        self.proc: subprocess.Popen | None = None  # minutes: claude CLI 프로세스

    def request(self, action: str) -> None:
        self.action = self.action or action
        self.stop.set()
        if self.proc is not None:
            kill_proc(self.proc)

    def check(self) -> None:
        if self.stop.is_set():
            raise Cancelled()


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
