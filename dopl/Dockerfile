# DOPL 서버 prod 이미지 — 워크스페이스 설치 + tsc 빌드 후 apps/server 실행.
FROM node:20-alpine
WORKDIR /app

# 소스 전체 복사 (node_modules/dist는 .dockerignore로 제외)
COPY . .

# 워크스페이스 설치 + 서버측 패키지 빌드 (tsc -b: protocol/core/ox-quiz/server)
RUN npm install && npm run build

ENV NODE_ENV=production
ENV PORT=3100
EXPOSE 3100

CMD ["node", "apps/server/dist/index.js"]
