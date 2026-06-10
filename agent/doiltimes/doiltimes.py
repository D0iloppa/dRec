#!/usr/bin/env python3
"""DoilTimes — 오늘자 뉴스 스크래핑 → Claude 논평 → HTML 발행 → 메일 발송.

단발 실행 스크립트. 상시기동 불필요 — cron 이 실행할 때만 토큰을 소모한다.

사용법:
    python3 doiltimes.py              # 전체 파이프라인 (스크래핑 → AI 생성 → 발행 → 발송)
    python3 doiltimes.py --no-ai      # AI 생성 생략. 배선(스크래핑/발송) 테스트용, 토큰 0
    python3 doiltimes.py --no-mail    # 발행(output/ HTML 저장)까지만, 메일 미발송

설정: .env (이 폴더) — RECIPIENTS 필수. SMTP 계정은 미지정 시
      레포 루트 .env 의 POSTFIX_SASL_USERS 첫 항목을 사용한다.
AI:   claude CLI (Claude Code). cron 등록 시 CLAUDE_CODE_OAUTH_TOKEN 환경변수 필요
      (`claude setup-token` 으로 발급).
"""
from __future__ import annotations

import argparse
import html as htmllib
import json
import re
import smtplib
import ssl
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from email.mime.text import MIMEText
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.request import Request, urlopen
from xml.etree import ElementTree as ET

BASE = Path(__file__).resolve().parent
REPO_ROOT = BASE.parents[1]          # /mnt/c/DEV/docker
OUTPUT_DIR = BASE / "output"
KST = timezone(timedelta(hours=9))

# (이름, RSS URL, 최대 기사 수)
FEEDS = [
    ("전자신문",   "https://rss.etnews.com/Section901.xml", 7),
    ("연합뉴스",   "https://www.yna.co.kr/rss/news.xml", 7),
    ("한경 IT",    "https://www.hankyung.com/feed/it", 7),
    ("Hacker News", "https://news.ycombinator.com/rss", 5),
]
FRESH_HOURS = 36          # 이 시간 안에 발행된 기사만 (pubDate 없으면 통과)
MODEL = "sonnet"          # 신문 생성용 모델 — 요약/논평엔 sonnet 으로 충분
HEARTBEAT = 30            # 생성 중 경과 로그 간격 (초). 타임아웃은 없음 — 끝까지 대기
UA = "Mozilla/5.0 (DoilTimes/1.0; +https://doil.me)"


def log(msg: str) -> None:
    print(f"[{datetime.now(KST):%H:%M:%S}] {msg}", flush=True)


def load_env() -> dict:
    """이 폴더 .env + 레포 루트 .env(POSTFIX_SASL_USERS 용)를 병합. 폴더 쪽이 우선."""
    env = {}
    for path in (REPO_ROOT / ".env", BASE / ".env"):
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def smtp_credentials(env: dict) -> tuple[str, str]:
    if env.get("SMTP_USER") and env.get("SMTP_PASS"):
        return env["SMTP_USER"], env["SMTP_PASS"]
    sasl = env.get("POSTFIX_SASL_USERS", "")
    first = sasl.split(",")[0]
    if ":" not in first:
        sys.exit("SMTP 계정 없음: .env 에 SMTP_USER/SMTP_PASS 를 넣거나 루트 .env 의 POSTFIX_SASL_USERS 를 확인하세요.")
    user, _, password = first.partition(":")
    return user, password


# ---------------------------------------------------------------- 스크래핑

def strip_tags(s: str) -> str:
    return htmllib.unescape(re.sub(r"<[^>]+>", "", s or "")).strip()


