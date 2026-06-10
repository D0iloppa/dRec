#!/usr/bin/env bash
# SourcingSearcher 실행 래퍼 — 수동 실행과 cron 양쪽에서 사용.
#   ./run.sh           # 전체 파이프라인 (발굴 → 신규 있으면 메일)
#   ./run.sh --dry     # 발굴까지만, 출력만
set -euo pipefail
cd "$(dirname "$0")"

# cron 의 빈약한 PATH 보정 — claude / node / npx 경로 확보
export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$HOME/.local/bin:/usr/local/bin:$PATH"

# 공용 OAuth 토큰 + agent_db 접속(AGENT_DB_DSN) 로드 — 모든 에이전트 공유
[ -f "$HOME/.agents.env" ] && . "$HOME/.agents.env"

mkdir -p state    # cron.log 출력 위치
exec python3 sourcingsearcher.py "$@"
