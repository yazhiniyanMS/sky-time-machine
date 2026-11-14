from __future__ import annotations

from typing import Any

import numpy as np
from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy import select

from stm import jobs
from stm.api.observations import adapter
from stm.db import Comparison, Job, session
from stm.pipeline import LAYER_INFO, ProcessingConfig, comparison_id, layer_fits, load_layers, run_comparison

router = APIRouter(prefix="/api", tags=["comparisons"])


class ComparisonRequest(BaseModel):
    ra: float = Field(..., ge=0, lt=360)
    dec: float = Field(..., ge=-90, le=90)
    size_deg: float = Field(0.1, gt=0.01, le=0.25)
    product_a: str = Field(..., min_length=3, max_length=64)
    product_b: str = Field(..., min_length=3, max_length=64)


def comparison_dict(c: Comparison, with_candidates: bool = True) -> dict[str, Any]:
    d: dict[str, Any] = {
        "id": c.id,
        "status": c.status,
        "error": c.error,
        "created_at": c.created_at.isoformat(),
        "survey": c.survey,
        "ra": c.ra,
        "dec": c.dec,
        "size_deg": c.size_deg,
        "detector": c.detector,
        "product_a": c.product_a,
        "product_b": c.product_b,
        "t_a_mjd": c.t_a_mjd,
        "t_b_mjd": c.t_b_mjd,
        "pipeline_version": c.pipeline_version,
        "summary": c.summary,
        "provenance": c.provenance,
    }
    if with_candidates:
        d["candidates"] = [candidate_brief(x) for x in sorted(c.candidates, key=lambda x: x.rank_in_comparison)]
    return d


def candidate_brief(x: Any) -> dict[str, Any]:
    m = x.measurements
    return {
        "id": x.id,
        "comparison_id": x.comparison_id,
        "ra": x.ra,
        "dec": x.dec,
        "sign": x.sign,
        "peak_significance": x.peak_significance,
        "quality_tier": x.quality_tier,
        "rejected": x.rejected,
        "machine_class": x.machine_class,
        "rank_in_comparison": x.rank_in_comparison,
        "verification_status": x.verification_status,
        "x_pix": m.get("x_pix"),
        "y_pix": m.get("y_pix"),
        "diff_flux_ujy": m.get("diff_flux_ujy"),
        "diff_flux_err_ujy": m.get("diff_flux_err_ujy"),
        "pos_err_arcsec": m.get("pos_err_arcsec"),
        "epoch_signal_mjd": m.get("epoch_signal_mjd"),
    }


@router.post("/comparisons")
def create_comparison(req: ComparisonRequest) -> dict[str, Any]:
    if req.product_a == req.product_b:
        raise HTTPException(400, "Choose two different observations")
    cid = comparison_id(req.ra, req.dec, req.size_deg, req.product_a, req.product_b, ProcessingConfig())
    with session() as s:
        c = s.get(Comparison, cid)
        if c is not None and c.status in ("done", "rejected"):
            return {"comparison_id": cid, "job_id": None, "status": c.status}
        running = s.scalars(select(Job).where(Job.kind == "comparison", Job.status.in_(["queued", "running"]))).all()
        for j in running:
            if j.params.get("comparison_id") == cid:
                return {"comparison_id": cid, "job_id": j.id, "status": "running"}
    params = req.model_dump() | {"comparison_id": cid}
    job_id = jobs.submit(
        "comparison",
        params,
        lambda progress: run_comparison(
            req.ra, req.dec, req.size_deg, req.product_a, req.product_b, progress=progress, adapter=adapter()
        ),
    )
    return {"comparison_id": cid, "job_id": job_id, "status": "queued"}


@router.get("/comparisons")
def list_comparisons(limit: int = 50) -> list[dict[str, Any]]:
    with session() as s:
        rows = s.scalars(select(Comparison).order_by(Comparison.created_at.desc()).limit(min(limit, 200))).all()
        return [comparison_dict(c, with_candidates=False) | {"n_candidates": len(c.candidates)} for c in rows]


@router.get("/comparisons/{cid}")
def get_comparison(cid: str) -> dict[str, Any]:
    with session() as s:
        c = s.get(Comparison, cid)
        if c is None:
            raise HTTPException(404, "comparison not found")
        return comparison_dict(c)


@router.get("/comparisons/{cid}/layers/{layer}")
def get_layer(cid: str, layer: str) -> Response:
    """Raw float32 little-endian array; shape in X-Shape (rows,cols); NaN = no data."""
    if layer not in LAYER_INFO:
        raise HTTPException(404, f"unknown layer; choose from {list(LAYER_INFO)}")
    with session() as s:
        c = s.get(Comparison, cid)
        if c is None or not c.arrays_key:
            raise HTTPException(404, "comparison products not available")
        arr = load_layers(adapter().storage, c)[layer].astype("<f4")
    finite = arr[np.isfinite(arr)]
    headers = {
        "X-Shape": f"{arr.shape[0]},{arr.shape[1]}",
        "X-Layer-Kind": LAYER_INFO[layer][0],
        "X-Min": str(float(finite.min()) if finite.size else "nan"),
        "X-Max": str(float(finite.max()) if finite.size else "nan"),
        "Access-Control-Expose-Headers": "X-Shape, X-Layer-Kind, X-Min, X-Max",
        "Cache-Control": "public, max-age=86400",
    }
    return Response(arr.tobytes(), media_type="application/octet-stream", headers=headers)


@router.get("/comparisons/{cid}/fits/{layer}")
def get_layer_fits(cid: str, layer: str) -> Response:
    if layer not in LAYER_INFO:
        raise HTTPException(404, "unknown layer")
    with session() as s:
        c = s.get(Comparison, cid)
        if c is None or not c.arrays_key:
            raise HTTPException(404, "comparison products not available")
        data = layer_fits(adapter().storage, c, layer)
    return Response(
        data,
        media_type="application/fits",
        headers={"Content-Disposition": f'attachment; filename="{cid}_{layer}.fits"'},
    )


@router.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    with session() as s:
        j = s.get(Job, job_id)
        if j is None:
            raise HTTPException(404, "job not found")
        return {
            "id": j.id,
            "kind": j.kind,
            "status": j.status,
            "progress": j.progress,
            "message": j.message,
            "params": j.params,
            "result": j.result,
        }
