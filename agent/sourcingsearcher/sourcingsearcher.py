#!/usr/bin/env python3
"""SourcingSearcher — 외주/커뮤니티 사이트를 LLM(playwright MCP)으로 둘러보며
개발 부업 영업대상을 발굴하고, 적합도·요약·영업전략을 담은 보고서를 메일로 보낸다.

단발 실행. 상시기동 불필요 — cron 이 실행할 때만 토큰을 소모한다.

흐름:
  seen 로드 → claude -p (playwright MCP 로 사이트 탐색·판단, 중복 제외) → JSON 리드 수신
  → 신규만 필터 → HTML 보고서 → agent@doil.me 발송 → seen 갱신
  (신규 0건이면 발송 생략 — 매시간 빈 메일 방지)

사용법:
    python3 sourcingsearcher.py          # 전체 파이프라인
    python3 sourcingsearcher.py --dry    # 발굴까지만, 발송·seen갱신 안 함 (출력만)

설정: .env — RECIPIENTS, SITES, PROFILE. SMTP 계정은 미지정 시 루트 .env 의
      POSTFIX_SASL_USERS 첫 항목을 사용. AI 는 claude CLI + playwright MCP(mcp.json).
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
from pathlib import Path

BASE = Path(__file__).resolve().parent
REPO_ROOT = BASE.parents[1]
MCP_CONFIG = BASE / "mcp.json"
KST = timezone(timedelta(hours=9))

sys.path.insert(0, str(BASE.parent))      # agent/ 공용 모듈
import agentdb as db                       # noqa: E402  — agent_db 중간계층

AGENT = "sourcingsearcher"
MODEL = "sonnet"          # 발굴/판단 모델. 비용 민감 — 필요 시 .env 의 MODEL 로 오버라이드
HEARTBEAT = 30            # 생성 중 경과 로그 간격 (초). 타임아웃 없음 — 끝까지 대기
MAX_LEADS = 8             # 한 회 보고서 최대 리드 수
LEAD_MAX_AGE_DAYS = 14    # 게시일이 이보다 오래된 의뢰글은 배제 (.env LEAD_MAX_AGE_DAYS 로 오버라이드)


def log(msg: str) -> None:
    print(f"[{datetime.now(KST):%H:%M:%S}] {msg}", flush=True)


def load_env() -> dict:
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


def parse_sites(raw: str) -> list[dict]:
    """SITES='이름|URL;이름|URL' → [{name, url}]"""
    sites = []
    for chunk in raw.split(";"):
        chunk = chunk.strip()
        if not chunk:
            continue
        name, _, url = chunk.partition("|")
        sites.append({"name": name.strip(), "url": (url or name).strip()})
    return sites


# ---------------------------------------------------------------- 발굴 (claude + playwright MCP)

PROMPT_TEMPLATE = """\
당신은 프리랜서 개발자의 영업 정찰병이다. playwright 브라우저 도구(mcp__playwright__*)와 \
필요 시 웹 검색으로 아래 사이트들을 실제로 둘러보고, 의뢰자가 올린 "개발 외주/일감" 글 중 \
이 개발자에게 맞는 건을 골라라.

[개발자 프로필]
{profile}

[탐색할 사이트] (각 URL 을 playwright 로 직접 열어 최신 목록을 살펴라. 로그인된 프로필이라 \
로그인이 필요한 목록도 보일 수 있다. 목록 URL 이 막히면 사이트 내 검색이나 웹 검색으로 우회하라.)
{sites}

[이미 보고한 항목 — 절대 다시 포함하지 말 것 (URL 기준)]
{seen}

[현재 시각] {now} (이 시각 기준으로 신선도를 판단하라)

[작업 지침]
- 각 사이트에서 최근에 올라온 의뢰글 위주로 살핀다. 광고·홍보·구인(정규직)·이미 마감된 글은 제외.
- **규모 필터(중요)**: 이 개발자는 본업이 있고 '부업/토이프로젝트'로 퇴근 후·주말에 병행할 소일거리를 찾는다.
  → 장기 상주·풀타임 전환·수개월/수천만원 규모의 대형 프리랜서 모집(예: "100일 2000~5000만원", "6개월 상주")은
     반드시 제외한다. 짧은 기간(수일~2~3주)·작은 단위·명확한 단발 작업만 고른다. 규모가 애매하면 보수적으로 제외.
