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


def iso(dt: datetime | None) -> str | None:
    """ISO-8601 in UTC. SQLite returns naive datetimes for timezone-aware columns; they are stored in UTC."""
    if dt is None:
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=UTC)).isoformat()


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


# ----------------------------------------------------------------------------- V2: research platform
class PhotometryRun(Base):
    """Per-exposure spectrophotometry at one sky position (spectra and light curves are derived from it)."""

    __tablename__ = "photometry_runs"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    status: Mapped[str] = mapped_column(String(16), default="queued")  # queued|running|done|failed
    ra: Mapped[float] = mapped_column(Float, index=True)
    dec: Mapped[float] = mapped_column(Float, index=True)
    label: Mapped[str | None] = mapped_column(String(128), nullable=True)
    candidate_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    params: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    provenance: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    n_points: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    points: Mapped[list[PhotometryPoint]] = relationship(back_populates="run", cascade="all, delete-orphan")


class PhotometryPoint(Base):
    __tablename__ = "photometry_points"
    pk: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("photometry_runs.id"), index=True)
    product_id: Mapped[str] = mapped_column(String(64))
    obs_id: Mapped[str] = mapped_column(String(64))
    detector: Mapped[int | None] = mapped_column(Integer, nullable=True)
    channel: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    subchannel: Mapped[int | None] = mapped_column(Integer, nullable=True)
    t_mid_mjd: Mapped[float] = mapped_column(Float)
    wave_um: Mapped[float | None] = mapped_column(Float, nullable=True)
    bandwidth_um: Mapped[float | None] = mapped_column(Float, nullable=True)
    flux_ujy: Mapped[float | None] = mapped_column(Float, nullable=True)
    flux_err_ujy: Mapped[float | None] = mapped_column(Float, nullable=True)
    aperture_correction: Mapped[float | None] = mapped_column(Float, nullable=True)
    flux_pointsource_ujy: Mapped[float | None] = mapped_column(Float, nullable=True)
    flux_pointsource_err_ujy: Mapped[float | None] = mapped_column(Float, nullable=True)
    masked_fraction: Mapped[float | None] = mapped_column(Float, nullable=True)
    status: Mapped[str] = mapped_column(String(16))  # ok | masked | outside | error
    quality: Mapped[str | None] = mapped_column(String(16), nullable=True)  # good | warning | bad
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    access_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    extra: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    run: Mapped[PhotometryRun] = relationship(back_populates="points")


class CounterpartAssessment(Base):
    __tablename__ = "counterpart_assessments"
    pk: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    candidate_id: Mapped[str] = mapped_column(String(32), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    radius_arcsec: Mapped[float] = mapped_column(Float)
    candidate_err_arcsec: Mapped[float] = mapped_column(Float)
    association: Mapped[str] = mapped_column(String(24))  # confirmed_positional | possible | inconclusive | none
    catalogs: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class Investigation(Base):
    __tablename__ = "investigations"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    owner: Mapped[str] = mapped_column(String(64), default="")
    ra: Mapped[float | None] = mapped_column(Float, nullable=True)
    dec: Mapped[float | None] = mapped_column(Float, nullable=True)
    radius_deg: Mapped[float | None] = mapped_column(Float, nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="")
    references: Mapped[list[Any]] = mapped_column(JSON, default=list)
    items: Mapped[list[InvestigationItem]] = relationship(back_populates="investigation", cascade="all, delete-orphan")


class InvestigationItem(Base):
    __tablename__ = "investigation_items"
    pk: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    investigation_id: Mapped[str] = mapped_column(ForeignKey("investigations.id"), index=True)
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    kind: Mapped[str] = mapped_column(String(24))  # candidate | comparison | region | spectrum | observation
    ref_id: Mapped[str] = mapped_column(String(128))
    label: Mapped[str] = mapped_column(String(200), default="")
    note: Mapped[str] = mapped_column(Text, default="")
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    investigation: Mapped[Investigation] = relationship(back_populates="items")


class WatchlistEntry(Base):
    __tablename__ = "watchlist_entries"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    kind: Mapped[str] = mapped_column(String(24))  # region | candidate | investigation
    label: Mapped[str] = mapped_column(String(200), default="")
    ref_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    ra: Mapped[float] = mapped_column(Float)
    dec: Mapped[float] = mapped_column(Float)
    radius_deg: Mapped[float] = mapped_column(Float, default=0.01)
    known_products: Mapped[list[Any]] = mapped_column(JSON, default=list)
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_new_count: Mapped[int] = mapped_column(Integer, default=0)
    checks: Mapped[list[WatchCheck]] = relationship(back_populates="entry", cascade="all, delete-orphan")


class WatchCheck(Base):
    __tablename__ = "watch_checks"
    pk: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    entry_id: Mapped[str] = mapped_column(ForeignKey("watchlist_entries.id"), index=True)
    checked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    status: Mapped[str] = mapped_column(String(16))  # ok | failed
    n_products: Mapped[int] = mapped_column(Integer, default=0)
    new_products: Mapped[list[Any]] = mapped_column(JSON, default=list)
    message: Mapped[str] = mapped_column(Text, default="")
    entry: Mapped[WatchlistEntry] = relationship(back_populates="checks")


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

    run_migrations(_engine)
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


LEGACY_TABLES = {"comparisons", "candidates", "tracks", "annotations", "audit_events", "jobs"}


def run_migrations(engine: Any) -> None:
    """Bring the database schema to the latest Alembic revision.

    Databases created by v0.1/0.2 with ``create_all`` (no ``alembic_version`` table) already contain the
    revision-0001 schema; they are stamped at 0001 before upgrading so no data is touched.
    """
    from pathlib import Path

    from alembic import command
    from alembic.config import Config
    from sqlalchemy import inspect

    cfg = Config()
    cfg.set_main_option("script_location", str(Path(__file__).resolve().parent.parent / "migrations"))
    cfg.attributes["connection_engine"] = engine
    tables = set(inspect(engine).get_table_names())
    if "alembic_version" not in tables and LEGACY_TABLES <= tables:
        command.stamp(cfg, "0001")
    command.upgrade(cfg, "head")
