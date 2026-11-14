from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select

from stm import jobs
from stm.adapters.base import ArchiveError
from stm.api.community import require_moderator
from stm.api.comparisons import candidate_brief, comparison_dict
from stm.api.observations import adapter
from stm.db import Annotation, Candidate, Comparison, TrackRecord, audit, session
from stm.pipeline import candidates_near, spectral_timeline
from stm.science.fitsio import load_spherex_l2
from stm.science.photometry import forced_photometry
from stm.science.ranking import CLASS_DESCRIPTIONS, TIER_ORDER
from stm.science.tracking import TrackInput, associate
from stm.storage import stable_key

router = APIRouter(prefix="/api", tags=["candidates"])

VERIFICATION_STATES = ("unverified", "under_review", "confirmed_real", "rejected_artifact")


@router.get("/candidates")
def list_candidates(
    ra: float | None = None,
    dec: float | None = None,
    radius: float = Query(0.5, gt=0, le=10),
    include_rejected: bool = False,
    machine_class: str | None = None,
    limit: int = Query(200, le=1000),
) -> dict[str, Any]:
    if ra is not None and dec is not None:
        rows = candidates_near(ra, dec, radius)
    else:
        with session() as s:
            rows = list(s.scalars(select(Candidate)))
    if not include_rejected:
        rows = [r for r in rows if not r.rejected]
    if machine_class:
        rows = [r for r in rows if r.machine_class == machine_class]
    rows.sort(key=lambda r: (TIER_ORDER.get(r.quality_tier, 9), -abs(r.peak_significance)))
    with session() as s:
        comps = {
            c.id: c for c in s.scalars(select(Comparison).where(Comparison.id.in_({r.comparison_id for r in rows})))
        }
        counts: dict[str, dict[str, int]] = {}
        for a in s.scalars(
            select(Annotation).where(Annotation.status == "visible", Annotation.target_id.in_([r.id for r in rows]))
        ):
            counts.setdefault(a.target_id, {}).setdefault(a.kind, 0)
            counts[a.target_id][a.kind] += 1
    out = []
    for r in rows[:limit]:
        c = comps.get(r.comparison_id)
        out.append(
            candidate_brief(r)
            | {
                "detector": c.detector if c else None,
                "t_a_mjd": c.t_a_mjd if c else None,
                "t_b_mjd": c.t_b_mjd if c else None,
                "product_a": c.product_a if c else None,
                "product_b": c.product_b if c else None,
                "community": counts.get(r.id, {}),
            }
        )
    return {
        "candidates": out,
        "total": len(rows),
        "ranking": "quality tier (A, B, R) then |peak significance|",
        "class_descriptions": CLASS_DESCRIPTIONS,
    }


@router.get("/candidates/{cid}")
def get_candidate(cid: str) -> dict[str, Any]:
    with session() as s:
        c = s.scalar(select(Candidate).where(Candidate.id == cid))
        if c is None:
            raise HTTPException(404, "candidate not found")
        comp = s.get(Comparison, c.comparison_id)
        assert comp is not None
        tracks = [t for t in s.scalars(select(TrackRecord)) if cid in t.members]
        return {
            "id": c.id,
            "ra": c.ra,
            "dec": c.dec,
            "sign": c.sign,
            "peak_significance": c.peak_significance,
            "quality_tier": c.quality_tier,
            "rejected": c.rejected,
            "machine_class": c.machine_class,
            "machine_class_description": CLASS_DESCRIPTIONS.get(c.machine_class),
            "rank_in_comparison": c.rank_in_comparison,
            "rank_explanation": c.rank_explanation,
            "measurements": c.measurements,
            "quality_checks": c.quality_checks,
            "verification_status": c.verification_status,
            "pipeline_version": c.pipeline_version,
            "created_at": c.created_at.isoformat(),
            "comparison": comparison_dict(comp, with_candidates=False),
            "tracks": [{"id": t.id, "kind": t.kind, "members": t.members, "metrics": t.metrics} for t in tracks],
        }


class VerificationUpdate(BaseModel):
    status: str
    reviewer: str = Field(..., min_length=2, max_length=64)
    reason: str = Field(..., min_length=5, max_length=2000)


@router.post("/candidates/{cid}/verification")
def set_verification(
    cid: str, body: VerificationUpdate, x_moderator_token: str | None = Header(None)
) -> dict[str, Any]:
    """Explicit reviewer action (moderator token required); the only path that changes verification status."""
    require_moderator(x_moderator_token)
    if body.status not in VERIFICATION_STATES:
        raise HTTPException(400, f"status must be one of {VERIFICATION_STATES}")
    with session() as s:
        c = s.scalar(select(Candidate).where(Candidate.id == cid))
        if c is None:
            raise HTTPException(404, "candidate not found")
        old = c.verification_status
        c.verification_status = body.status
        audit(s, "candidate", cid, "verification_change", body.reviewer, old=old, new=body.status, reason=body.reason)
    return {"id": cid, "verification_status": body.status}


@router.post("/candidates/{cid}/photometry")
def candidate_photometry(cid: str, max_epochs: int = Query(12, ge=2, le=40)) -> dict[str, Any]:
    with session() as s:
        c = s.scalar(select(Candidate).where(Candidate.id == cid))
        if c is None:
            raise HTTPException(404, "candidate not found")
        comp = s.get(Comparison, c.comparison_id)
        assert comp is not None
        ra, dec, det = c.ra, c.dec, comp.detector
        wave = c.measurements.get("wave_b_um") or c.measurements.get("wave_a_um")
        bw = c.measurements.get("bandwidth_um")
    if det is None:
        raise HTTPException(400, "comparison has no detector")
    return {"job_id": run_photometry_job(ra, dec, det, wave, bw, max_epochs, cid)}


