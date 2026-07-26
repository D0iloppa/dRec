"""계정 생성 CLI — 서버 관리자 전용(회원가입 엔드포인트는 없다).

사용:
    docker compose exec drec python -m app.create_account_cli <username> <password>
"""

import argparse
import sys

from .accounts import create_account


def main() -> int:
    parser = argparse.ArgumentParser(description="dRec 계정 생성")
    parser.add_argument("username")
    parser.add_argument("password")
    args = parser.parse_args()

    try:
        create_account(args.username, args.password)
    except ValueError as e:
        print(f"실패: {e}", file=sys.stderr)
        return 1
    print(f"계정 생성 완료: {args.username}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
