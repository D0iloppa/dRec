"""공유 Postgres(devdb)의 전용 database `drec` 연결 + 회의/조각 모델.

dev-net 별칭 충돌 회피를 위해 호스트는 `devdb` 를 쓴다(베이스 규약).
사전: 공유 db 컨테이너 가동 + `CREATE DATABASE drec` 1회 (README 참고).
"""

import os
from datetime import datetime

from sqlalchemy import String, Text, DateTime, Integer, ForeignKey, func, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine, AsyncSession
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

DB_HOST = os.environ.get("DB_HOST", "devdb")
DB_PORT = os.environ.get("DB_PORT", "5432")
DB_USER = os.environ.get("DB_USER", "doil")
DB_PASSWORD = os.environ.get("DB_PASSWORD", "")
DB_NAME = os.environ.get("DB_NAME", "drec")

DATABASE_URL = f"postgresql+asyncpg://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}"

engine = create_async_engine(DATABASE_URL, pool_pre_ping=True)
Session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class User(Base):
    """계정. 게스트는 uuid 만으로 등록(provider='guest'), OAuth 연동 시 provider/provider_sub 채움."""

    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)  # uuid4
    provider: Mapped[str] = mapped_column(String(32), default="guest")  # guest|google|github…
    provider_sub: Mapped[str | None] = mapped_column(String(255), nullable=True)  # OAuth subject(연동 시)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Meeting(Base):
    """한 번의 회의(라이브 녹음 세션 또는 업로드 1건)."""

    __tablename__ = "meetings"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(36), index=True, nullable=True)  # 소유 계정(게스트 uuid)
    title: Mapped[str] = mapped_column(String(512), default="")
    # recording → 라이브 녹음 중, processing → 회의록 생성 중, done, error
    status: Mapped[str] = mapped_column(String(32), default="done")
    transcript: Mapped[str] = mapped_column(Text, default="")
    # 자막 싱킹용 구간 배열(JSON 문자열): [{start,end,speaker,text}, …]. 화자분리 시에만 채워짐.
    segments: Mapped[str] = mapped_column(Text, default="")
    # 화자 메타(JSON 문자열): {"화자 A": {"name": "김부장", "color": "#e03e3e"}, …}. 사용자가 지정.
    speaker_meta: Mapped[str] = mapped_column(Text, default="")
    minutes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class MeetingChunk(Base):
    """라이브 녹음의 조각별 전사 텍스트(seq 순서로 조립)."""

    __tablename__ = "meeting_chunks"

    id: Mapped[int] = mapped_column(primary_key=True)
    meeting_id: Mapped[int] = mapped_column(ForeignKey("meetings.id", ondelete="CASCADE"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text, default="")


async def init_db() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # 기존 meetings 테이블에 컬럼 보강(create_all 은 컬럼 추가를 안 함).
        await conn.execute(text("ALTER TABLE meetings ADD COLUMN IF NOT EXISTS user_id VARCHAR(36)"))
        await conn.execute(text("CREATE INDEX IF NOT EXISTS ix_meetings_user_id ON meetings (user_id)"))
        await conn.execute(text("ALTER TABLE meetings ADD COLUMN IF NOT EXISTS segments TEXT DEFAULT ''"))
        await conn.execute(text("ALTER TABLE meetings ADD COLUMN IF NOT EXISTS speaker_meta TEXT DEFAULT ''"))
