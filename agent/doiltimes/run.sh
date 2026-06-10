#!/usr/bin/env bash
# DoilTimes 실행 래퍼 — 수동 실행과 cron 등록 양쪽에서 사용.
#   ./run.sh             # 전체 파이프라인
#   ./run.sh --no-ai     # 배선 테스트 (토큰 0)
#   ./run.sh --no-mail   # 발행까지만
set -euo pipefail
cd "$(dirname "$0")"

# cron 환경에는 PATH 가 최소라 claude CLI 를 못 찾을 수 있음
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:$PATH"

# OAuth 토큰 파일이 있으면 로드 (cron 용 — `claude setup-token` 발급값을 넣어둠)
# 예) ~/.doiltimes.env 내용: export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
[ -f "$HOME/.doiltimes.env" ] && . "$HOME/.doiltimes.env"

exec python3 doiltimes.py "$@"
