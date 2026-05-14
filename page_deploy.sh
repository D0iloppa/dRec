#!/bin/bash

# Navigate to the directory where this script is located (w_dev/docker)
cd "$(dirname "$0")"

echo "Building React static files..."
docker-compose run --rm doil-react-builder

echo "Copying built files to Nginx html directory..."
rm -rf ./nginx/html/*
cp -r ./doil-react/dist/* ./nginx/html/

echo "Reloading Nginx..."
docker exec doil-gw nginx -s reload

echo "Deployment complete. React app is now live."
