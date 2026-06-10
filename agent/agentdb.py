"""agent_db 접근 중간계층 — 여러 에이전트가 공유하는 운영 데이터 레이어.

격리된 별도 DB(`agent_db`, role `agent`, 컨테이너 `db`)에 붙는다.
접속 문자열은 환경변수 AGENT_DB_DSN (run.sh 가 ~/.agents.env 에서 주입).

제공: 링크 dedup(해싱) · 리드 영속/진척도 · 실행/에러 기록.
스키마 정의는 agent/sql/agent_db_init.sql 참고.
"""
from __future__ import annotations

import hashlib
import os
from contextlib import contextmanager
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import psycopg2
import psycopg2.extras

_TRACKING = {"utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
             "ref", "referer", "fbclid", "gclid", "spm"}


def dsn() -> str:
    d = os.environ.get("AGENT_DB_DSN")
    if not d:
        raise RuntimeError("AGENT_DB_DSN 미설정 — ~/.agents.env 에 export AGENT_DB_DSN=... 가 있는지 확인 "
                           "(run.sh 가 source 한다).")
    return d


@contextmanager
def connect():
    conn = psycopg2.connect(dsn(), connect_timeout=10)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ---------------------------------------------------------------- URL 해싱

def normalize_url(u: str) -> str:
    """추적 파라미터·트레일링 슬래시·대소문자 차이를 흡수 → 같은 글의 URL 변형을 한 키로."""
    try:
        p = urlsplit(u.strip())
    except ValueError:
        return u.strip()
    host = p.netloc.lower()
    path = p.path.rstrip("/") or "/"
    q = sorted((k, v) for k, v in parse_qsl(p.query) if k.lower() not in _TRACKING)
    return urlunsplit((p.scheme.lower(), host, path, urlencode(q), ""))


def url_hash(u: str) -> str:
    return hashlib.sha256(normalize_url(u).encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------- 실행 기록

def start_run(agent: str) -> int:
    with connect() as c, c.cursor() as cur:
        cur.execute("INSERT INTO runs(agent) VALUES (%s) RETURNING id", (agent,))
        return cur.fetchone()[0]


def finish_run(run_id: int, found: int, new: int, status: str = "ok", error: str | None = None) -> None:
    with connect() as c, c.cursor() as cur:
        cur.execute(
            "UPDATE runs SET finished_at=now(), found=%s, new=%s, status=%s, error=%s WHERE id=%s",
            (found, new, status, (error or "")[:4000] or None, run_id),
        )


def fail_run(run_id: int | None, error: str) -> None:
    if run_id is None:
        return
    try:
        with connect() as c, c.cursor() as cur:
            cur.execute("UPDATE runs SET finished_at=now(), status='error', error=%s WHERE id=%s",
                        (error[:4000], run_id))
    except Exception:
        pass  # DB 기록 실패가 에러 보고를 막지 않도록 삼킨다


# ---------------------------------------------------------------- 리드 dedup / 영속

def recent_urls(agent: str, limit: int = 200) -> list[str]:
    """프롬프트에 넘길 '이미 본' URL 목록 (LLM 측 1차 dedup)."""
    with connect() as c, c.cursor() as cur:
        cur.execute("SELECT url FROM leads WHERE agent=%s ORDER BY last_seen DESC LIMIT %s",
                    (agent, limit))
        return [r[0] for r in cur.fetchall()]


def filter_new(agent: str, leads: list[dict], touch: bool = True) -> list[dict]:
    """해시 기준 신규만 반환. touch=True 면 기존 항목 last_seen 갱신(다시 봤다는 기록).
    touch=False 는 읽기전용(--dry 미리보기용 — DB 변경 없음)."""
    if not leads:
        return []
    by_hash = {url_hash(d["url"]): d for d in leads if d.get("url")}
    with connect() as c, c.cursor() as cur:
        cur.execute("SELECT url_hash FROM leads WHERE url_hash = ANY(%s)", (list(by_hash),))
        existing = {r[0] for r in cur.fetchall()}
        if touch and existing:
            cur.execute("UPDATE leads SET last_seen=now() WHERE url_hash = ANY(%s)", (list(existing),))
    return [d for h, d in by_hash.items() if h not in existing]


def insert_reported(agent: str, leads: list[dict]) -> None:
    """신규 리드를 status='reported' 로 저장 (보고 메일 발송 직후 호출)."""
    if not leads:
        return
    rows = [(
        agent, url_hash(d["url"]), d["url"], d.get("title"), d.get("site"),
        d.get("posted"), d.get("budget"), d.get("fit"), d.get("summary"), d.get("approach"),
    ) for d in leads]
    with connect() as c, c.cursor() as cur:
        psycopg2.extras.execute_values(cur, """
            INSERT INTO leads
              (agent, url_hash, url, title, site, posted, budget, fit, summary, approach,
               status, reported_at)
            VALUES %s
            ON CONFLICT (url_hash) DO UPDATE SET last_seen=now()
        """, rows, template="(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'reported',now())")
