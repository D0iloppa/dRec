```
# 인증서 갱신
sudo zerossl-bot certonly \
  --webroot \
  --webroot-path=/home/doil/workspace/w_dev/docker/nginx/html \
  -d doil.chickenkiller.com \
  -d dev.doil.chickenkiller.com \
  --email kdi3939@gmail.com
```




```
# 인증서 갱신 이후, docker로 파일 전송 필요
sudo cp -L /etc/letsencrypt/live/doil.chickenkiller.com/fullchain.pem \
  /home/doil/workspace/w_dev/docker/nginx/live/doil.chickenkiller.com/fullchain.pem

sudo cp -L /etc/letsencrypt/live/doil.chickenkiller.com/privkey.pem \
  /home/doil/workspace/w_dev/docker/nginx/live/doil.chickenkiller.com/privkey.pem

# nginx 갱신신
docker exec -it doil-gw nginx -s reload
```