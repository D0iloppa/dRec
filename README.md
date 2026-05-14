# d0il gateway

> 소중한 백업용 🗄️

`doil.me` 서버 인프라 설정 및 서비스 소스코드 백업 저장소입니다.

## 구성

| 디렉토리 | 설명 |
|---|---|
| `nginx/` | doil-gw nginx 리버스 프록시 설정 |
| `doil-react/` | 게이트웨이 메인 페이지 (React + Vite) |
| `doil-wiki/` | 개발 위키 (Docusaurus) |
| `docker-compose.yml` | 서비스 컨테이너 정의 |
| `page_deploy.sh` | React 빌드 & 배포 스크립트 |

## 제외 항목

민감하거나 불필요한 항목은 `.gitignore`로 제외됩니다.

- `lsh_*` — 레거시 서비스
- `postgres_lsh/` — DB 데이터
- `nginx/live/` — SSL 인증서
- `nginx/cdn/` — CDN 에셋
- `*.sql` — DB 덤프


```
./wikidoc_publish.sh             # 빌드 + 발행
./wikidoc_publish.sh --no-build  # 재기동만 (빌드 생략)
```