def fetch_feed(name: str, url: str, limit: int) -> list[dict]:
    req = Request(url, headers={"User-Agent": UA})
    with urlopen(req, timeout=15) as resp:
        root = ET.fromstring(resp.read())

    cutoff = datetime.now(timezone.utc) - timedelta(hours=FRESH_HOURS)
    articles = []
    for item in root.iter("item"):
        title = strip_tags(item.findtext("title", ""))
        link = (item.findtext("link") or "").strip()
        if not title or not link:
            continue
        pub = item.findtext("pubDate", "")
        if pub:
            try:
                if parsedate_to_datetime(pub) < cutoff:
                    continue
            except (TypeError, ValueError):
                pass
        articles.append({
            "source": name,
            "title": title,
            "link": link,
            "summary": strip_tags(item.findtext("description", ""))[:300],
        })
        if len(articles) >= limit:
            break
    return articles


def scrape() -> list[dict]:
    all_articles = []
    for name, url, limit in FEEDS:
        try:
            got = fetch_feed(name, url, limit)
            log(f"스크래핑 {name}: {len(got)}건")
            all_articles.extend(got)
        except Exception as e:  # 피드 하나 죽어도 발행은 계속
            log(f"스크래핑 {name} 실패: {e}")
    return all_articles


# ---------------------------------------------------------------- AI 발행

PROMPT_TEMPLATE = """\
당신은 1인 신문 "DoilTimes"의 편집장이다. 아래 오늘자 기사 목록(JSON)으로 신문 HTML을 만들어라.

요구사항:
- 완성된 단일 HTML 문서 하나만 출력한다. 설명·마크다운 코드펜스 금지. <!DOCTYPE html> 로 시작할 것.
- 이메일 본문용 HTML: 인라인 스타일만 사용, JS/외부 CSS/외부 폰트 금지, 본문 폭 max-width 680px 중앙 정렬.
- 신문 느낌의 머리판: 제호 "DoilTimes", 판 종류 "{edition}", 날짜 {date_str}, 가는 괘선.
  ("조간"이면 밤사이~오전 소식 정리, "석간"이면 낮 동안의 소식 정리라는 성격을 머리판/칼럼 톤에 반영.)
- 기사 전체를 읽고 중요도 순으로 재배치하고, 톱기사 1건을 골라 크게 다룬다. 출처별 나열 금지.
- 각 기사: 제목(원문 링크 <a>), 한 줄 요약, 그리고 "🤖 AI의 시선" — 편집장으로서의 짧은 논평(1~2문장, 단순 요약 반복 금지, 맥락·전망·비판적 시각).
- 비슷한 주제의 기사는 한 묶음으로 처리해도 된다.
- 마지막에 "오늘의 시선" 섹션: 오늘 뉴스 전체를 관통하는 흐름에 대한 편집장 칼럼 3~5문장.
- 전부 한국어 (Hacker News 기사도 한국어로 요약·논평).

기사 목록:
{articles_json}
"""


