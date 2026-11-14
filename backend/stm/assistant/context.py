"""Build the grounded context the assistant answers from.

Everything placed in the context comes from the database (pipeline outputs
with provenance) or from the repository's own scientific documentation.
"""

from __future__ import annotations

import re
from functools import lru_cache
from typing import Any

from sqlalchemy import select

from stm.config import REPO_ROOT
from stm.db import Candidate, Comparison, session
from stm.pipeline import candidates_near
from stm.science.ranking import CLASS_DESCRIPTIONS

DOC_FILES = ("SCIENTIFIC_METHODOLOGY.md", "PROCESSING_PIPELINE.md", "DATA_SOURCES.md", "LIMITATIONS.md")


@lru_cache
def doc_chunks() -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for name in DOC_FILES:
        p = REPO_ROOT / "docs" / name
        if not p.exists():
            continue
        text = p.read_text(encoding="utf-8")
        for section in re.split(r"\n(?=## )", text):
            title = section.strip().splitlines()[0].lstrip("# ").strip() if section.strip() else name
            out.append((f"{name} › {title}", section.strip()[:2500]))
    return out


def retrieve_docs(question: str, k: int = 3) -> list[dict[str, str]]:
    words = {w for w in re.findall(r"[a-zA-Zλ]{4,}", question.lower())}
    scored = []
    for title, body in doc_chunks():
        low = body.lower()
        score = sum(low.count(w) for w in words)
        if score:
            scored.append((score, title, body))
    scored.sort(reverse=True)
    return [{"source": t, "text": b} for _, t, b in scored[:k]]


def _cand(c: Candidate) -> dict[str, Any]:
    m = c.measurements
    keep = (
        "diff_flux_ujy",
        "diff_flux_err_ujy",
        "diff_snr",
        "flux_a_ujy",
        "flux_a_err_ujy",
        "flux_b_ujy",
        "flux_b_err_ujy",
        "pos_err_arcsec",
        "wave_a_um",
        "wave_b_um",
        "bandwidth_um",
        "npix",
        "known_source_flag",
        "epoch_signal_mjd",
        "paired_with",
    )
    return {
        "id": c.id,
        "ra": round(c.ra, 6),
        "dec": round(c.dec, 6),
        "sign": c.sign,
        "peak_significance": round(c.peak_significance, 2),
        "quality_tier": c.quality_tier,
        "machine_class": c.machine_class,
        "verification_status": c.verification_status,
        "failed_checks": [f"{q['name']} ({q['severity']}): {q['detail']}" for q in c.quality_checks if not q["passed"]],
        "measurements": {k: m.get(k) for k in keep if k in m},
        "rank_explanation": c.rank_explanation,
    }


def build_context(ctx: dict[str, Any], question: str) -> dict[str, Any]:
    out: dict[str, Any] = {
        "view": {
            k: ctx.get(k) for k in ("ra", "dec", "fov", "detector", "product_a", "product_b") if ctx.get(k) is not None
        }
    }
    with session() as s:
        if ctx.get("candidate_id"):
            c = s.scalar(select(Candidate).where(Candidate.id == ctx["candidate_id"]))
            if c is not None:
                out["selected_candidate"] = _cand(c)
                ctx.setdefault("comparison_id", c.comparison_id)
        if ctx.get("comparison_id"):
            comp = s.get(Comparison, ctx["comparison_id"])
            if comp is not None:
                prov = comp.provenance or {}
                out["comparison"] = {
                    "id": comp.id,
                    "status": comp.status,
                    "detector": comp.detector,
                    "epoch_a": {"product": comp.product_a, "t_mid_mjd": comp.t_a_mjd},
                    "epoch_b": {"product": comp.product_b, "t_mid_mjd": comp.t_b_mjd},
                    "summary": comp.summary,
                    "metrics": prov.get("metrics"),
                    "failed_quality_checks": [q for q in prov.get("quality_checks", []) if not q["passed"]],
                    "inputs": [
                        {k: i.get(k) for k in ("product_id", "date_iso", "access_url", "psf_fwhm_arcsec")}
                        for i in prov.get("inputs", [])
                    ],
                    "candidates": [_cand(x) for x in sorted(comp.candidates, key=lambda x: x.rank_in_comparison)[:15]],
                }
    if "comparison" not in out and ctx.get("ra") is not None and ctx.get("dec") is not None:
        near = candidates_near(float(ctx["ra"]), float(ctx["dec"]), float(ctx.get("radius", 0.25)))
        near = [c for c in near if not c.rejected]
        near.sort(key=lambda c: ({"A": 0, "B": 1}.get(c.quality_tier, 2), -abs(c.peak_significance)))
        out["region_candidates"] = [_cand(c) for c in near[:15]]
    out["class_definitions"] = CLASS_DESCRIPTIONS
    out["documentation"] = retrieve_docs(question)
    return out
