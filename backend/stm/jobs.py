"""Lightweight background job runner.

A thread pool plus persisted job rows. Chosen over Celery/Redis to keep local
development dependency-free; the job table makes status survive restarts
(jobs interrupted by a restart are marked failed on startup).
"""

from __future__ import annotations

import logging
import traceback
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from stm.db import Job, session

log = logging.getLogger(__name__)
_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="stm-job")

ProgressFn = Callable[[float, str], None]


def _update(job_id: str, **fields: Any) -> None:
    with session() as s:
        job = s.get(Job, job_id)
        if job is None:
            return
        for k, v in fields.items():
            setattr(job, k, v)


def submit(
    kind: str, params: dict[str, Any], fn: Callable[[ProgressFn], dict[str, Any]], job_id: str | None = None
) -> str:
    job_id = job_id or f"JOB-{uuid.uuid4().hex[:12]}"
    with session() as s:
        s.add(Job(id=job_id, kind=kind, params=params, status="queued"))

    def progress(p: float, msg: str) -> None:
        _update(job_id, progress=float(p), message=msg)

    def run() -> None:
        _update(job_id, status="running", message="started")
        try:
            result = fn(progress)
            _update(job_id, status="done", progress=1.0, result=result, message="done")
        except Exception as e:  # noqa: BLE001 - recorded on the job row
            log.error("job %s failed: %s\n%s", job_id, e, traceback.format_exc())
            _update(job_id, status="failed", message=f"{type(e).__name__}: {e}")

    _pool.submit(run)
    return job_id


def mark_interrupted() -> None:
    with session() as s:
        for job in s.query(Job).filter(Job.status.in_(["queued", "running"])):
            job.status = "failed"
            job.message = "interrupted by server restart"
