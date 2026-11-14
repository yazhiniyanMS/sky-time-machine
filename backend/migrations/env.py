"""Alembic environment: uses the engine created by stm.db.init_db (or STM_DATABASE_URL)."""

from __future__ import annotations

from alembic import context
from sqlalchemy import create_engine

from stm.config import get_settings
from stm.db import Base

config = context.config
target_metadata = Base.metadata


def run() -> None:
    engine = config.attributes.get("connection_engine") or create_engine(get_settings().resolved_database_url)
    with engine.begin() as conn:
        context.configure(connection=conn, target_metadata=target_metadata, render_as_batch=True)
        with context.begin_transaction():
            context.run_migrations()


run()