def generate_html(articles: list[dict], date_str: str, edition: str) -> str:
    prompt = PROMPT_TEMPLATE.format(
        date_str=date_str,
        edition=edition,
        articles_json=json.dumps(articles, ensure_ascii=False, indent=1),
    )
    log(f"Claude 호출 — 모델 {MODEL}, 기사 {len(articles)}건 (타임아웃 없음, 끝까지 대기)")
    proc = subprocess.Popen(
        ["claude", "-p", "--model", MODEL, "--output-format", "text"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, cwd=BASE,
    )
    start = time.monotonic()
    pending_input = prompt
    while True:
        try:
            stdout, stderr = proc.communicate(input=pending_input, timeout=HEARTBEAT)
            break
        except subprocess.TimeoutExpired:
            pending_input = None
            log(f"  … 생성 중 ({int(time.monotonic() - start)}초 경과)")
    elapsed = int(time.monotonic() - start)
    if proc.returncode != 0:
        sys.exit(f"[데드로그] claude 실행 실패 (exit {proc.returncode}, {elapsed}초): "
                 f"{(stderr or '').strip()[:500] or '(stderr 없음)'}")
    log(f"생성 완료 — 소요 {elapsed}초")
    out = stdout.strip()
    # 코드펜스로 감싸 나오는 경우 방어
    out = re.sub(r"^```(?:html)?\s*", "", out)
    out = re.sub(r"\s*```$", "", out)
    if "<html" not in out.lower():
        sys.exit(f"claude 출력이 HTML 이 아님: {out[:200]}")
    return out


def fallback_html(articles: list[dict], date_str: str, edition: str) -> str:
    """--no-ai 배선 테스트용 단순 HTML (토큰 0)."""
    items = "".join(
        f'<li><b>[{a["source"]}]</b> <a href="{a["link"]}">{htmllib.escape(a["title"])}</a>'
        f'<br><small>{htmllib.escape(a["summary"])}</small></li>'
        for a in articles
    )
    return (f"<!DOCTYPE html><html><body style='max-width:680px;margin:auto'>"
            f"<h1>DoilTimes {edition} (배선 테스트)</h1><p>{date_str}</p><ul>{items}</ul></body></html>")


# ---------------------------------------------------------------- 발송

def send_mail(html: str, date_str: str, edition: str, env: dict) -> None:
    recipients = [r.strip() for r in re.split(r"[;,]", env.get("RECIPIENTS", "")) if r.strip()]
    if not recipients:
        sys.exit("RECIPIENTS 미설정: agent/doiltimes/.env 에 RECIPIENTS=a@b.c;d@e.f 를 넣으세요.")
    user, password = smtp_credentials(env)
    host = env.get("SMTP_HOST", "localhost")
    port = int(env.get("SMTP_PORT", "587"))
    sender = env.get("SMTP_FROM", "DoilTimes <agent@doil.me>")

    msg = MIMEText(html, "html", "utf-8")
    msg["Subject"] = f"\U0001F4F0 DoilTimes {edition} — {date_str}"
    msg["From"] = sender
    msg["To"] = ", ".join(recipients)

    ctx = ssl.create_default_context()
    ctx.check_hostname = False                 # postfix 자체 서명 인증서 (localhost 릴레이)
    ctx.verify_mode = ssl.CERT_NONE
    with smtplib.SMTP(host, port, timeout=30) as smtp:
        smtp.starttls(context=ctx)
        smtp.login(user, password)
        smtp.send_message(msg)
    log(f"메일 발송 완료 → {', '.join(recipients)}")


# ---------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser(description="DoilTimes 발행 에이전트")
    ap.add_argument("--no-ai", action="store_true", help="AI 생성 생략 (배선 테스트, 토큰 0)")
    ap.add_argument("--no-mail", action="store_true", help="메일 발송 생략 (HTML 발행까지만)")
    args = ap.parse_args()

    env = load_env()
    now = datetime.now(KST)
    edition = "조간" if now.hour < 12 else "석간"   # 정오 기준: 오전=조간, 오후=석간
    date_str = f"{now:%Y년 %m월 %d일} ({'월화수목금토일'[now.weekday()]})"
    log(f"{edition} 발행 시작 — {date_str}")

    articles = scrape()
    if not articles:
        sys.exit("기사 0건 — 발행 중단")
    log(f"총 {len(articles)}건 수집")

    html = (fallback_html(articles, date_str, edition) if args.no_ai
            else generate_html(articles, date_str, edition))

    OUTPUT_DIR.mkdir(exist_ok=True)
    out_path = OUTPUT_DIR / f"DoilTimes_{now:%Y-%m-%d}_{edition}.html"
    out_path.write_text(html, encoding="utf-8")
    log(f"발행: {out_path}")

    if args.no_mail:
        log("--no-mail: 발송 생략 (HTML 보존)")
        return

    send_mail(html, date_str, edition, env)
    # 발송 성공 시에만 도달 — 실패하면 send_mail 에서 예외로 중단되어 HTML 보존
    out_path.unlink()
    log(f"발송 성공 → HTML 삭제: {out_path.name}")


if __name__ == "__main__":
    main()
