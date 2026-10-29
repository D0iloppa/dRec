#!/usr/bin/env bash
# dRec 재빌드·재배포 (빌드가 끝날 때까지 기존 컨테이너는 계속 동작)
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose build drec
docker compose up -d drec
sleep 8
docker ps --filter name=^drec$ --format 'drec: {{.Status}}'
curl -fsS https://drec.doil.me/api/health && echo
docker exec drec env | grep '^DREC_REC_'
