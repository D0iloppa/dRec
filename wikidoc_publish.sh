#!/usr/bin/env bash
#
# wikidoc_publish.sh — doil-wiki 무중단 발행
#
# 동작 흐름:
#   1. doil-wiki 컨테이너만 재빌드·재기동 (--no-deps, 다른 서비스 무중단)
#
# 사용법:
#   ./wikidoc_publish.sh             # 빌드 + 발행 (기본)
#   ./wikidoc_publish.sh --no-build  # 재기동만 (이미지 재빌드 생략)
#   ./wikidoc_publish.sh -h          # 도움말 표시
#

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NO_BUILD=false

for arg in "$@"; do
  case "$arg" in
    --no-build) NO_BUILD=true ;;
    -h|--help)
      sed -n '/^# wikidoc_publish.sh/,/^$/p' "$0" | sed 's/^#\s\?//'
      exit 0
      ;;
    *)
      echo "[wikidoc_publish] 알 수 없는 옵션: $arg" >&2
      echo "  ./wikidoc_publish.sh --help 로 도움말 확인" >&2
      exit 1
      ;;
  esac
done

log() { echo "[wikidoc_publish] $*"; }

# ── doil-wiki 컨테이너 재발행 ────────────────────────────────
log "1/2 doil-wiki 컨테이너 재발행 (--no-deps · 무중단)"

cd "$ROOT"

COMPOSE_ARGS=(up -d --no-deps)
if [ "$NO_BUILD" = false ]; then
  COMPOSE_ARGS+=(--build)
fi
COMPOSE_ARGS+=(doil-wiki)

docker compose "${COMPOSE_ARGS[@]}"

# ── 결과 안내 ────────────────────────────────────────────────
log "2/2 ✅ 발행 완료"
echo
echo "  Wiki : https://doil.me/wiki/"
