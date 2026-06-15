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
PUBLISH_DIR = REPO_ROOT / "nginx" / "html" / "times"   # 정적 서빙 → https://doil.me/times/
SITE_URL = "https://doil.me/times"
RETENTION_DAYS = 30          # 발행물 보관 기간 — 초과분은 자동 삭제 (디스크 보호)
KST = timezone(timedelta(hours=9))

# 사이트 상단 내비 (AdSense 내비게이션 요건 + 사용자 이동)
NAV = ('<nav style="max-width:680px;margin:10px auto;font:13px/1.6 sans-serif;color:#888">'
       '<a href="/times/" style="color:#555;text-decoration:none">📰 DoilTimes</a> · '
       '<a href="/times/about.html" style="color:#555;text-decoration:none">소개</a> · '
       '<a href="/times/privacy.html" style="color:#555;text-decoration:none">개인정보처리방침</a></nav>')

# 언어 전환 탭 — 페이지 이동 없이 CSS display 로 .en/.ko/.kx 섹션을 보이고/숨김. (웹 전용; 기본 '영한')
TABS_CSS = (
    "<style>"
    ".dt-tabs{position:sticky;top:0;z-index:20;max-width:680px;margin:0 auto;padding:8px 10px;"
    "text-align:right;background:#f4f1ea}"
    ".dt-tabs button{font:13px/1 sans-serif;border:1px solid #ccc;background:#fff;color:#333;"
    "padding:5px 13px;margin-left:5px;border-radius:14px;cursor:pointer}"
    ".dt-tabs button.dt-active{background:#1a1a1a;color:#fff;border-color:#1a1a1a}"
    "body.dt-en .ko,body.dt-en .kx{display:none}"      # '영어' : 영어만
    "body.dt-ko .en,body.dt-ko .kx{display:none}"      # '한글' : 한글만
    "</style>"                                          # '영한'(dt-both): 숨김 규칙 없음 = 전체 표시
)
TABS_BODY = (
    '<div class="dt-tabs">'
    '<button class="dt-active" onclick="dtMode(\'both\',this)">영한</button>'
    '<button onclick="dtMode(\'en\',this)">영어</button>'
    '<button onclick="dtMode(\'ko\',this)">한글</button>'
    '</div>'
    '<script>function dtMode(m,b){var c=document.body.classList;'
    "c.remove('dt-en','dt-ko','dt-both');c.add('dt-'+m);"
    "document.querySelectorAll('.dt-tabs button').forEach(function(x){x.classList.remove('dt-active');});"
    'b.classList.add("dt-active");}'
    "document.body.classList.add('dt-both');</script>"
)

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
당신은 1인 신문 "DoilTimes"의 편집장이다. 아래 오늘자 기사 목록(JSON)을 읽고, 영어 학습용 영·한 신문
콘텐츠를 만들어 **JSON 으로만** 출력하라. (HTML 이 아니라 데이터만 — 레이아웃은 별도 시스템이 입힌다.)

작업:
- 기사 전체를 읽고 중요도 순으로 재배치한다. 톱기사 1건 선정(is_top). 비슷한 주제는 한 묶음으로 합쳐도 된다.
- 광고·중복·시시한 항목은 버린다. 8~12건 내외로 추린다.
- 각 기사를 영어와 한국어 "같은 내용"으로(번역 대응) 작성한다. 영어는 중급 학습자용으로 자연스럽게(직역체 금지).
- 판 성격 반영: "{edition}" 이 "조간"이면 밤사이~오전 소식, "석간"이면 낮 동안의 소식 정리 톤.
- AI 논평(view)은 단순 요약 반복 금지 — 맥락·전망·비판적 시각.

