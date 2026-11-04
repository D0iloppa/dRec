"""작업 스케줄러용 진입점 — python 을 직접 실행해 작업 중지 시 함께 종료되도록 하고, 로그는 whisper.log(UTF-8)에 남긴다.

실행 파일 dRec-whisper.exe 는 베이스 python.exe 를 venv Scripts 에 복사(+python310.dll 등)하고
FileDescription 을 'dRec whisper server' 로 바꾼 것 — 작업 관리자에서 'Python' 대신 이 이름으로 보인다.
python 업그레이드 시 다시 복사해야 한다.

로그 관리: 시작 시 whisper.log 가 LOG_MAX_MB 를 넘으면 whisper.log.1~.3 으로 밀어낸다(최근 3개 보존).
상태 폴링(GET /health — 트레이 10초·dRec 30초)은 접근 로그에 남기지 않는다.

수동 실행:  E:\\drec\\whisper\\.venv\\Scripts\\dRec-whisper.exe E:\\drec\\whisper\\serve.py
"""

import logging
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)

LOG = os.path.join(HERE, "whisper.log")
LOG_MAX_MB, LOG_KEEP = 10, 3

if os.path.exists(LOG) and os.path.getsize(LOG) > LOG_MAX_MB * 1024 * 1024:
    for i in range(LOG_KEEP, 0, -1):
        src = LOG if i == 1 else f"{LOG}.{i - 1}"
        if os.path.exists(src):
            os.replace(src, f"{LOG}.{i}")

_log = open(LOG, "a", encoding="utf-8", buffering=1)
os.dup2(_log.fileno(), 1)  # ctranslate2 등 네이티브 출력도 로그로
os.dup2(_log.fileno(), 2)
sys.stdout = sys.stderr = _log


class _NoHealth(logging.Filter):
    def filter(self, record):
        return "/health" not in record.getMessage()


logging.getLogger("uvicorn.access").addFilter(_NoHealth())

import uvicorn  # noqa: E402

uvicorn.run("whisper_server:app", host="0.0.0.0", port=9000, env_file=os.path.join(HERE, ".env"))
