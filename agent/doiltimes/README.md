# DoilTimes

오늘자 뉴스를 스크래핑하고, Claude(편집장)가 논평을 붙인 신문 HTML 을 발행해 메일로 보내는 단발 실행 에이전트.
상시기동 없음 — cron 이 깨울 때만 토큰을 소모한다.

```
스크래핑 (RSS, 토큰 0) → claude -p (HTML 신문 생성, 1회 호출) → output/ 저장 → postfix(localhost:587) 발송
```

## 실행

```bash
cd agent/doiltimes
python3 doiltimes.py              # 전체 파이프라인
python3 doiltimes.py --no-ai      # 배선 테스트 (AI 생략, 토큰 0)
python3 doiltimes.py --no-mail    # 발행(HTML 저장)까지만
```

- 의존성: 파이썬 표준 라이브러리만 사용. `claude` CLI 필요.
- 설정: `.env` 의 `RECIPIENTS` (쉼표 구분). SMTP 계정은 자동으로 레포 루트 `.env` 의
  `POSTFIX_SASL_USERS` 를 사용 (오버라이드는 `.env.example` 참고).
- 발신: `news@doil.me` — postfix 가 DKIM 서명, SPF(`v=spf1 mx -all`) 정렬됨.

## cron 등록 (수동 테스트 통과 후)

```bash
# OAuth 토큰 발급 (1회): claude setup-token
crontab -e
```

```cron
# 매일 07:00(조간) / 18:00(석간) KST — DoilTimes 발행 (시각만 다르고 명령 동일 → 7,18 한 줄)
# 로그는 '>' (덮어쓰기)로 — 매 실행 시 마지막 분만 남아 파일이 안 커진다. 백업 불필요.
0 7,18 * * * /mnt/c/DEV/docker/agent/doiltimes/run.sh > /mnt/c/DEV/docker/agent/doiltimes/output/cron.log 2>&1
```

- `run.sh` 가 `~/.doiltimes.env`(OAuth 토큰)를 자동 로드하므로 crontab 에 토큰을 직접 쓸 필요 없다.
- 판 구분은 파이썬이 실행 시각으로 자동 판정한다 (정오 전=조간, 정오 후=석간). cron 시각만 바꾸면 됨.
- 발송 성공 시 `output/` 의 HTML 은 자동 삭제된다. 실패하면 디버깅용으로 보존된다.

> WSL 주의: WSL 이 내려가 있으면 cron 도 안 돈다. systemd cron 활성화 또는
> Windows 작업 스케줄러에서 `wsl -e ...` 로 트리거하는 방법을 고려할 것.

## 피드 변경

`doiltimes.py` 상단 `FEEDS` 리스트 수정 (이름, RSS URL, 최대 기사 수).
