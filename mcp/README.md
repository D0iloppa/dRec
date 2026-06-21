# dRec MCP 서버

dobis ↔ dRec 연동용 **stdio MCP 서버**. dRec 의 회의 녹취(STT) → 회의록 정리 파이프라인을
MCP 도구로 노출해, dobis(호스트의 claude)가 도구 호출로 회의를 처리/조회한다.

```
dobis worker (host) ─ claude --mcp-config mcp.json
        └─ spawn(stdio): node dRec/mcp/index.js
              └─ HTTPS: https://drec.doil.me/api/*  (게이트웨이 → drec 컨테이너)
```

> MCP 서버는 dRec 컨테이너가 **아니라 호스트에서** 실행되며, 게이트웨이 너머의 REST API 를 호출한다.

## 도구

| 도구 | 설명 |
|---|---|
| `list_meetings(q?)` | 회의 목록(최신순 50건), q 로 검색 |
| `get_meeting(id)` | 상세: transcript / segments / speaker_meta / minutes |
| `process_audio(file_path)` | 오디오 파일 업로드 → 전사+화자분리+회의록. **비동기**(즉시 job_id 반환) |
| `job_status(job_id)` | 비동기 잡 상태/결과 폴링(running\|done\|error) |
| `create_session(title?)` | 라이브 녹음 세션 생성 |
| `add_chunk(id, seq, file_path)` | 미리보기 조각 전사 |
| `upload_audio(id, file_path)` | 전체 녹음 업로드 |
| `finish_session(id)` | 종료 → 화자분리 전사+회의록. **비동기**(즉시 job_id 반환) |
| `rename_meeting(id, title)` | 제목 변경 |
| `set_speakers(id, meta)` | 화자 메타 설정 |
| `delete_meeting(id)` | 삭제 |

## 인증

dRec 의 모든 `/api/*` 는 게스트(uuid)+JWT(만료 없음) 인증을 요구한다. 이 서버는 최초 1회
`POST /api/auth/guest` 로 **dobis 전용 고정 신원**을 발급받아 `.drec_token.json`(gitignore)에
저장하고 이후 재사용한다 → dobis 가 만든 회의 이력이 호출 간 유지된다.

## 설정(환경변수, 모두 선택)

| 키 | 기본값 | 용도 |
|---|---|---|
| `DREC_API_URL` | `https://drec.doil.me` | dRec API 베이스 URL |
| `DREC_TOKEN` | (없음) | 고정 토큰 직접 주입(설정 시 게스트 발급 생략) |
| `DREC_TOKEN_FILE` | `<이 디렉터리>/.drec_token.json` | 발급 토큰 보관 위치 |

## 설치 / 등록

```bash
cd dRec/mcp && npm install
```

dobis `mcp.json` 에 등록(이미 추가됨):

```json
"drec": { "type": "stdio", "command": "node", "args": ["/mnt/c/DEV/docker/dRec/mcp/index.js"], "env": {} }
```

그리고 dobis `.env` 의 `DOBIS_ALLOWED_TOOLS` 에 `mcp__drec__*` 포함.
