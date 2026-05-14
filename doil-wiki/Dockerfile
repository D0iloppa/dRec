# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Stage 1: Builder
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FROM node:20-alpine AS builder

WORKDIR /app

ENV NODE_OPTIONS="--max-old-space-size=4096"

# 의존성 설치 (캐시 효율화 — package.json 먼저 복사)
COPY package.json package-lock.json ./
RUN npm install --legacy-peer-deps

# 소스 전체 복사 후 프로덕션 빌드
# CI=true: webpack ProgressPlugin 비활성화 (Docker 빌드 환경 호환)
COPY . .
RUN CI=true npm run build

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Stage 2: Serve (Nginx Alpine)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FROM nginx:alpine AS serve

# Docusaurus 빌드 결과물을 /wiki/ 경로로 서빙
# baseUrl: '/wiki/' 설정과 일치
COPY --from=builder /app/build /usr/share/nginx/html/wiki

# Nginx 설정 — /wiki/ 경로 처리 + SPA fallback
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