출력 형식(엄수): 아래 스키마의 JSON 객체 하나만. 설명·마크다운·코드펜스 금지. { 로 시작.
{
  "articles": [
    {
      "is_top": true,
      "url": "원문 링크",
      "en": {"title": "English title", "summary": "1~2 sentences", "view": "AI's commentary"},
      "ko": {"title": "한국어 제목", "summary": "1~2문장 요약", "view": "AI 논평"},
      "kx": [{"term": "expression/word", "meaning": "한국어 뜻"}]
    }
  ],
  "column": {"en": "Editor's Column, 3-5 sentences on the day's overall flow",
             "ko": "오늘의 시선, 같은 내용 한국어"}
}
- kx 는 기사당 2~3개. Hacker News 기사도 동일 형식. 맞는 기사가 없으면 articles 는 빈 배열.

기사 목록:
__ARTICLES_JSON__
"""


# 프로세스 자체가 죽거나 빈 출력일 때만 재호출(살릴 게 없으므로). 깨진 JSON 은 재호출이 아니라 로컬 복구로 처리.
PROC_RETRIES = 2


def _claude_raw(prompt: str, label: str) -> str:
    """claude 를 호출해 원문(text)을 반환. 프로세스 실패/빈 출력일 때만 제한적 재호출. 하트비트 로그."""
    for attempt in range(1, PROC_RETRIES + 1):
        tag = label if attempt == 1 else f"{label} (재호출 {attempt}/{PROC_RETRIES})"
        log(f"Claude 호출 — 모델 {MODEL}, {tag} (타임아웃 없음, 끝까지 대기)")
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
        if proc.returncode == 0 and stdout.strip():
            log(f"생성 완료 — 소요 {elapsed}초")
            return stdout
        log(f"  ⚠ claude 실패(exit {proc.returncode}, {elapsed}초, 출력 {len(stdout.strip())}자): "
            f"{(stderr or '').strip()[:300] or '(stderr 없음)'}")
    return ""


def _save_raw(raw: str, edition: str) -> Path:
    """AI 원문을 항상 파일로 보존 — 파싱 실패 시 사후 분석·수동 복구용 (타임스탬프로 덮어쓰기 방지)."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    p = OUTPUT_DIR / f"raw_{datetime.now(KST):%Y%m%d_%H%M}_{edition}.txt"
    p.write_text(raw, encoding="utf-8")
    return p


def _scan_object(s: str, start: int) -> tuple[str | None, int]:
    """s[start]='{' 부터 균형 맞는 객체를 스캔(문자열/이스케이프 고려). 끝까지 안 닫히면(=끊김) (None, len)."""
    depth = 0
    in_str = esc = False
    for k in range(start, len(s)):
        c = s[k]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return s[start:k + 1], k + 1
    return None, len(s)


def _salvage_articles(span: str) -> dict | None:
    """깨진/끊긴 JSON 에서 articles 배열의 '완성된 기사 객체'만 회수.
    끊김 → 마지막 미완성 건 버림, 중간 한 건만 깨짐 → 그 건만 스킵. (전체 재요청 없이 로컬 복구)"""
    i = span.find('"articles"')
    if i == -1:
        return None
    lb = span.find("[", i)
    if lb == -1:
        return None
    arts: list[dict] = []
    j, n = lb + 1, len(span)
    while j < n:
        while j < n and span[j] not in "{]":
            j += 1
        if j >= n or span[j] == "]":
            break
        obj, end = _scan_object(span, j)
        if obj is None:            # 마지막 객체가 끊김 → 중단
            break
        try:
            arts.append(json.loads(obj, strict=False))
        except json.JSONDecodeError:
            pass                   # 이 한 건만 버리고 계속
        j = end
    if not arts:
        return None
    out: dict = {"articles": arts}
    cm = re.search(r'"column"\s*:\s*(\{.*?\})', span, re.DOTALL)   # column 도 가능하면 회수
    if cm:
        try:
            out["column"] = json.loads(cm.group(1), strict=False)
        except json.JSONDecodeError:
            pass
    return out


def _parse_news_json(raw: str) -> tuple[dict | None, str]:
    """원문 → 뉴스 JSON. 단계: (1) 정상 (2) strict=False (3) 부분 회수. 어떤 경로였는지 함께 반환."""
    text = raw.strip()
    if "```" in text:                                       # 코드펜스 제거
        fm = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
        if fm:
            text = fm.group(1).strip()
    start = text.find("{")
    if start == -1:
        return None, "JSON 객체 없음"
    last = text.rfind("}")
    if last > start:                                        # 닫힘이 있으면 통째 파싱 시도
        closed = text[start:last + 1]
        try:
            return json.loads(closed), "정상"
        except json.JSONDecodeError:
            pass
        try:
            # strict=False: 문자열 내 제어문자(개행 등) 허용 → 사소한 깨짐 흡수
            return json.loads(closed, strict=False), "strict=False 복구"
        except json.JSONDecodeError:
            pass
    salv = _salvage_articles(text[start:])                  # 끊김/단일 깨짐 → 부분 회수
    if salv and salv.get("articles"):
        return salv, f"부분 회수({len(salv['articles'])}건)"
    return None, "복구 불가"


HEADLINE_PROMPT = """\
아래는 발행한 신문 한 호의 본문이다. 이를 종합해 그날의 흐름을 대표하는
1면 머리기사형 한국어 헤드라인 한 줄을 만들어라.
- 20자 내외, 제목용 명사구. 따옴표·마침표·부연 없이 헤드라인 문구만 한 줄로 출력.

신문 본문:
__SOURCE__
"""


def _synthesize_headline(source: str, label: str) -> str:
    """본문 텍스트를 소스로 claude 를 호출해 한 줄 헤드라인을 합성. 실패 시 빈 문자열."""
    if not source.strip():
        return ""
    raw = _claude_raw(HEADLINE_PROMPT.replace("__SOURCE__", source), label)
    if not raw.strip():
        return ""
    line = raw.strip().splitlines()[0].strip()
    return line.strip('"').strip("'").strip()[:60]


def generate_headline(data: dict) -> str:
    """발행 본문(한국어 제목 + 칼럼)을 소스로 한 줄 헤드라인을 합성.
    큰 생성 JSON 과 분리 — 부분 회수(절단)된 경우에도 안정적으로 뽑힌다.
    실패하면 빈 문자열 → 호출부가 톱기사 제목으로 폴백."""
    titles = "\n".join(
        f"- {t}" for a in data.get("articles", [])
        if (t := ((a.get("ko") or {}).get("title") or "").strip()))
    if not titles:
        return ""
    column = (data.get("column") or {}).get("ko", "") or "(없음)"
    source = f"기사 제목:\n{titles}\n\n편집장 칼럼:\n{column}"
    return _synthesize_headline(source, "헤드라인 합성")


def generate_html(articles: list[dict], date_str: str, edition: str) -> str:
    # .format() 은 JSON 스키마의 중괄호와 충돌하므로 literal replace 사용
    prompt = (PROMPT_TEMPLATE
              .replace("{edition}", edition)
              .replace("__ARTICLES_JSON__", json.dumps(articles, ensure_ascii=False, indent=1)))
    raw = _claude_raw(prompt, f"기사 {len(articles)}건")
    if raw.strip():
        rawpath = _save_raw(raw, edition)                   # 원문 항상 보존(사후 복구용)
        data, mode = _parse_news_json(raw)
        if data and data.get("articles"):
            if mode != "정상":
                log(f"  ⚠ JSON 폴백 적용: {mode} (원문 보존: {rawpath})")
            headline = generate_headline(data)
            return render_news_html(data, date_str, edition, headline)
        log(f"  ⚠ AI JSON 복구 불가({mode}) → 비-AI 폴백판 발행. 원문 보존: {rawpath}")
    else:
        log("  ⚠ Claude 출력 없음 → 비-AI 폴백판 발행")
    # 최종 폴백: 발행 누락(빈 신문/메일 0통)보다 스크랩 헤드라인만이라도 신문으로 내보낸다
    return fallback_html(articles, date_str, edition)


def render_news_html(data: dict, date_str: str, edition: str, headline: str = "") -> str:
    """Claude 가 만든 콘텐츠(JSON)에 HTML 구조와 .en/.ko/.kx class 를 입힌다.
    class 는 파이썬이 보장하므로 언어 탭 토글이 항상 정확히 동작한다."""
    def esc(s):
        return htmllib.escape(str(s or ""))

    SERIF = "Georgia,'Times New Roman','Nanum Myeongjo',serif"
    blocks = ""
    for a in data.get("articles", []):
        en, ko = a.get("en", {}), a.get("ko", {})
        top = a.get("is_top")
        ten = "30px" if top else "21px"
        toplabel = ('<div style="color:#a01e1e;font:700 12px Georgia,serif;letter-spacing:1.5px;'
                    'margin-bottom:6px">★ TOP STORY · 오늘의 머릿기사</div>') if top else ""
        kx = "".join(
            f'<li style="margin:3px 0"><i>{esc(k.get("term"))}</i> — {esc(k.get("meaning"))}</li>'
            for k in a.get("kx", []) if k.get("term"))
        blocks += f"""
        <article style="border-bottom:1px solid #ddd4c2;padding:20px 0">
          {toplabel}
          <div class="en"><a href="{esc(a.get('url'))}" style="display:block;font:800 {ten}/1.25 {SERIF};
            color:#1a1a1a;text-decoration:none">{esc(en.get('title'))}</a></div>
          <div class="ko"><div style="border-left:3px solid #a01e1e;padding-left:9px;margin:9px 0;
            font:600 15px {SERIF};color:#555">"{esc(ko.get('title'))}"</div></div>
          <div class="en"><p style="margin:9px 0;line-height:1.7;color:#222;font-family:{SERIF}">
            <sup style="color:#999;font-weight:700">EN</sup> {esc(en.get('summary'))}</p></div>
          <div class="ko"><p style="margin:9px 0;line-height:1.75;color:#333;font-family:{SERIF}">
            <sup style="color:#999;font-weight:700">KO</sup> {esc(ko.get('summary'))}</p></div>
          <div style="background:#efe9da;border-radius:6px;padding:11px 14px;margin:10px 0">
            <div style="font:700 13px {SERIF};color:#1a1a1a;margin-bottom:5px">🔵 AI's View</div>
            <div class="en"><p style="margin:4px 0;line-height:1.65;color:#333;font-family:{SERIF}">
              <sup style="color:#999;font-weight:700">EN</sup> {esc(en.get('view'))}</p></div>
            <div class="ko"><p style="margin:4px 0;line-height:1.7;color:#333;font-family:{SERIF}">
              <sup style="color:#999;font-weight:700">KO</sup> {esc(ko.get('view'))}</p></div>
          </div>
          <div class="kx" style="background:#f3eee1;border-radius:6px;padding:10px 14px;margin:8px 0">
            <div style="font:700 13px {SERIF};color:#1a1a1a">🔑 Key Expressions</div>
            <ul style="margin:6px 0 0;padding-left:18px;font:13px/1.5 {SERIF};color:#555">{kx or '<li>—</li>'}</ul>
          </div>
        </article>"""

    col = data.get("column", {})
    column_html = f"""
        <section style="margin-top:22px;background:#efe9da;border-radius:8px;padding:16px 18px">
          <div class="en"><div style="font:800 16px {SERIF}">📝 Editor's Column</div>
            <p style="line-height:1.75;color:#222;font-family:{SERIF}">{esc(col.get('en'))}</p></div>
          <div class="ko"><div style="font:800 16px {SERIF};margin-top:8px">📝 오늘의 시선</div>
            <p style="line-height:1.8;color:#333;font-family:{SERIF}">{esc(col.get('ko'))}</p></div>
        </section>""" if (col.get("en") or col.get("ko")) else ""

    # 마스트헤드 요소
    hero_url = f"{SITE_URL}/hero.png"
    edition_en = "MORNING EDITION" if edition == "조간" else "EVENING EDITION"
    launch = datetime(2026, 6, 11, tzinfo=KST)
    days = (datetime.now(KST).date() - launch.date()).days
    issue_no = max(1, days * 2 + (0 if edition == "조간" else 1) + 1)
    titles = [esc((a.get("en") or {}).get("title", "")) for a in data.get("articles", [])][:6]
    ticker = " &nbsp;·&nbsp; ".join(" ".join(t.split()[:6]) for t in titles if t)

    # 목록(/times/ 인덱스)용 헤드라인 — 합성 결과(generate_headline) 우선, 없으면 톱기사 한국어 제목으로 폴백.
    # rebuild_index 가 발행 HTML 에서 회수하므로 head 메타로 영구 보존한다.
    headline = (headline or "").strip()
    if not headline:
        for a in data.get("articles", []):
            if a.get("is_top"):
                headline = ((a.get("ko") or {}).get("title") or "").strip()
                break

    return f"""<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="dt:headline" content="{esc(headline)}">
<title>DoilTimes {edition} — {date_str}</title></head>
<body style="margin:0;background:#f4f1ea;font-family:{SERIF};color:#1a1a1a">
<div style="max-width:680px;margin:auto;background:#f4f1ea">

  <header style="background:#1a1815;color:#f4f1ea;padding:16px 22px 0;text-align:center">
    <img src="{hero_url}" alt="" width="84"
         style="width:84px;height:84px;border-radius:50%;object-fit:cover;filter:grayscale(35%);margin-bottom:6px">
    <div style="font:11px Georgia,serif;letter-spacing:4px;color:#c9a227">{edition_en} · {edition}</div>
    <div style="border-top:1px solid #4a443a;border-bottom:1px solid #4a443a;margin:8px 0;padding:6px 0">
      <span style="font:800 46px {SERIF};letter-spacing:1px">DoilTimes</span>
    </div>
    <table width="100%" style="border-collapse:collapse"><tr>
      <td style="font:10px Georgia,serif;letter-spacing:1px;color:#9a9384;text-align:left">1면 미디어 · INDEPENDENT</td>
      <td style="font:13px Georgia,serif;color:#c9a227;text-align:center">{date_str}</td>
      <td style="font:10px Georgia,serif;letter-spacing:1px;color:#9a9384;text-align:right">제 {issue_no} 호</td>
    </tr></table>
    <div style="background:#100e0b;margin:10px -22px 0;padding:7px 22px;font:11px Georgia,serif;
      letter-spacing:.3px;color:#cfc8bb;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
      <b style="color:#a01e1e;letter-spacing:1px">TODAY</b> &nbsp; {ticker}</div>
  </header>

  <div style="padding:18px 22px">
    {blocks or '<p style="color:#aaa">오늘은 발행할 기사가 없습니다.</p>'}
    {column_html}
    <p style="color:#9a9384;font:11px Georgia,serif;border-top:1px solid #ddd4c2;padding-top:12px;margin-top:22px">
      AI가 매일 뉴스를 요약·논평하는 영어 학습용 자동 브리핑 · 원문은 각 제목 링크 참조</p>
  </div>
</div></body></html>"""


def fallback_html(articles: list[dict], date_str: str, edition: str) -> str:
    """--no-ai 배선 테스트용 단순 HTML (토큰 0)."""
    items = "".join(
        f'<li><b>[{a["source"]}]</b> <a href="{a["link"]}">{htmllib.escape(a["title"])}</a>'
        f'<br><small>{htmllib.escape(a["summary"])}</small></li>'
        for a in articles
    )
    return (f"<!DOCTYPE html><html><body style='max-width:680px;margin:auto'>"
            f"<h1>DoilTimes {edition} (배선 테스트)</h1><p>{date_str}</p><ul>{items}</ul></body></html>")


# ---------------------------------------------------------------- 웹 발행 (doil.me/times)

def adsense_snippet(client: str) -> str:
    if not client:
        return ""
    return (f'<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js'
            f'?client={client}" crossorigin="anonymous"></script>')


def adsense_unit(client: str, slot: str) -> str:
    """페이지 최하단 디스플레이 광고 유닛. client·slot 둘 다 있을 때만 렌더(없으면 빈 문자열)."""
    if not (client and slot):
        return ""
    return (f'<ins class="adsbygoogle" style="display:block;max-width:680px;margin:14px auto"'
            f' data-ad-client="{client}" data-ad-slot="{slot}"'
            f' data-ad-format="auto" data-full-width-responsive="true"></ins>'
            f'<script>(adsbygoogle=window.adsbygoogle||[]).push({{}});</script>')


def _inject_head(html: str, extra: str) -> str:
    if not extra:
        return html
    if "</head>" in html:
        return html.replace("</head>", extra + "\n</head>", 1)
    if "<head>" in html:
        return html.replace("<head>", "<head>\n" + extra, 1)
    return re.sub(r"(<body[^>]*>)", r"<head>" + extra + r"</head>\1", html, count=1) or (extra + html)


def _inject_body_top(html: str, extra: str) -> str:
    m = re.search(r"<body[^>]*>", html)
    return html[:m.end()] + extra + html[m.end():] if m else extra + html


def _inject_body_bottom(html: str, extra: str) -> str:
    if not extra:
        return html
    return html.replace("</body>", extra + "</body>", 1) if "</body>" in html else html + extra


def publish_web(html: str, now: datetime, edition: str, env: dict, target: Path) -> str:
    """광고 스니펫 + 내비를 주입해 정적 HTML 로 발행. 발행 URL 반환."""
    client = env.get("ADSENSE_CLIENT", "")
    web = _inject_head(html, adsense_snippet(client) + TABS_CSS)
    web = _inject_body_top(web, NAV + TABS_BODY)
    web = _inject_body_bottom(web, adsense_unit(client, env.get("ADSENSE_SLOT", "")))
    target.mkdir(parents=True, exist_ok=True)
    fname = f"{now:%Y-%m-%d}_{edition}.html"
    (target / fname).write_text(web, encoding="utf-8")
    if target == PUBLISH_DIR:
        rebuild_index(env)
    return f"{SITE_URL}/{fname}"


DT_HEADLINE_RE = re.compile(r'<meta name="dt:headline" content="([^"]*)">')


def _read_headline(path: Path) -> str:
    """발행 HTML 의 dt:headline 메타를 회수. 없으면 빈 문자열(구판/비-AI 폴백판)."""
    try:
        head = path.read_text(encoding="utf-8")[:4000]   # 메타는 <head> 안 — 앞부분만 읽음
    except OSError:
        return ""
    m = DT_HEADLINE_RE.search(head)
    return htmllib.unescape(m.group(1)).strip() if m else ""


def _html_to_text(html: str) -> str:
    """발행 HTML → 헤드라인 합성용 평문. script/style 제거 후 태그를 벗긴다."""
    s = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", html, flags=re.DOTALL | re.IGNORECASE)
    s = re.sub(r"<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", htmllib.unescape(s)).strip()


def backfill_headline(path: Path) -> str:
    """발행 HTML 본문으로 헤드라인을 합성해 dt:headline 메타에 반영(주입/교체). 합성된 헤드라인 반환.
    head 가 없는 폴백판은 건너뛴다(빈 문자열)."""
    html = path.read_text(encoding="utf-8")
    headline = _synthesize_headline(_html_to_text(html)[:6000], f"헤드라인 합성 {path.name}")
    if not headline:
        return ""
    meta = f'<meta name="dt:headline" content="{htmllib.escape(headline)}">'
    if DT_HEADLINE_RE.search(html):
        html = DT_HEADLINE_RE.sub(meta, html, count=1)
    elif "</head>" in html:
        html = html.replace("</head>", meta + "</head>", 1)
    else:
        return ""                       # head 없음(폴백판) → 메타 주입 불가
    path.write_text(html, encoding="utf-8")
    return headline


def run_gen_title(env: dict) -> None:
    """발행된 HTML 중 헤드라인이 없는 호에 본문 기반 헤드라인을 백필하고 인덱스를 재생성한다.
    기존 발행물(과거 호) 마이그레이션용 — 스크래핑/발행/메일 없음."""
    files = sorted(PUBLISH_DIR.glob("20*_*.html"), reverse=True)
    done = skipped = failed = 0
    for p in files:
        if _read_headline(p):                  # 이미 보유 → 토큰 절약 위해 건너뜀
            skipped += 1
            continue
        h = backfill_headline(p)
        if h:
            log(f"헤드라인 백필: {p.name} → {h}")
            done += 1
        else:
            log(f"  ⚠ 백필 실패/건너뜀(폴백판?): {p.name}")
            failed += 1
    log(f"백필 완료 — 신규 {done}건, 기존 보유 {skipped}건, 실패 {failed}건")
    rebuild_index(env)


def rebuild_index(env: dict) -> None:
    """발행된 날짜별 글을 모아 /times/ 인덱스 페이지 + posts.json 매니페스트 재생성.
    보관기간(RETENTION_DAYS) 초과 발행물은 먼저 삭제한다 (디스크 보호)."""
    cutoff = (datetime.now(KST) - timedelta(days=RETENTION_DAYS)).strftime("%Y-%m-%d")
    for p in PUBLISH_DIR.glob("20*_*.html"):
        if p.stem.partition("_")[0] < cutoff:      # 파일명 날짜(YYYY-MM-DD) 문자열 비교
            p.unlink(missing_ok=True)
            log(f"보관기간 초과 삭제: {p.name}")
    posts = sorted(PUBLISH_DIR.glob("20*_*.html"), reverse=True)
    # 매니페스트 (홈페이지 DoilTimes 섹션이 fetch) — 최신순. 헤드라인은 파일당 한 번만 회수.
    manifest = []
    items = ""
    for p in posts:
        date, _, ed = p.stem.partition("_")
        headline = _read_headline(p)
        manifest.append({"date": date, "edition": ed, "url": f"/times/{p.name}", "headline": headline})
        head_html = (f' <span style="color:#888">— {htmllib.escape(headline)}</span>'
                     if headline else "")
        items += (f'<li style="margin:6px 0"><a href="/times/{p.name}" '
                  f'style="color:#1a1a1a">{date} · {ed}</a>{head_html}</li>')
    (PUBLISH_DIR / "posts.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    html = f"""<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DoilTimes — AI 뉴스 브리핑</title>
<meta name="description" content="AI가 매일 주요 뉴스를 요약하고 논평하는 자동 브리핑 신문, DoilTimes.">
{adsense_snippet(env.get("ADSENSE_CLIENT", ""))}</head>
<body style="font-family:-apple-system,'Malgun Gothic',sans-serif;background:#faf9f5;margin:0">
<div style="max-width:680px;margin:auto;padding:24px">
{NAV}
<div style="border-bottom:3px double #1a1a1a;padding-bottom:8px"><span style="font-size:26px;font-weight:800">DoilTimes</span></div>
<p style="color:#555;line-height:1.7">AI가 매일 아침·저녁으로 주요 뉴스를 직접 읽고 요약·논평하는 자동 브리핑 신문입니다.
사람의 시선과 다른 'AI의 시선'으로 그날의 흐름을 정리합니다.</p>
<h2 style="font-size:16px;border-bottom:1px solid #ddd;padding-bottom:4px">지난 호</h2>
<ul style="list-style:none;padding:0">{items or '<li style="color:#aaa">아직 발행된 글이 없습니다.</li>'}</ul>
{adsense_unit(env.get("ADSENSE_CLIENT", ""), env.get("ADSENSE_SLOT", ""))}
<p style="color:#aaa;font-size:11px;border-top:1px solid #eee;padding-top:10px;margin-top:24px">
© DoilTimes · 본 사이트의 요약·논평은 AI가 자동 생성하며, 원문 출처는 각 글의 링크를 따릅니다.</p>
</div></body></html>"""
    (PUBLISH_DIR / "index.html").write_text(html, encoding="utf-8")


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
    ap.add_argument("--gen-title", action="store_true",
                    help="발행된 HTML 본문으로 헤드라인을 백필 (과거 호 마이그레이션). 스크래핑/발행/메일 없음")
    ap.add_argument("--edition", choices=["조간", "석간"], help="판 강제 지정 (미지정 시 실행 시각으로 자동 판정 — 누락 판 백필용)")
    args = ap.parse_args()

    env = load_env()

    if args.gen_title:                       # 마이그레이션 모드 — 발행/메일 없이 헤드라인만 백필
        log("헤드라인 백필 모드 (--gen-title)")
        run_gen_title(env)
        return

    now = datetime.now(KST)
    edition = args.edition or ("조간" if now.hour < 12 else "석간")   # 정오 기준: 오전=조간, 오후=석간
    date_str = f"{now:%Y년 %m월 %d일} ({'월화수목금토일'[now.weekday()]})"
    log(f"{edition} 발행 시작 — {date_str}")

    articles = scrape()
    if not articles:
        sys.exit("기사 0건 — 발행 중단")
    log(f"총 {len(articles)}건 수집")

    html = (fallback_html(articles, date_str, edition) if args.no_ai
            else generate_html(articles, date_str, edition))

    # 웹 발행 — --no-ai(배선 테스트)는 라이브 사이트 대신 output/ 으로
    target = OUTPUT_DIR if args.no_ai else PUBLISH_DIR
    url = publish_web(html, now, edition, env, target)
    log(f"웹 발행: {url if target is PUBLISH_DIR else target}")

    if args.no_mail:
        log("--no-mail: 메일 발송 생략")
        return

    # 메일은 광고 없이(정책) — 상단에 '웹에서 보기' 배너만 추가
    banner = (f'<div style="max-width:680px;margin:0 auto 12px;font:13px sans-serif;color:#888">'
              f'웹에서 보기: <a href="{url}" style="color:#36c">{url}</a></div>')
    send_mail(_inject_body_top(html, banner), date_str, edition, env)


if __name__ == "__main__":
    main()
