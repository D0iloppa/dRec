#!/bin/bash

# Navigate to the directory where this script is located (w_dev/docker)
cd "$(dirname "$0")"

echo "Building React static files..."
docker-compose run --rm doil-react-builder

echo "Copying built files to Nginx html directory..."
# 다른 앱의 정적 산출물(sb=/sb/app, dopl=dopl.doil.me)은 보존하고 doil-react 것만 교체.
find ./nginx/html -mindepth 1 -maxdepth 1 ! -name sb ! -name dopl -exec rm -rf {} +
cp -r ./doil-react/dist/* ./nginx/html/

echo "Reloading Nginx..."
docker exec doil-gw nginx -s reload

echo "Deployment complete. React app is now live."
