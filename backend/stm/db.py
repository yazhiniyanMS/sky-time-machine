"""Database models (SQLAlchemy 2.0).

SQLite is the default for local development; any SQLAlchemy URL (e.g.
PostgreSQL) can be supplied via STM_DATABASE_URL. Spatial filtering is done
with RA/Dec bounding boxes plus an exact great-circle check in Python, so no
database spatial extension is required.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, create_engine, event
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, sessionmaker

from stm.config import get_settings


def utcnow() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    type_annotation_map = {dict[str, Any]: JSON, list[Any]: JSON}


class Comparison(Base):
    __tablename__ = "comparisons"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    status: Mapped[str] = mapped_column(String(16), default="queued")  # queued|running|done|rejected|failed
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    survey: Mapped[str] = mapped_column(String(32), default="SPHEREx")
    ra: Mapped[float] = mapped_column(Float)
    dec: Mapped[float] = mapped_column(Float)
    size_deg: Mapped[float] = mapped_column(Float)
    detector: Mapped[int | None] = mapped_column(Integer, nullable=True)
    product_a: Mapped[str] = mapped_column(String(64))
    product_b: Mapped[str] = mapped_column(String(64))
    t_a_mjd: Mapped[float | None] = mapped_column(Float, nullable=True)
    t_b_mjd: Mapped[float | None] = mapped_column(Float, nullable=True)
    pipeline_version: Mapped[str] = mapped_column(String(64))
    arrays_key: Mapped[str | None] = mapped_column(String(256), nullable=True)
    provenance: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    summary: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    candidates: Mapped[list[Candidate]] = relationship(back_populates="comparison", cascade="all, delete-orphan")


class Candidate(Base):
    __tablename__ = "candidates"
    pk: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    id: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    comparison_id: Mapped[str] = mapped_column(ForeignKey("comparisons.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    ra: Mapped[float] = mapped_column(Float, index=True)
    dec: Mapped[float] = mapped_column(Float, index=True)
    sign: Mapped[int] = mapped_column(Integer)
    peak_significance: Mapped[float] = mapped_column(Float)
    quality_tier: Mapped[str] = mapped_column(String(2))
    rejected: Mapped[bool] = mapped_column(Boolean, default=False)
    machine_class: Mapped[str] = mapped_column(String(48))
    rank_in_comparison: Mapped[int] = mapped_column(Integer)
    rank_explanation: Mapped[str] = mapped_column(Text)
    measurements: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    quality_checks: Mapped[list[Any]] = mapped_column(JSON, default=list)
    # Scientific verification status is changed only by an explicit reviewer
    # action, never by community votes. Values: unverified | under_review |
    # confirmed_real | rejected_artifact
    verification_status: Mapped[str] = mapped_column(String(24), default="unverified")
    pipeline_version: Mapped[str] = mapped_column(String(64))
    comparison: Mapped[Comparison] = relationship(back_populates="candidates")


class TrackRecord(Base):
    __tablename__ = "tracks"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    run_id: Mapped[str] = mapped_column(String(32), index=True)
    kind: Mapped[str] = mapped_column(String(32))
    members: Mapped[list[Any]] = mapped_column(JSON, default=list)
    metrics: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    ra: Mapped[float] = mapped_column(Float)
    dec: Mapped[float] = mapped_column(Float)
    params: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class Annotation(Base):
    """Human (community) input. Kept strictly separate from machine output."""

    __tablename__ = "annotations"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    target_type: Mapped[str] = mapped_column(String(16))  # candidate | comparison | observation
    target_id: Mapped[str] = mapped_column(String(64), index=True)
    author: Mapped[str] = mapped_column(String(64))
    kind: Mapped[str] = mapped_column(String(24))  # interesting | not_interesting | artifact | flag | note
    body: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(16), default="visible")  # visible | hidden


class AuditEvent(Base):
    __tablename__ = "audit_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    target_type: Mapped[str] = mapped_column(String(16))
    target_id: Mapped[str] = mapped_column(String(64), index=True)
    action: Mapped[str] = mapped_column(String(32))
    actor: Mapped[str] = mapped_column(String(64))
    detail: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class Job(Base):
    __tablename__ = "jobs"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    kind: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(16), default="queued")  # queued|running|done|failed
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    message: Mapped[str] = mapped_column(Text, default="")
    params: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    result: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


_engine = None
_Session: sessionmaker[Session] | None = None


def init_db(url: str | None = None) -> None:
    global _engine, _Session
    url = url or get_settings().resolved_database_url
    kwargs: dict[str, Any] = {}
    if url.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False}
    _engine = create_engine(url, **kwargs)
    if url.startswith("sqlite"):

        @event.listens_for(_engine, "connect")
        def _pragma(conn: Any, _: Any) -> None:  # pragma: no cover - trivial
            cur = conn.cursor()
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA foreign_keys=ON")
            cur.close()

    Base.metadata.create_all(_engine)
    _Session = sessionmaker(_engine, expire_on_commit=False)


@contextmanager
def session() -> Iterator[Session]:
    if _Session is None:
        init_db()
    assert _Session is not None
    s = _Session()
    try:
        yield s
        s.commit()
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()


def audit(s: Session, target_type: str, target_id: str, action: str, actor: str, **detail: Any) -> None:
    s.add(AuditEvent(target_type=target_type, target_id=target_id, action=action, actor=actor, detail=detail))
