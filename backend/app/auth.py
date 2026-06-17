"""인증 — 게스트(uuid) + JWT. OAuth 연동 시 같은 user 행에 provider/provider_sub 만 채우면 된다.

  DREC_JWT_SECRET : JWT 서명 비밀키(필수, .env). 미설정 시 기동 거부.

토큰은 게스트 신원 토큰이라 만료를 두지 않는다(브라우저 localStorage 보관). 발급: POST /api/auth/guest.
"""

import os

import jwt
from fastapi import Header, HTTPException

SECRET = os.environ.get("DREC_JWT_SECRET", "").strip()
ALGO = "HS256"


def issue_token(user_id: str) -> str:
    if not SECRET:
        raise RuntimeError("DREC_JWT_SECRET 미설정")
    return jwt.encode({"sub": user_id}, SECRET, algorithm=ALGO)


def _decode(token: str) -> str:
    try:
        payload = jwt.decode(token, SECRET, algorithms=[ALGO])
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="invalid token")
    sub = payload.get("sub")
    if not sub:
        raise HTTPException(status_code=401, detail="invalid token")
    return sub


async def current_user(authorization: str = Header("")) -> str:
    """Authorization: Bearer <jwt> → user_id. 없으면 401."""
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing token")
    return _decode(authorization[len("Bearer "):])


def user_from_token_str(token: str) -> str:
    """쿼리스트링 등 헤더 외 경로(<audio> 태그)용 토큰 검증."""
    return _decode(token)
