from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from stm.assistant.context import build_context
from stm.assistant.providers import AssistantUnavailable, RuleBasedProvider, get_provider

router = APIRouter(prefix="/api", tags=["assistant"])


class ChatMessage(BaseModel):
    role: str
    content: str = Field(..., max_length=8000)


class ChatRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=2000)
    history: list[ChatMessage] = Field(default_factory=list, max_length=20)
    context: dict[str, Any] = Field(default_factory=dict)


@router.get("/assistant/status")
def status() -> dict[str, Any]:
    p = get_provider()
    return {"provider": p.name, "model": getattr(p, "model", None), "llm_enabled": p.name != "rule-based"}


@router.post("/assistant/chat")
def chat(req: ChatRequest) -> dict[str, Any]:
    ctx = build_context(dict(req.context), req.question)
    provider = get_provider()
    history = [m.model_dump() for m in req.history]
    try:
        result = provider.answer(req.question, history, ctx)
    except AssistantUnavailable as e:
        result = RuleBasedProvider().answer(req.question, history, ctx)
        result["notice"] = f"{e}. Showing the rule-based summary instead."
    result["grounding"] = {
        "candidate": (ctx.get("selected_candidate") or {}).get("id"),
        "comparison": (ctx.get("comparison") or {}).get("id"),
        "region_candidates": [c["id"] for c in ctx.get("region_candidates", [])],
        "documents": [d["source"] for d in ctx.get("documentation", [])],
    }
    return result
