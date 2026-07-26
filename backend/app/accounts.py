"""계정(id/pw) 저장소 — SQLite. 회원가입 API 없음: 계정 생성은 CLI(`-m app.create_account_cli`)로만.

비밀번호는 되돌릴 수 없는 salted hash(bcrypt)로 저장한다.
Postgres 쪽 users/meetings 스키마와는 무관하다 — JWT `sub` 에 username 을 담으면
기존 current_user/_owned 로직이 그대로 동작한다.
"""

import os
import sqlite3
from datetime import datetime, timezone

from passlib.hash import bcrypt

# main.py 의 DATA_DIR 과 동일한 환경변수/기본값(compose 볼륨 drec_data:/data 로 영속화).
DATA_DIR = os.environ.get("DREC_DATA_DIR", "/data")
DB_PATH = os.path.join(DATA_DIR, "accounts.db")


def init_accounts_db() -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS accounts ("
            "username TEXT PRIMARY KEY, "
            "password_hash TEXT NOT NULL, "
            "created_at TEXT NOT NULL)"
        )


def create_account(username: str, password: str) -> None:
    """계정 추가. 이미 있으면 ValueError."""
    init_accounts_db()
    now = datetime.now(timezone.utc).isoformat()
    try:
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute(
                "INSERT INTO accounts (username, password_hash, created_at) VALUES (?, ?, ?)",
                (username, bcrypt.hash(password), now),
            )
    except sqlite3.IntegrityError:
        raise ValueError(f"이미 존재하는 계정: {username}")


def verify_login(username: str, password: str) -> bool:
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute(
            "SELECT password_hash FROM accounts WHERE username = ?", (username,)
        ).fetchone()
    if not row:
        return False
    return bcrypt.verify(password, row[0])
