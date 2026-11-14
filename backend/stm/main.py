"""FastAPI application entry point: ``uvicorn stm.main:app``."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from stm import PIPELINE_VERSION, __version__
from stm.api import assistant, candidates, community, comparisons, observations
from stm.config import get_settings
from stm.db import init_db
from stm.jobs import mark_interrupted

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(_: FastAPI):  # type: ignore[no-untyped-def]
    init_db()
    mark_interrupted()
    yield


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
for r in (observations.router, comparisons.router, candidates.router, community.router, assistant.router):
    app.include_router(r)


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "version": __version__, "pipeline_version": PIPELINE_VERSION}
