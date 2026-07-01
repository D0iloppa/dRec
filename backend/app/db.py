"""공유 Postgres(devdb)의 전용 database `drec` 연결 + 회의/조각 모델."""

import os
import uuid as _uuid
from datetime import datetime

from sqlalchemy import String, Text, DateTime, Integer, Float, ForeignKey, func, text
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
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    provider: Mapped[str] = mapped_column(String(32), default="guest")
    provider_sub: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Meeting(Base):
    """한 번의 회의(라이브 녹음 세션 또는 업로드 1건)."""

    __tablename__ = "meetings"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(36), index=True, nullable=True)
    title: Mapped[str] = mapped_column(String(512), default="")
    # recording → 라이브 녹음 중
    # processing → 화자분리 실행 중
    # transcribed → 화자분리 완료, 회의록 미생성
    # processing_minutes → 회의록 생성 중
    # done → 완료
    # error → 파이프라인 오류
    status: Mapped[str] = mapped_column(String(32), default="done")
    transcript: Mapped[str] = mapped_column(Text, default="")
    # 화자분리 세그먼트 JSON: [{start,end,speaker,text}, …]
    segments: Mapped[str] = mapped_column(Text, default="")
    # 화자 메타 JSON: {"화자 A": {"name": "김부장", "color": "#e03e3e"}, …}
    speaker_meta: Mapped[str] = mapped_column(Text, default="")
    # 화자명 적용 전사본 (화자 레이블 → 실제 이름 치환)
    named_transcript: Mapped[str] = mapped_column(Text, default="")
    minutes: Mapped[str] = mapped_column(Text, default="")
    canvas_id: Mapped[str] = mapped_column(String(64), default="")
    canvas_data: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class MeetingChunk(Base):
    """라이브 녹음의 조각별 전사 텍스트(seq 순서로 조립)."""

    __tablename__ = "meeting_chunks"

    id: Mapped[int] = mapped_column(primary_key=True)
    meeting_id: Mapped[int] = mapped_column(ForeignKey("meetings.id", ondelete="CASCADE"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text, default="")
    # 이 청크가 시작되는 녹음 내 절대 위치(초) — 타임스탬프 계산 기준
    time_offset: Mapped[float] = mapped_column(Float, default=0.0)


async def init_db() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # 기존 테이블에 컬럼 보강(create_all 은 컬럼 추가를 안 함).
        for stmt in [
            "ALTER TABLE meetings ADD COLUMN IF NOT EXISTS user_id VARCHAR(36)",
            "CREATE INDEX IF NOT EXISTS ix_meetings_user_id ON meetings (user_id)",
            "ALTER TABLE meetings ADD COLUMN IF NOT EXISTS segments TEXT DEFAULT ''",
            "ALTER TABLE meetings ADD COLUMN IF NOT EXISTS speaker_meta TEXT DEFAULT ''",
            "ALTER TABLE meetings ADD COLUMN IF NOT EXISTS named_transcript TEXT DEFAULT ''",
            "ALTER TABLE meeting_chunks ADD COLUMN IF NOT EXISTS time_offset FLOAT DEFAULT 0.0",
            "ALTER TABLE meetings ADD COLUMN IF NOT EXISTS canvas_id VARCHAR(64) DEFAULT ''",
            "ALTER TABLE meetings ADD COLUMN IF NOT EXISTS canvas_data TEXT DEFAULT ''",
        ]:
            await conn.execute(text(stmt))
