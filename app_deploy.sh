#!/bin/bash

# doil-app 배포 스크립트
# doil-app(React)을 빌드해 nginx/html/sb/app 로 복사하고 nginx를 reload 한다.
# 루트(/) 정적 파일은 건드리지 않는다 — /sb/app 경로만 갱신.

cd "$(dirname "$0")"

DEST="./nginx/html/sb/app"

echo "Building doil-app static files..."
docker compose run --rm doil-app-builder

echo "Copying built files to ${DEST} ..."
mkdir -p "${DEST}"
rm -rf "${DEST:?}/"*
cp -r ./doil-app/dist/* "${DEST}/"

echo "Reloading Nginx..."
docker exec doil-gw nginx -s reload

echo "Deployment complete. doil-app is now live at https://www.doil.me/sb/app"
