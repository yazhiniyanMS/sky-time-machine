"""Citizen-science annotations, moderation and audit history.

Community input is stored in its own table and never modifies machine
classifications or the scientific verification status of a candidate.
"""

from __future__ import annotations

import re
import secrets
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select

from stm.config import get_settings
from stm.db import Annotation, AuditEvent, Candidate, Comparison, audit, session

router = APIRouter(prefix="/api", tags=["community"])

KINDS = ("interesting", "not_interesting", "artifact", "flag", "note")
TARGETS = ("candidate", "comparison", "observation")
_URL = re.compile(r"https?://", re.I)


def require_moderator(token: str | None) -> str:
    expected = get_settings().moderator_token
    if not expected:
        raise HTTPException(403, "Moderation is disabled: set STM_MODERATOR_TOKEN on the server")
    if not token or not secrets.compare_digest(token, expected):
        raise HTTPException(403, "Invalid moderator token")
    return "moderator"


class AnnotationIn(BaseModel):
    target_type: str = "candidate"
    target_id: str = Field(..., min_length=3, max_length=64)
    author: str = Field(..., min_length=2, max_length=64)
    kind: str
    body: str = Field("", max_length=4000)


def ann_dict(a: Annotation) -> dict[str, Any]:
    return {
        "id": a.id,
        "created_at": a.created_at.isoformat(),
        "target_type": a.target_type,
        "target_id": a.target_id,
        "author": a.author,
        "kind": a.kind,
        "body": a.body,
        "status": a.status,
    }


@router.post("/annotations")
def create_annotation(a: AnnotationIn) -> dict[str, Any]:
    if a.kind not in KINDS:
        raise HTTPException(400, f"kind must be one of {KINDS}")
    if a.target_type not in TARGETS:
        raise HTTPException(400, f"target_type must be one of {TARGETS}")
    if a.kind in ("note", "flag") and not a.body.strip():
        raise HTTPException(400, "notes and flags need text")
    with session() as s:
        if a.target_type == "candidate" and s.scalar(select(Candidate).where(Candidate.id == a.target_id)) is None:
            raise HTTPException(404, "candidate not found")
        if a.target_type == "comparison" and s.get(Comparison, a.target_id) is None:
            raise HTTPException(404, "comparison not found")
        # Basic automatic moderation: links are held for review.
        status = "pending" if _URL.search(a.body) else "visible"
        row = Annotation(
            target_type=a.target_type,
            target_id=a.target_id,
            author=a.author.strip(),
            kind=a.kind,
            body=a.body.strip(),
            status=status,
        )
        s.add(row)
        s.flush()
        audit(s, "annotation", str(row.id), "create", row.author, kind=a.kind, target=a.target_id, status=status)
        return ann_dict(row)


@router.get("/annotations")
def list_annotations(
    target_id: str | None = None, include_hidden: bool = False, limit: int = Query(100, le=500)
) -> list[dict[str, Any]]:
    with session() as s:
        q = select(Annotation).order_by(Annotation.created_at.desc()).limit(limit)
        if target_id:
            q = q.where(Annotation.target_id == target_id)
        rows = s.scalars(q).all()
        return [ann_dict(a) for a in rows if include_hidden or a.status == "visible"]


@router.get("/annotations/summary/{target_id}")
def annotation_summary(target_id: str) -> dict[str, Any]:
    with session() as s:
        rows = s.scalars(
            select(Annotation).where(Annotation.target_id == target_id, Annotation.status == "visible")
        ).all()
    counts = {k: sum(1 for r in rows if r.kind == k) for k in KINDS}
    return {
        "target_id": target_id,
        "counts": counts,
        "note": "Community classifications are opinions recorded for review. They do not change the machine "
        "classification or the scientific verification status.",
    }


class ModerationIn(BaseModel):
    action: str  # hide | restore | approve
    reason: str = Field(..., min_length=3, max_length=1000)


@router.post("/annotations/{ann_id}/moderate")
def moderate(ann_id: int, m: ModerationIn, x_moderator_token: str | None = Header(None)) -> dict[str, Any]:
    actor = require_moderator(x_moderator_token)
    new = {"hide": "hidden", "restore": "visible", "approve": "visible"}.get(m.action)
    if new is None:
        raise HTTPException(400, "action must be hide, restore or approve")
    with session() as s:
        a = s.get(Annotation, ann_id)
        if a is None:
            raise HTTPException(404, "annotation not found")
        old = a.status
        a.status = new
        audit(s, "annotation", str(ann_id), f"moderate_{m.action}", actor, old=old, new=new, reason=m.reason)
        return ann_dict(a)


@router.get("/moderation/queue")
def moderation_queue(x_moderator_token: str | None = Header(None)) -> list[dict[str, Any]]:
    require_moderator(x_moderator_token)
    with session() as s:
        rows = s.scalars(
            select(Annotation)
            .where(Annotation.status.in_(["pending", "hidden"]))
            .order_by(Annotation.created_at.desc())
        ).all()
        return [ann_dict(a) for a in rows]


@router.get("/audit")
def audit_log(target_id: str | None = None, limit: int = Query(100, le=500)) -> list[dict[str, Any]]:
    with session() as s:
        q = select(AuditEvent).order_by(AuditEvent.created_at.desc()).limit(limit)
        if target_id:
            q = q.where(AuditEvent.target_id == target_id)
        return [
            {
                "id": e.id,
                "created_at": e.created_at.isoformat(),
                "target_type": e.target_type,
                "target_id": e.target_id,
                "action": e.action,
                "actor": e.actor,
                "detail": e.detail,
            }
            for e in s.scalars(q)
        ]
