# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is the `doil.me` server infrastructure repository — a Docker Compose–based monorepo that hosts the gateway homepage, wiki, and sandbox services, plus legacy LSH services. It serves as the backup/source of truth for what runs on the production server.

## Architecture

```
Nginx (doil-gw) → routes by path/subdomain
  /             → static React build (doil-react → nginx/html)
  /wiki/        → doil-wiki (Docusaurus, nginx:alpine)
  /sb/          → doil-sb (Express.js)
  /api/         → doil-sb (API gateway)
  /mm/          → Mattermost (messaging)
  /op/          → OpenProject (project management)
  /cdn/         → imgproxy (image optimization)
  /lsh*/        → legacy lsh_* containers (Vite dev servers)
  /lsh_api/     → host.docker.internal:8180 (external Java API)

External subdomains:
  jenkins.doil.me   → host.docker.internal:8080
  doybrary.doil.me  → kavita:5000
  ohno.doil.me      → host.docker.internal:18080 (FastAPI)
  blog.doil.me      → Naver Blog redirect
```

All containers share the external Docker network `dev-net` (must be created separately before `docker compose up`).

## Services

| Service | Directory | Tech | Notes |
|---------|-----------|------|-------|
| doil-gw | nginx/ | nginx:latest | Reverse proxy, TLS termination |
| doil-react | doil-react/ | React + Vite | Builder-only container; outputs to nginx/html |
| doil-wiki | doil-wiki/ | Docusaurus | Multi-stage build → nginx:alpine |
| doil-sb | doil-sb/ | Express.js | Sandbox + API gateway + MCP host |
| mattermost | — | Mattermost Team | Messaging (`/mm/`), uses `db` |
| openproject | — | OpenProject 15 | Project management (`/op/`) |
| db | dev_db/ | PostgreSQL | Main dev DB (`dev` + `mattermost` dbs, user: `doil`) |

## Common Commands

### Docker (production-style)
```bash
docker compose up -d                    # Start all services
docker compose up -d --build doil-wiki  # Rebuild and restart wiki
docker compose logs -f doil-gw          # Tail nginx logs
```

### Deploy React frontend
```bash
# From inside doil-react/ or via deploy script:
./page_deploy.sh          # Build React + copy dist to nginx/html
```

### Deploy wiki (zero-downtime)
```bash
./wikidoc_publish.sh               # Full rebuild + redeploy
./wikidoc_publish.sh --no-build    # Redeploy without rebuild
```

### doil-react (React + Vite)
```bash
cd doil-react
npm run dev       # Vite dev server
npm run build     # Production build → dist/
npm run lint      # ESLint
npm run preview   # Preview production build locally
```

### doil-wiki (Docusaurus)
```bash
cd doil-wiki
npm run start     # Dev server
npm run build     # Static HTML build → build/
npm run deploy    # GitHub Pages deployment
```

### doil-sb (Express.js)
```bash
cd doil-sb
npm run dev       # Nodemon hot-reload dev
npm run start     # Production start
```

## Key File Locations

- **Nginx site config**: `nginx/conf.d/doil.me.conf`
- **Static React output**: `nginx/html/` (populated by `page_deploy.sh`)
- **SSL certs**: `nginx/live/doil.me/` (LetsEncrypt, managed by certbot, gitignored)
- **DB init scripts**: `dev_db/init/001_dev_context.sql`, `002_dev_context_seed.sql`
- **CDN assets**: `nginx/cdn/` (gitignored — large binaries)

## Nginx Routing Notes

- `doil-react` is a **builder-only** container (Docker profile). It runs `npm install && npm run build`, writes to a volume, then exits. The nginx container serves the output as static files.
- The wiki Dockerfile uses a multi-stage build: Node 20 builds Docusaurus, then copies the output into nginx:alpine. The base path is `/wiki/`.
- LSH services (`lsh_react`, `lsh_staff`, `lsh_admin`) are legacy dev-only containers that run Vite dev servers — they are not built for production.

## Database

- **Container**: `db` (PostgreSQL)
- **Exposed port**: 5432 (localhost)
- **Database**: `dev`, **User**: `doil`
- Legacy LSH uses a separate `db_lsh` container with its data directory gitignored.

## What Is Gitignored

Large or sensitive items not in the repo:
- `lsh_*/` — legacy service directories
- `nginx/live/` — SSL certificates
- `nginx/cdn/`, `cdn_storage/` — CDN binary assets
- `postgres_lsh/` — legacy DB data
- `.env`, `.env.local` — secrets
