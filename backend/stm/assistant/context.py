"""Build the grounded context the assistant answers from.

Everything placed in the context comes from the database (pipeline outputs
with provenance) or from the repository's own scientific documentation.
"""

from __future__ import annotations

import re
from functools import lru_cache
from typing import Any

import numpy as np
from sqlalchemy import select

from stm.config import REPO_ROOT
from stm.db import Candidate, Comparison, CounterpartAssessment, Investigation, PhotometryRun, session
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
                    "metrics": {k: v for k, v in (prov.get("metrics") or {}).items() if not k.startswith("psf_kernel")},
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
    _add_research_context(out, ctx, question)
    out["class_definitions"] = CLASS_DESCRIPTIONS
    out["documentation"] = retrieve_docs(question)
    out["citations"] = _citations(out)
    return out


def _add_research_context(out: dict[str, Any], ctx: dict[str, Any], question: str) -> None:
    """Spectra, light curves, catalogue matches, investigations and similar candidates (all from stored records)."""
    from stm.science.lightcurve import light_curve_stats
    from stm.science.tracking import sep_arcsec

    cand = out.get("selected_candidate")
    with session() as s:
        if cand:
            a = s.scalars(
                select(CounterpartAssessment)
                .where(CounterpartAssessment.candidate_id == cand["id"])
                .order_by(CounterpartAssessment.created_at.desc())
            ).first()
            if a is not None:
                out["counterparts"] = {
                    "association": a.association,
                    "radius_arcsec": a.radius_arcsec,
                    "assessed_at": a.created_at.isoformat(),
                    "catalogs": {
                        name: {
                            "status": c.get("status"),
                            "association": c.get("association"),
                            "expected_chance": c.get("expected_chance"),
                            "nearest": c.get("counterparts", [])[:5],
                        }
                        for name, c in a.catalogs.items()
                    },
                }
        ra = cand["ra"] if cand else ctx.get("ra")
        dec = cand["dec"] if cand else ctx.get("dec")
        run = None
        if ctx.get("run_id"):
            run = s.get(PhotometryRun, ctx["run_id"])
        elif (
            cand
            and (
                linked := s.scalars(
                    select(PhotometryRun)
                    .where(PhotometryRun.candidate_id == cand["id"], PhotometryRun.status == "done")
                    .order_by(PhotometryRun.created_at.desc())
                ).first()
            )
            is not None
        ):
            run = linked
        elif ra is not None and dec is not None:
            for r in s.scalars(
                select(PhotometryRun).where(PhotometryRun.status == "done").order_by(PhotometryRun.created_at.desc())
            ):
                if sep_arcsec(float(ra), float(dec), r.ra, r.dec) <= 10:
                    run = r
                    break
        if run is not None and run.status == "done":
            ok = [p for p in run.points if p.status == "ok"]
            chans: dict[int, list[Any]] = {}
            for p in ok:
                if p.channel is not None:
                    chans.setdefault(p.channel, []).append(p)
            target = None
            if cand and cand["measurements"].get("wave_b_um"):
                w = cand["measurements"]["wave_b_um"]
                target = min(chans, key=lambda c: min(abs((p.wave_um or 0) - w) for p in chans[c]), default=None)
            lc = None
            if target is not None:
                pts = [p for p in chans[target] if p.quality in ("good", "warning")]
                lc = light_curve_stats(
                    [p.t_mid_mjd for p in pts], [p.flux_ujy for p in pts], [p.flux_err_ujy for p in pts]
                )
                lc = {
                    k: lc.get(k)
                    for k in (
                        "n_points",
                        "n_visits",
                        "weighted_mean_ujy",
                        "weighted_mean_err_ujy",
                        "median_ujy",
                        "std_ujy",
                        "relative_scatter",
                        "reduced_chi2",
                        "p_value_constant",
                        "verdict",
                        "explanation",
                    )
                } | {"channel": target}
            out["spectrophotometry"] = {
                "run_id": run.id,
                "ra": run.ra,
                "dec": run.dec,
                "n_ok_measurements": len(ok),
                "n_channels_measured": len(chans),
                "n_exposures": (run.provenance or {}).get("n_exposures"),
                "per_channel_counts": {str(c): len(v) for c, v in sorted(chans.items())},
                "light_curve_candidate_channel": lc,
                "quantity": "measured aperture flux density (µJy) per exposure",
            }
        if ctx.get("investigation_id"):
            inv = s.get(Investigation, ctx["investigation_id"])
            if inv is not None:
                out["investigation"] = {
                    "id": inv.id,
                    "title": inv.title,
                    "description": inv.description[:2000],
                    "notes": inv.notes[:4000],
                    "references": inv.references[:20],
                    "items": [
                        {"kind": it.kind, "ref_id": it.ref_id, "label": it.label, "note": it.note[:500]}
                        for it in inv.items[:50]
                    ],
                }
        if cand and any(w in question.lower() for w in ("similar", "like this", "comparable")):
            me = s.scalar(select(Candidate).where(Candidate.id == cand["id"]))
            others = [c for c in s.scalars(select(Candidate)) if c.id != cand["id"] and not c.rejected]
            if me is not None:

                def dist(c: Candidate) -> float:
                    d = 0.0 if c.machine_class == me.machine_class else 2.0
                    d += 0.0 if c.sign == me.sign else 1.0
                    d += abs(np.log10(abs(c.peak_significance) + 1) - np.log10(abs(me.peak_significance) + 1))
                    ms, cs = me.measurements.get("diff_snr") or 0, c.measurements.get("diff_snr") or 0
                    return d + abs(np.log10(abs(ms) + 1) - np.log10(abs(cs) + 1))

                out["similar_candidates"] = {
                    "metric": "same machine class (+2 if not), same sign (+1 if not), |Δ log10(1+|peak σ|)|, "
                    "|Δ log10(1+S/N)| — similarity of measured properties only",
                    "items": [_cand(c) | {"distance": round(dist(c), 3)} for c in sorted(others, key=dist)[:5]],
                }


def _citations(out: dict[str, Any]) -> list[dict[str, Any]]:
    cites: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(ref: str, kind: str, url: str | None = None, note: str = "") -> None:
        if ref and ref not in seen:
            seen.add(ref)
            cites.append({"ref": ref, "kind": kind, "url": url, "note": note})

    if out.get("selected_candidate"):
        add(out["selected_candidate"]["id"], "candidate", f"/discovery/{out['selected_candidate']['id']}")
    comp = out.get("comparison")
    if comp:
        add(comp["id"], "comparison")
        for i in comp.get("inputs", []):
            add(i["product_id"], "SPHEREx L2 observation", i.get("access_url"), str(i.get("date_iso") or ""))
    for c in out.get("region_candidates", [])[:10]:
        add(c["id"], "candidate", f"/discovery/{c['id']}")
    cp = out.get("counterparts")
    if cp:
        for name, cat in cp["catalogs"].items():
            for r in cat.get("nearest", [])[:3]:
                add(str(r.get("id")), f"{name} catalogue record", r.get("url"), f"sep {r.get('sep_arcsec')}″")
    sp = out.get("spectrophotometry")
    if sp:
        add(sp["run_id"], "spectrophotometry run", f"/spectra?run={sp['run_id']}")
    if out.get("investigation"):
        add(out["investigation"]["id"], "investigation", f"/investigations/{out['investigation']['id']}")
    for c in (out.get("similar_candidates") or {}).get("items", []):
        add(c["id"], "candidate", f"/discovery/{c['id']}")
    for d in out.get("documentation", []):
        add(d["source"], "documentation")
    return cites
