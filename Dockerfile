# dRec — 단일 컨테이너 멀티스테이지.
#   1) 프론트(Vite/React) 빌드  2) python 백엔드가 dist 서빙 + /api 처리
# 백엔드는 회의록 생성에 claude CLI(Claude Code)를 subprocess 로, 전사에 ffmpeg+whisper 를 쓴다.

# 1) 프론트 빌드
FROM node:20-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# 2) 백엔드 런타임 (python + node + ffmpeg + claude CLI)
FROM python:3.12-slim
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && npm install -g @anthropic-ai/claude-code \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./
COPY --from=web /web/dist ./web/dist

ENV DREC_STATIC_DIR=/app/web/dist
EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