- **게시일이 현재 시각보다 {max_age}일 넘게 지난 글은 배제한다.** 글의 게시일자를 확인하고,
  {max_age}일 이내인 건만 고른다. 게시일을 알 수 없으면 본문 맥락(마감 임박/상시 등)으로 최신 여부를 판단하되,
  명백히 오래됐거나 마감된 정황이면 제외한다. 확인한 게시일은 posted 필드에 기록한다.
- 프로필과 맞고, 단발성으로 수행 가능한 건만 고른다. 억지로 채우지 말 것 — 맞는 게 없으면 빈 배열.
- 최대 {max_leads}건. 적합도 높은 순으로.
- 각 건마다 영업 접근 전략(approach)을 간단히 제안한다: 무엇을 강조하고 어떻게 첫 제안을 던질지 1~2문장.

[출력 형식 — 엄격]
오직 JSON 배열 하나만 출력한다. 설명·마크다운·코드펜스 금지. 각 원소:
{{
  "title": "의뢰글 제목",
  "url": "의뢰글 직접 링크 (목록이 아니라 해당 글)",
  "site": "출처 사이트명",
  "posted": "게시일 (확인한 그대로, 예 2026-06-10 또는 '3일 전'. 모르면 빈 문자열)",
  "budget": "명시된 예산/기간 (없으면 빈 문자열)",
  "fit": "이 개발자에게 맞는 이유 한 줄",
  "summary": "의뢰 내용 executive summary 2~3문장",
  "approach": "영업 접근 전략 1~2문장"
}}
맞는 건이 없으면 [] 만 출력한다.
"""


def discover(env: dict, sites: list[dict], recent: list[str], now: datetime) -> list[dict]:
    model = env.get("MODEL", MODEL)
    try:
        max_age = int(env.get("LEAD_MAX_AGE_DAYS", LEAD_MAX_AGE_DAYS))
    except ValueError:
        max_age = LEAD_MAX_AGE_DAYS
    prompt = PROMPT_TEMPLATE.format(
        profile=env.get("PROFILE", "(프로필 미지정)"),
        sites="\n".join(f"- {s['name']}: {s['url']}" for s in sites),
        seen="\n".join(f"- {u}" for u in recent[:200]) or "(없음)",
        now=f"{now:%Y-%m-%d %H:%M (%a)}",
        max_age=max_age,
        max_leads=MAX_LEADS,
    )
    cmd = [
        "claude", "-p", "--model", model,
        "--mcp-config", str(MCP_CONFIG), "--strict-mcp-config",
        "--allowedTools", "mcp__playwright", "WebSearch", "WebFetch",
        "--permission-mode", "bypassPermissions",
        "--output-format", "text",
    ]
    log(f"Claude 발굴 시작 — 모델 {model}, 사이트 {len(sites)}곳 (playwright headless, 끝까지 대기)")
    proc = subprocess.Popen(
        cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, cwd=BASE,
    )
    start = time.monotonic()
    pending = prompt
    while True:
        try:
            stdout, stderr = proc.communicate(input=pending, timeout=HEARTBEAT)
            break
        except subprocess.TimeoutExpired:
            pending = None
            log(f"  … 탐색 중 ({int(time.monotonic() - start)}초 경과)")
    elapsed = int(time.monotonic() - start)
    if proc.returncode != 0:
        sys.exit(f"[데드로그] claude 실행 실패 (exit {proc.returncode}, {elapsed}초): "
                 f"{(stderr or '').strip()[:600] or '(stderr 없음)'}")
    log(f"발굴 완료 — 소요 {elapsed}초")
    return parse_leads(stdout)


def parse_leads(out: str) -> list[dict]:
    out = re.sub(r"^```(?:json)?\s*", "", out.strip())
    out = re.sub(r"\s*```$", "", out)
    m = re.search(r"\[.*\]", out, re.DOTALL)   # 본문 중 JSON 배열만 추출
    if not m:
        log(f"[경고] JSON 배열을 못 찾음. 원문 앞부분: {out[:200]}")
        return []
    try:
        leads = json.loads(m.group(0))
    except json.JSONDecodeError as e:
        sys.exit(f"[데드로그] 리드 JSON 파싱 실패: {e}\n원문: {out[:400]}")
    return [d for d in leads if isinstance(d, dict) and d.get("url")]


# ---------------------------------------------------------------- 보고서 / 발송

def render_html(leads: list[dict], date_str: str) -> str:
    def esc(s):
        return htmllib.escape(str(s or ""))

    cards = ""
    for i, d in enumerate(leads, 1):
        budget = f' · <span style="color:#a15">{esc(d.get("budget"))}</span>' if d.get("budget") else ""
        posted = f' · 게시 {esc(d.get("posted"))}' if d.get("posted") else ""
        cards += f"""
        <div style="border:1px solid #e0ddd5;border-radius:8px;padding:16px;margin:14px 0">
          <div style="font-size:12px;color:#888">#{i} · {esc(d.get('site'))}{posted}{budget}</div>
          <a href="{esc(d.get('url'))}" style="font-size:17px;font-weight:700;color:#1a1a1a;text-decoration:none">{esc(d.get('title'))}</a>
          <p style="margin:8px 0;color:#333;line-height:1.6">{esc(d.get('summary'))}</p>
          <p style="margin:6px 0;color:#2a6"><b>적합</b> {esc(d.get('fit'))}</p>
          <p style="margin:6px 0;color:#555;background:#f6f4ee;padding:8px;border-radius:6px">
            <b>🎯 영업전략</b> {esc(d.get('approach'))}</p>
        </div>"""
    return f"""<!DOCTYPE html><html lang="ko"><body style="margin:0;background:#faf9f5">
    <div style="max-width:680px;margin:auto;padding:24px;font-family:-apple-system,'Malgun Gothic',sans-serif">
      <div style="border-bottom:3px double #1a1a1a;padding-bottom:8px;margin-bottom:4px">
        <span style="font-size:24px;font-weight:800">SourcingSearcher</span>
        <span style="float:right;color:#888;font-size:13px;padding-top:10px">{date_str}</span>
      </div>
      <p style="color:#666;font-size:13px">신규 영업대상 {len(leads)}건 — 링크 · 적합도 · 요약 · 영업전략</p>
      {cards}
      <p style="color:#aaa;font-size:11px;border-top:1px solid #eee;padding-top:10px;margin-top:20px">
        자동 발굴 — 지원 전 의뢰글 원문과 마감/조건을 직접 확인하세요.</p>
    </div></body></html>"""


def smtp_credentials(env: dict) -> tuple[str, str]:
    if env.get("SMTP_USER") and env.get("SMTP_PASS"):
        return env["SMTP_USER"], env["SMTP_PASS"]
    first = env.get("POSTFIX_SASL_USERS", "").split(",")[0]
    if ":" not in first:
        sys.exit("SMTP 계정 없음: .env 의 SMTP_USER/SMTP_PASS 또는 루트 .env 의 POSTFIX_SASL_USERS 확인.")
    user, _, password = first.partition(":")
    return user, password


def _deliver(msg: MIMEText, env: dict) -> list[str]:
    recipients = [r.strip() for r in re.split(r"[;,]", env.get("RECIPIENTS", "")) if r.strip()]
    if not recipients:
        raise RuntimeError("RECIPIENTS 미설정: agent/sourcingsearcher/.env 에 RECIPIENTS 를 넣으세요.")
    user, password = smtp_credentials(env)
    msg["From"] = env.get("SMTP_FROM", "SourcingSearcher <agent@doil.me>")
    msg["To"] = ", ".join(recipients)
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    with smtplib.SMTP(env.get("SMTP_HOST", "localhost"), int(env.get("SMTP_PORT", "587")), timeout=30) as smtp:
        smtp.starttls(context=ctx)
        smtp.login(user, password)
        smtp.send_message(msg)
    return recipients


def send_mail(html: str, date_str: str, count: int, env: dict) -> None:
    msg = MIMEText(html, "html", "utf-8")
    msg["Subject"] = f"\U0001F50D SourcingSearcher — 신규 일감 {count}건 ({date_str})"
    log(f"메일 발송 완료 → {', '.join(_deliver(msg, env))}")


def send_error_mail(err_text: str, env: dict) -> None:
    """실패 시 에러 보고 메일. 어떤 이유로도 발송이 또 실패하면 로그만 남기고 삼킨다."""
    try:
        now = f"{datetime.now(KST):%Y-%m-%d %H:%M}"
        body = (f"<pre style='font:13px/1.5 monospace;white-space:pre-wrap;color:#a00'>"
                f"SourcingSearcher 실행 실패 — {now}\n\n{htmllib.escape(err_text)}</pre>")
        msg = MIMEText(body, "html", "utf-8")
        msg["Subject"] = f"⚠️ SourcingSearcher 오류 ({now})"
        log(f"에러 보고 메일 발송 → {', '.join(_deliver(msg, env))}")
    except Exception as e:
        log(f"[치명] 에러 보고 메일마저 실패: {e}")


# ---------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser(description="SourcingSearcher 영업대상 발굴 에이전트")
    ap.add_argument("--dry", action="store_true", help="발굴까지만 (발송·seen갱신 생략, 출력만)")
    args = ap.parse_args()

    env = load_env()
    now = datetime.now(KST)
    date_str = f"{now:%Y-%m-%d %H:%M}"
    sites = parse_sites(env.get("SITES", ""))
    if not sites:
        raise RuntimeError("SITES 미설정: agent/sourcingsearcher/.env 의 SITES 를 확인하세요.")

    # --dry: DB 변경 없이 발굴·신규판정만 미리보기
    if args.dry:
        leads = discover(env, sites, db.recent_urls(AGENT), now)
        new = db.filter_new(AGENT, leads, touch=False)
        log(f"[dry] 발굴 {len(leads)}건 · 신규 {len(new)}건")
        print(json.dumps(new, ensure_ascii=False, indent=2))
        return

    run_id = db.start_run(AGENT)             # 기동 시각 = runs.started_at 로 영속 기록
    log(f"기동 run#{run_id} — {now:%Y-%m-%d %H:%M:%S %Z} / 사이트 {len(sites)}곳")
    try:
        leads = discover(env, sites, db.recent_urls(AGENT), now)
        new = db.filter_new(AGENT, leads)    # 해시 기준 신규만 (기존은 last_seen 갱신)
        log(f"발굴 {len(leads)}건 · 신규 {len(new)}건")

        if new:
            send_mail(render_html(new[:MAX_LEADS], date_str), date_str, len(new), env)
            db.insert_reported(AGENT, new)   # status='reported' 로 영속
            log(f"리드 {len(new)}건 저장(reported)")
        else:
            log("신규 0건 — 메일 발송 생략 (정상: 오늘은 맞는 일감이 없음, 에러 아님)")

        db.finish_run(run_id, len(leads), len(new))
    except BaseException as e:               # 실패해도 run 을 error 로 마감 후 재발생 → 상위에서 메일
        db.fail_run(run_id, repr(e))
        raise


def run() -> None:
    """에러는 반드시 메일 보고. '신규 0건'은 정상 종료라 보고 대상이 아니다."""
    try:
        main()
    except SystemExit as e:
        # argparse 등 정상/관례적 종료(코드 0·정수)는 통과. 문자열 메시지는 우리 실패 → 보고.
        if isinstance(e.code, str) and e.code:
            log(f"[실패] {e.code}")
            send_error_mail(e.code, load_env())
            sys.exit(1)
        raise
    except Exception:
        import traceback
        tb = traceback.format_exc()
        log(f"[실패]\n{tb}")
        send_error_mail(tb, load_env())
        sys.exit(1)


if __name__ == "__main__":
    run()
