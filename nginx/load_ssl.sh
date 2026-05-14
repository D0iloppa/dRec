#!/bin/bash
# SSL 인증서 갱신 후 doil-gw 볼륨에 복사하는 스크립트
# letsencrypt live/ 는 심볼릭 링크이므로 반드시 -L 옵션 사용
# 실행: cd /mnt/c/DEV/docker/nginx && sudo bash load_ssl.sh

# doil.chickenkiller.com
sudo cp -L /etc/letsencrypt/live/doil.chickenkiller.com/fullchain.pem ./live/doil.chickenkiller.com/
sudo cp -L /etc/letsencrypt/live/doil.chickenkiller.com/privkey.pem ./live/doil.chickenkiller.com/

# doil.me (+ 서브도메인: saigon.doil.me, ohno.doil.me 등 공유)
sudo cp -L /etc/letsencrypt/live/doil.me/fullchain.pem ./live/doil.me/
sudo cp -L /etc/letsencrypt/live/doil.me/privkey.pem ./live/doil.me/

# nginx 설정 재로드 (무중단)
echo "nginx reload..."
docker exec doil-gw nginx -s reload

echo "완료! 인증서가 갱신되었습니다."
