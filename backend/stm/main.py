"""FastAPI application entry point: ``uvicorn stm.main:app``."""

from __future__ import annotations

import logging
import threading
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from stm import PIPELINE_VERSION, __version__
from stm.api import assistant, candidates, community, comparisons, observations, research, workspace
from stm.config import get_settings
from stm.db import init_db
from stm.jobs import mark_interrupted

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(_: FastAPI):  # type: ignore[no-untyped-def]
    init_db()
    mark_interrupted()
    stop = start_watch_scheduler()
    yield
    stop.set()


app = FastAPI(
    title="Sky Time Machine API",
    version=__version__,
    lifespan=lifespan,
    description="SPHEREx time-domain comparison, candidate detection and provenance API.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in get_settings().cors_origins.split(",") if o],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Shape", "X-Layer-Kind", "X-Min", "X-Max"],
)
for r in (
    observations.router,
    comparisons.router,
    candidates.router,
    community.router,
    assistant.router,
    research.router,
    workspace.router,
):
    app.include_router(r)


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "version": __version__, "pipeline_version": PIPELINE_VERSION}


def start_watch_scheduler() -> threading.Event:
    """Background re-check of watchlists every STM_WATCH_INTERVAL_HOURS (disabled when 0)."""
    stop = threading.Event()
    hours = get_settings().watch_interval_hours
    if hours <= 0:
        return stop

    def loop() -> None:
        from sqlalchemy import select

        from stm.db import WatchlistEntry, session

        while not stop.wait(hours * 3600):
            with session() as s:
                ids = [w.id for w in s.scalars(select(WatchlistEntry))]
            for wid in ids:
                try:
                    workspace.check_watch(wid)
                except Exception as e:  # noqa: BLE001
                    logging.getLogger(__name__).warning("watch %s check failed: %s", wid, e)

    threading.Thread(target=loop, name="stm-watch", daemon=True).start()
    return stop
