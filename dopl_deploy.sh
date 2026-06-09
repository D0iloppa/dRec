#!/bin/bash
# DOPL 클라이언트 배포 — vite 빌드 → nginx/html/dopl 로 복사 → nginx reload.
# (서버는 docker compose up -d dopl-server 로 별도 기동)
cd "$(dirname "$0")"
DEST="./nginx/html/dopl"

echo "Building dopl client..."
docker run --rm -v "$(pwd)/dopl":/w -w /w node:20-alpine \
  sh -c "npm install --silent && npm run build --workspace=@dopl/client"

echo "Copying to ${DEST} ..."
mkdir -p "${DEST}"
rm -rf "${DEST:?}/"*
cp -r ./dopl/apps/client/dist/* "${DEST}/"

echo "Reloading nginx..."
docker exec doil-gw nginx -s reload

echo "Done: https://dopl.doil.me"
