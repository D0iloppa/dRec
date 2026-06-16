"""회의록 생성 — 전사 텍스트를 기존 claude CLI(OAuth)로 정리한다.

별도 API 키 없이, 로그인된 claude CLI 를 서브프로세스로 호출한다(2단계).
stdin 으로 (지시문 + 전사본)을 파이프하고 -p(print) 모드로 결과를 받는다.
  DREC_CLAUDE_MODEL : 사용할 모델 (기본 claude-opus-4-8)
  DREC_CLAUDE_BIN   : claude 실행 파일 경로 (기본 claude)
"""

import os
import subprocess

MODEL = os.environ.get("DREC_CLAUDE_MODEL", "claude-opus-4-8")
CLAUDE_BIN = os.environ.get("DREC_CLAUDE_BIN", "claude")

PROMPT = """당신은 회의록 작성 전문가입니다. 아래 회의 전사본(STT 결과)을 한국어 회의록으로 정리하세요.
전사본에는 오인식·잡음이 섞일 수 있으니 맥락으로 보정하되, 없는 내용을 지어내지 마세요.

다음 Markdown 구조로 출력하세요:

# 회의록
## 한 줄 요약
## 주요 논의
- (핵심 논점들)
## 결정 사항
- (확정된 결정)
## 액션 아이템
- [ ] 할 일 — 담당자(가능하면) / 기한(가능하면)
## 미해결 이슈
- (보류·추가 논의 필요)

회의록만 출력하고 다른 설명은 붙이지 마세요.

---전사본---
"""


def make_minutes(transcript: str, timeout: int = 300) -> str:
    """전사본을 받아 회의록 Markdown 문자열을 반환한다."""
    stdin = PROMPT + transcript
    result = subprocess.run(
        [CLAUDE_BIN, "-p", "--model", MODEL],
        input=stdin,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        raise RuntimeError(f"claude CLI 실패 (code {result.returncode}): {result.stderr.strip()}")
    return result.stdout.strip()
