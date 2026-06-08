FROM node:22-alpine
WORKDIR /app

# doil-react와 동일한 빌더 전용 컨테이너:
# 앱을 빌드하고 종료한다. 실행 시 /app에 소스를 볼륨 마운트한다.
CMD ["sh", "-c", "npm install && npm run build"]
