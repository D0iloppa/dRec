"""비밀번호 재설정 CLI — 서버 관리자 전용. 계정 로그인/기존 비밀번호 확인 없이
컨테이너 접근 권한(docker exec)만으로 강제 변경한다 — 비밀번호를 잊어버렸을 때 대비.

사용:
    docker compose exec drec python -m app.change_password_cli <username> <new_password>
"""

import argparse
import sys

from .accounts import set_password


def main() -> int:
    parser = argparse.ArgumentParser(description="dRec 비밀번호 강제 재설정")
    parser.add_argument("username")
    parser.add_argument("new_password")
    args = parser.parse_args()

    try:
        set_password(args.username, args.new_password)
    except ValueError as e:
        print(f"실패: {e}", file=sys.stderr)
        return 1
    print(f"비밀번호 변경 완료: {args.username}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