def run_photometry_job(
    ra: float, dec: float, det: int, wave: float | None, bw: float | None, max_epochs: int, label: str
) -> str:
    def work(progress: Any) -> dict[str, Any]:
        ad = adapter()
        progress(0.05, "Reading exposure headers to estimate wavelength at the position")
        tl = spectral_timeline(ad, ra, dec, det)
        obs = [o for o in tl["observations"] if o.get("in_footprint")]
        matched, other = [], []
        for o in obs:
            if wave and bw and abs(o["wave_um"] - wave) / bw <= 0.5:
                matched.append(o)
            else:
                other.append(o)
        recs = {r.product_id: r for r in ad.query_position(ra, dec, 0.01)}
        points = []
        for i, o in enumerate(matched[:max_epochs]):
            progress(0.1 + 0.85 * i / max(1, min(len(matched), max_epochs)), f"Forced photometry {o['product_id']}")
            try:
                path = ad.fetch_cutout(recs[o["product_id"]], ra, dec, 0.05)
                p = load_spherex_l2(path, o["product_id"])
                points.append(forced_photometry(p, ra, dec))
            except (ArchiveError, ValueError, KeyError) as e:
                points.append({"product_id": o["product_id"], "error": str(e)})
        return {
            "label": label,
            "ra": ra,
            "dec": dec,
            "detector": det,
            "target_wave_um": wave,
            "target_bandwidth_um": bw,
            "points": points,
            "not_measured_different_wavelength": [
                {"product_id": o["product_id"], "t_mid_mjd": o["t_mid_mjd"], "wave_um": o["wave_um"]} for o in other
            ],
            "not_measured_over_limit": [o["product_id"] for o in matched[max_epochs:]],
            "method": "Forced circular-aperture photometry (r = 1.5 PSF FWHM) on ZODI- and annulus-background-"
            "subtracted archive IMAGE pixels; only epochs within 0.5 bandwidth of the candidate's "
            "wavelength are measured.",
        }

    return jobs.submit("photometry", {"ra": ra, "dec": dec, "detector": det, "label": label}, work)


class TrackRequest(BaseModel):
    ra: float = Field(..., ge=0, lt=360)
    dec: float = Field(..., ge=-90, le=90)
    radius_deg: float = Field(0.25, gt=0, le=5)
    n_sigma: float = Field(3.0, ge=1, le=10)
    include_rejected: bool = False


@router.post("/tracks")
def build_tracks(req: TrackRequest) -> dict[str, Any]:
    cands = [c for c in candidates_near(req.ra, req.dec, req.radius_deg) if req.include_rejected or not c.rejected]
    items = [
        TrackInput(
            candidate_id=c.id,
            ra=c.ra,
            dec=c.dec,
            pos_err_arcsec=c.measurements.get("pos_err_arcsec", 6.0),
            t_mjd=c.measurements.get("epoch_signal_mjd") or 0.0,
            comparison_id=c.comparison_id,
            sign=c.sign,
            diff_flux_ujy=c.measurements.get("diff_flux_ujy", 0.0),
            wave_um=c.measurements.get("wave_b_um"),
        )
        for c in cands
    ]
    tracks = associate(items, n_sigma=req.n_sigma)
    run_id = "RUN-" + stable_key(req.model_dump_json(), sorted(i.candidate_id for i in items))[:10].upper()
    with session() as s:
        for old in s.scalars(select(TrackRecord).where(TrackRecord.run_id == run_id)):
            s.delete(old)
        s.flush()
        out = []
        for k, t in enumerate(tracks):
            mem = [i for i in items if i.candidate_id in t.members]
            tid = f"TRK-{run_id[4:]}-{k:03d}"
            rec = TrackRecord(
                id=tid,
                run_id=run_id,
                kind=t.kind,
                members=t.members,
                metrics=t.metrics,
                ra=sum(m.ra for m in mem) / len(mem),
                dec=sum(m.dec for m in mem) / len(mem),
                params=req.model_dump(),
            )
            s.add(rec)
            out.append(
                {"id": tid, "kind": t.kind, "members": t.members, "metrics": t.metrics, "ra": rec.ra, "dec": rec.dec}
            )
    return {
        "run_id": run_id,
        "n_candidates": len(items),
        "tracks": out,
        "params": req.model_dump(),
        "method": "Positional consistency within n_sigma × combined uncertainty across different comparisons "
        "(union-find); constant-velocity linking of ≥3 brightening single detections at distinct "
        "epochs. Association does not prove physical identity.",
    }


@router.get("/tracks")
def list_tracks(ra: float | None = None, dec: float | None = None, radius: float = 1.0) -> list[dict[str, Any]]:
    from stm.science.tracking import sep_arcsec

    with session() as s:
        rows = list(s.scalars(select(TrackRecord).order_by(TrackRecord.created_at.desc()).limit(500)))
    if ra is not None and dec is not None:
        rows = [t for t in rows if sep_arcsec(ra, dec, t.ra, t.dec) <= radius * 3600]
    return [
        {
            "id": t.id,
            "run_id": t.run_id,
            "kind": t.kind,
            "members": t.members,
            "metrics": t.metrics,
            "ra": t.ra,
            "dec": t.dec,
            "created_at": t.created_at.isoformat(),
        }
        for t in rows
    ]
