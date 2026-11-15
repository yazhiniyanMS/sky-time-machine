"""Research endpoints: discovery feed, spectra, light curves, counterparts, sky layers, coverage, exports."""

from __future__ import annotations

import csv
import io
import json
import math
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import select

from stm import PIPELINE_VERSION, jobs
from stm.adapters.base import ArchiveError
from stm.api.comparisons import candidate_brief
from stm.api.observations import adapter
from stm.catalogs import CatalogService
from stm.db import Candidate, Comparison, CounterpartAssessment, PhotometryPoint, PhotometryRun, iso, session
from stm.pipeline import candidates_near
from stm.science import crossmatch
from stm.science.coverage import coverage_grid
from stm.science.lightcurve import LightCurveConfig, light_curve_stats
from stm.science.ranking import CLASS_DESCRIPTIONS, TIER_ORDER
from stm.science.spectro import cube_spectrum, load_channel_table, query_cube_record, spectrophotometry
from stm.storage import stable_key

router = APIRouter(prefix="/api", tags=["research"])
_catalogs: CatalogService | None = None


def catalogs() -> CatalogService:
    global _catalogs
    if _catalogs is None:
        _catalogs = CatalogService(storage=adapter().storage)
    return _catalogs


def _csv(rows: list[dict[str, Any]], filename: str, header_lines: list[str] | None = None) -> Response:
    buf = io.StringIO()
    for line in header_lines or []:
        buf.write(f"# {line}\n")
    if rows:
        w = csv.DictWriter(buf, fieldnames=list(rows[0].keys()), extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({k: (json.dumps(v) if isinstance(v, (list, dict)) else v) for k, v in r.items()})
    return Response(
        buf.getvalue(), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )


# ------------------------------------------------------------------------------------------ discovery feed
def _feed_rows(ra: float | None, dec: float | None, radius: float, include_rejected: bool) -> list[dict[str, Any]]:
    cands = candidates_near(ra, dec, radius) if ra is not None and dec is not None else None
    with session() as s:
        if cands is None:
            cands = list(s.scalars(select(Candidate)))
        comps = {c.id: c for c in s.scalars(select(Comparison))}
        assess = {}
        for a in s.scalars(select(CounterpartAssessment).order_by(CounterpartAssessment.created_at)):
            assess[a.candidate_id] = a.association
    rows = []
    for c in cands:
        if c.rejected and not include_rejected:
            continue
        comp = comps.get(c.comparison_id)
        m = c.measurements
        rows.append(
            candidate_brief(c)
            | {
                "diff_snr": m.get("diff_snr"),
                "snr_a": m.get("snr_a"),
                "snr_b": m.get("snr_b"),
                "wave_um": m.get("wave_b_um") or m.get("wave_a_um"),
                "detector": comp.detector if comp else None,
                "survey": comp.survey if comp else None,
                "collection": (comp.provenance.get("inputs") or [{}])[0].get("collection") if comp else None,
                "t_a_mjd": comp.t_a_mjd if comp else None,
                "t_b_mjd": comp.t_b_mjd if comp else None,
                "product_a": comp.product_a if comp else None,
                "product_b": comp.product_b if comp else None,
                "pipeline_version": c.pipeline_version,
                "created_at": iso(c.created_at),
                "failed_checks": [q["name"] for q in c.quality_checks if not q["passed"]],
                "counterpart_association": assess.get(c.id),
            }
        )
    return rows


@router.get("/discoveries")
def discoveries(
    sort: str = Query("significance", pattern="^(significance|date|snr|created)$"),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    q: str | None = Query(None, max_length=64),
    machine_class: str | None = None,
    tier: str | None = Query(None, pattern="^[ABR](,[ABR])*$"),
    min_snr: float | None = None,
    verification: str | None = None,
    ra: float | None = Query(None, ge=0, lt=360),
    dec: float | None = Query(None, ge=-90, le=90),
    radius: float = Query(1.0, gt=0, le=180),
    include_rejected: bool = False,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
) -> dict[str, Any]:
    rows = _feed_rows(ra, dec, radius, include_rejected or bool(tier and "R" in tier))
    if q:
        ql = q.strip().upper()
        rows = [r for r in rows if ql in r["id"].upper() or ql in str(r.get("comparison_id", "")).upper()]
    if machine_class:
        rows = [r for r in rows if r["machine_class"] == machine_class]
    if tier:
        tiers = set(tier.split(","))
        rows = [r for r in rows if r["quality_tier"] in tiers]
    if min_snr is not None:
        rows = [r for r in rows if (r.get("diff_snr") or 0) >= min_snr]
    if verification:
        rows = [r for r in rows if r["verification_status"] == verification]
    keys = {
        "significance": lambda r: abs(r["peak_significance"]),
        "snr": lambda r: r.get("diff_snr") or 0,
        "date": lambda r: r.get("epoch_signal_mjd") or r.get("t_b_mjd") or 0,
        "created": lambda r: r["created_at"],
    }
    rows.sort(key=keys[sort], reverse=order == "desc")
    if sort == "significance":  # quality tier first, as in the documented ranking
        rows.sort(key=lambda r: TIER_ORDER.get(r["quality_tier"], 9))
    total = len(rows)
    start = (page - 1) * page_size
    with session() as s:
        n_comparisons = len(list(s.scalars(select(Comparison.id))))
    return {
        "items": rows[start : start + page_size],
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": max(1, -(-total // page_size)),
        "sort": sort,
        "order": order,
        "n_comparisons_processed": n_comparisons,
        "class_descriptions": CLASS_DESCRIPTIONS,
        "note": "Every item comes from a stored comparison of real archive images. Nothing is generated to fill the "
        "feed; candidates appear only after comparisons are run.",
    }


@router.get("/export/candidates.csv")
def export_candidates(
    ra: float | None = None, dec: float | None = None, radius: float = 180.0, include_rejected: bool = False
) -> Response:
    rows = _feed_rows(ra, dec, radius, include_rejected)
    keep = [
        "id",
        "ra",
        "dec",
        "pos_err_arcsec",
        "machine_class",
        "quality_tier",
        "rejected",
        "verification_status",
        "peak_significance",
        "diff_snr",
        "diff_flux_ujy",
        "diff_flux_err_ujy",
        "snr_a",
        "snr_b",
        "wave_um",
        "detector",
        "t_a_mjd",
        "t_b_mjd",
        "epoch_signal_mjd",
        "product_a",
        "product_b",
        "comparison_id",
        "pipeline_version",
        "failed_checks",
        "counterpart_association",
    ]
    return _csv(
        [{k: r.get(k) for k in keep} for r in rows],
        "sky_time_machine_candidates.csv",
        [
            f"Sky Time Machine candidate export, {datetime.now(UTC).isoformat()}",
            "All candidates are unverified machine detections unless verification_status says otherwise.",
            "Source data: NASA/IPAC IRSA SPHEREx DR1 Level 2 spectral images.",
        ],
    )


@router.get("/comparisons/{cid}/references.csv")
def comparison_references(cid: str) -> Response:
    with session() as s:
        c = s.get(Comparison, cid)
        if c is None:
            raise HTTPException(404, "comparison not found")
        inputs = c.provenance.get("inputs", [])
    rows = [
        {
            k: i.get(k)
            for k in (
                "product_id",
                "obs_id",
                "detector",
                "band",
                "collection",
                "date_iso",
                "t_mid_mjd",
                "access_url",
                "cutout_url",
                "cloud_access",
                "synthetic",
            )
        }
        for i in inputs
    ]
    return _csv(rows, f"{cid}_observations.csv", [f"Observation references for {cid}", "Archive: NASA/IPAC IRSA"])


# ------------------------------------------------------------------------------------------ assessment
@router.get("/candidates/{cid}/assessment")
def candidate_assessment(cid: str) -> dict[str, Any]:
    """Structured, rule-based explanation of a candidate (no LLM involved)."""
    with session() as s:
        c = s.scalar(select(Candidate).where(Candidate.id == cid))
        if c is None:
            raise HTTPException(404, "candidate not found")
        comp = s.get(Comparison, c.comparison_id)
        assert comp is not None
        a = s.scalars(
            select(CounterpartAssessment)
            .where(CounterpartAssessment.candidate_id == cid)
            .order_by(CounterpartAssessment.created_at.desc())
        ).first()
        m = c.measurements
        metrics = comp.provenance.get("metrics", {})
        cfg = comp.provenance.get("config", {})
        thr = cfg.get("detection", {}).get("threshold_sigma", 5.0)
        passed = [q for q in c.quality_checks if q["passed"]]
        failed = [q for q in c.quality_checks if not q["passed"]]
        comp_failed = [q for q in comp.provenance.get("quality_checks", []) if not q["passed"]]
        uncertain = [
            "Aperture flux errors ignore pixel-to-pixel noise covariance introduced by resampling and PSF matching.",
            f"Per-pixel uncertainties were rescaled by ×{metrics.get('noise_rescale_factor', 1):.2f} to match the "
            "observed scatter of the difference image.",
        ]
        if metrics.get("psf_method") == "epsf_cross":
            uncertain.append(
                "PSF matching uses one EPSF kernel per field (evaluated at the field centre); bright sources "
                "can keep few-percent residuals."
            )
        else:
            uncertain.append(
                f"This comparison was processed with pipeline {comp.pipeline_version}, before EPSF-based "
                "PSF matching; re-running it with the current pipeline may change the result."
            )
        if (m.get("snr_a") or 0) < 0 or (m.get("snr_b") or 0) < 0:
            uncertain.append(
                "A negative epoch flux indicates the local annulus background is biased (extended "
                "emission); epoch fluxes here are not reliable."
            )
        if a is None:
            uncertain.append("Known-object cross-matching has not been run for this candidate.")
        elif a.association in ("inconclusive", "none"):
            uncertain.append(crossmatch.CLASS_TEXT[a.association])
        uncertain.append("No independent confirmation (another epoch at the same wavelength, or follow-up) exists.")
        return {
            "candidate_id": cid,
            "data_kinds": {
                "raw": "Archive Level 2 images (IRSA), shown resampled in the original-data panels",
                "processed": "Resampled, ZODI-subtracted, PSF-matched images and the difference image",
                "derived": "Measurements computed by Sky Time Machine (fluxes, significances, positions)",
                "rule_based": "This assessment: deterministic rules applied to stored measurements",
                "ai": "Sky Intelligence answers (separate page) — explanations only, never measurements",
            },
            "why_detected": {
                "text": f"The difference image (B − A) exceeded the {thr}σ detection threshold over {m.get('npix')} "
                f"connected pixels, peaking at {c.peak_significance:+.1f}σ "
                f"({'brightening' if c.sign > 0 else 'fading'}).",
                "threshold_sigma": thr,
                "peak_significance": c.peak_significance,
                "npix": m.get("npix"),
            },
            "supporting_measurements": [
                {
                    "name": "Difference flux",
                    "value": m.get("diff_flux_ujy"),
                    "error": m.get("diff_flux_err_ujy"),
                    "unit": "µJy",
                    "kind": "derived",
                },
                {"name": "Difference S/N (aperture)", "value": m.get("diff_snr"), "unit": "", "kind": "derived"},
                {
                    "name": "Epoch A flux",
                    "value": m.get("flux_a_ujy"),
                    "error": m.get("flux_a_err_ujy"),
                    "unit": "µJy",
                    "kind": "derived",
                },
                {
                    "name": "Epoch B flux",
                    "value": m.get("flux_b_ujy"),
                    "error": m.get("flux_b_err_ujy"),
                    "unit": "µJy",
                    "kind": "derived",
                },
                {
                    "name": "Positional uncertainty",
                    "value": m.get("pos_err_arcsec"),
                    "unit": "arcsec",
                    "kind": "derived",
                },
                {
                    "name": "Wavelength A / B",
                    "value": [m.get("wave_a_um"), m.get("wave_b_um")],
                    "unit": "µm",
                    "kind": "derived",
                },
            ],
            "checks_passed": passed,
            "checks_failed": failed,
            "comparison_checks_failed": comp_failed,
            "classification": {
                "machine_class": c.machine_class,
                "rule": CLASS_DESCRIPTIONS.get(c.machine_class),
                "quality_tier": c.quality_tier,
                "verification_status": c.verification_status,
            },
            "psf": {
                k: metrics.get(k)
                for k in (
                    "psf_method",
                    "psf_mismatch_tv",
                    "psf_fwhm_effective_arcsec",
                    "psf_fwhm_a_arcsec",
                    "psf_fwhm_b_arcsec",
                    "noise_rescale_factor",
                )
            }
            | {
                "kernel_a": metrics.get("psf_kernel_a"),
                "kernel_b": metrics.get("psf_kernel_b"),
                "rotation_a_deg": (metrics.get("psf_a") or {}).get("rotation_deg"),
                "rotation_b_deg": (metrics.get("psf_b") or {}).get("rotation_deg"),
            },
            "counterparts": {
                "association": a.association,
                "text": crossmatch.CLASS_TEXT[a.association],
                "assessed_at": iso(a.created_at),
            }
            if a
            else None,
            "remaining_uncertainties": uncertain,
            "processing_history": {
                "comparison_id": comp.id,
                "pipeline_version": comp.pipeline_version,
                "processed_at": comp.provenance.get("processed_at"),
                "current_pipeline_version": PIPELINE_VERSION,
                "software": comp.provenance.get("software"),
            },
        }


# ------------------------------------------------------------------------------------------ counterparts
@router.get("/candidates/{cid}/counterparts")
def candidate_counterparts(
    cid: str, radius_arcsec: float = Query(15.0, gt=0, le=120), refresh: bool = False, cached_only: bool = False
) -> dict[str, Any]:
    with session() as s:
        c = s.scalar(select(Candidate).where(Candidate.id == cid))
        if c is None:
            raise HTTPException(404, "candidate not found")
        ra, dec = c.ra, c.dec
        cerr = float(c.measurements.get("pos_err_arcsec") or 6.0)
        prev = s.scalars(
            select(CounterpartAssessment)
            .where(CounterpartAssessment.candidate_id == cid, CounterpartAssessment.radius_arcsec == radius_arcsec)
            .order_by(CounterpartAssessment.created_at.desc())
        ).first()
        if prev is not None and not refresh:
            return _assessment_dict(prev)
        if cached_only:
            raise HTTPException(404, "no stored cross-match for this radius")
    svc = catalogs()
    per: dict[str, Any] = {}
    classes: dict[str, str] = {}
    for name, res in (
        ("SIMBAD", svc.simbad_cone(ra, dec, radius_arcsec)),
        ("Gaia DR3", svc.gaia_cone(ra, dec, radius_arcsec)),
    ):
        scored = crossmatch.score_counterparts(res.rows, cerr, radius_arcsec, truncated="truncated" in res.message)
        cls = crossmatch.classify_catalog(scored, res.status)
        classes[name] = cls
        per[name] = {
            "status": res.status,
            "service": res.service,
            "message": res.message,
            "cached": res.cached,
            "queried_at": res.queried_at,
            "association": cls,
            "explanation": crossmatch.CLASS_TEXT[cls],
            "expected_chance": scored["expected_chance"],
            "density_per_arcmin2": scored["density_per_arcmin2"],
            "match_radius_arcsec": scored["match_radius_arcsec"],
            "counterparts": [
                {
                    k: r.get(k)
                    for k in (
                        "id",
                        "type",
                        "ra",
                        "dec",
                        "sep_arcsec",
                        "pos_err_arcsec",
                        "sigma_arcsec",
                        "n_sigma",
                        "within_3sigma",
                        "reference",
                        "url",
                        "phot_g_mean_mag",
                        "parallax",
                        "pm",
                    )
                }
                for r in scored["rows"][:25]
            ],
        }
    overall = crossmatch.combine(classes)
    with session() as s:
        row = CounterpartAssessment(
            candidate_id=cid, radius_arcsec=radius_arcsec, candidate_err_arcsec=cerr, association=overall, catalogs=per
        )
        s.add(row)
        s.flush()
        return _assessment_dict(row)


def _assessment_dict(a: CounterpartAssessment) -> dict[str, Any]:
    return {
        "candidate_id": a.candidate_id,
        "radius_arcsec": a.radius_arcsec,
        "candidate_err_arcsec": a.candidate_err_arcsec,
        "association": a.association,
        "explanation": crossmatch.CLASS_TEXT[a.association],
        "catalogs": a.catalogs,
        "assessed_at": iso(a.created_at),
        "method": "Normalised separation sep/√(σ_cand²+σ_cat²); 3σ match radius; chance alignment from the "
        "catalogue's density in the search cone. Angular proximity is not physical association.",
    }


# ------------------------------------------------------------------------------------------ sky layers
@router.get("/catalog/objects")
def catalog_objects(
    ra: float = Query(..., ge=0, lt=360),
    dec: float = Query(..., ge=-90, le=90),
    radius: float = Query(0.5, gt=0, le=3),
    kind: str = Query("galaxy", pattern="^(galaxy|nebula)$"),
) -> dict[str, Any]:
    res = catalogs().objects_by_type(ra, dec, radius, kind)
    return {
        "kind": kind,
        "status": res.status,
        "service": res.service,
        "message": res.message,
        "cached": res.cached,
        "objects": [{k: r.get(k) for k in ("main_id", "ra", "dec", "otype", "galdim_majaxis")} for r in res.rows],
        "source": "SIMBAD (CDS), object types " + ("galaxies" if kind == "galaxy" else "nebulae/ISM"),
    }


@router.get("/catalog/constellations")
def constellations() -> dict[str, Any]:
    try:
        return catalogs().constellations()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"constellation data unavailable: {e}") from e


# ------------------------------------------------------------------------------------------ spectra
@router.get("/spectra/channels")
def spectral_channels() -> dict[str, Any]:
    ch = load_channel_table(adapter())
    return {
        "n": len(ch),
        "channels": ch,
        "source": "IRSA SPHEREx DR1 all-sky spectral cube, SPECTRAL_CHANNELS table (official 102-channel scheme)",
    }


@router.get("/spectra/cube")
def spectra_cube(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90)) -> dict[str, Any]:
    try:
        return cube_spectrum(adapter(), ra, dec)
    except ArchiveError as e:
        raise HTTPException(502, str(e)) from e


class SpectroRequest(BaseModel):
    ra: float = Field(..., ge=0, lt=360)
    dec: float = Field(..., ge=-90, le=90)
    detectors: list[int] | None = None
    max_exposures: int | None = Field(None, ge=1, le=1000)
    label: str | None = Field(None, max_length=128)
    candidate_id: str | None = None


def run_dict(r: PhotometryRun, with_points: bool = True) -> dict[str, Any]:
    d: dict[str, Any] = {
        "id": r.id,
        "status": r.status,
        "created_at": iso(r.created_at),
        "ra": r.ra,
        "dec": r.dec,
        "label": r.label,
        "candidate_id": r.candidate_id,
        "params": r.params,
        "provenance": r.provenance,
        "n_points": r.n_points,
        "error": r.error,
    }
    if with_points:
        d["points"] = [point_dict(p) for p in sorted(r.points, key=lambda p: (p.wave_um or 0, p.t_mid_mjd))]
    return d


def point_dict(p: PhotometryPoint) -> dict[str, Any]:
    return {
        k: getattr(p, k)
        for k in (
            "product_id",
            "obs_id",
            "detector",
            "channel",
            "subchannel",
            "t_mid_mjd",
            "wave_um",
            "bandwidth_um",
            "flux_ujy",
            "flux_err_ujy",
            "aperture_correction",
            "flux_pointsource_ujy",
            "flux_pointsource_err_ujy",
            "masked_fraction",
            "status",
            "quality",
            "message",
            "access_url",
        )
    } | {"extra": p.extra}


def submit_spectro(req: SpectroRequest) -> dict[str, Any]:
    dets = sorted(set(req.detectors or []))
    rid = (
        "SPX-" + stable_key(round(req.ra, 6), round(req.dec, 6), dets, req.max_exposures, PIPELINE_VERSION)[:12].upper()
    )
    with session() as s:
        r = s.get(PhotometryRun, rid)
        if r is not None and r.status in ("done", "running", "queued"):
            return {"run_id": rid, "status": r.status, "job_id": r.params.get("job_id")}
        if r is None:
            r = PhotometryRun(
                id=rid,
                ra=req.ra,
                dec=req.dec,
                label=req.label,
                candidate_id=req.candidate_id,
                params={"detectors": dets, "max_exposures": req.max_exposures, "pipeline_version": PIPELINE_VERSION},
            )
            s.add(r)
        r.status = "queued"
        r.error = None

    def work(progress: Any) -> dict[str, Any]:
        with session() as s:
            run = s.get(PhotometryRun, rid)
            assert run is not None
            run.status = "running"
        try:
            res = spectrophotometry(adapter(), req.ra, req.dec, dets or None, req.max_exposures, progress)
        except Exception as e:
            with session() as s:
                run = s.get(PhotometryRun, rid)
                assert run is not None
                run.status, run.error = "failed", f"{type(e).__name__}: {e}"
            raise
        with session() as s:
            run = s.get(PhotometryRun, rid)
            assert run is not None
            for p in list(run.points):
                s.delete(p)
            for p in res["points"]:
                extra = {
                    k: v for k, v in p.items() if k in ("quality_reasons", "background_mjy_sr", "aperture_radius_pix")
                }
                s.add(
                    PhotometryPoint(
                        run_id=rid,
                        **{
                            k: p.get(k)
                            for k in (
                                "product_id",
                                "obs_id",
                                "detector",
                                "channel",
                                "subchannel",
                                "t_mid_mjd",
                                "wave_um",
                                "bandwidth_um",
                                "flux_ujy",
                                "flux_err_ujy",
                                "aperture_correction",
                                "flux_pointsource_ujy",
                                "flux_pointsource_err_ujy",
                                "masked_fraction",
                                "status",
                                "quality",
                                "message",
                                "access_url",
                            )
                        },
                        extra=extra,
                    )
                )
            run.status = "done"
            run.n_points = sum(1 for p in res["points"] if p.get("status") == "ok")
            run.provenance = {
                "method": res["method"],
                "calibration": res["calibration"],
                "n_exposures": res["n_exposures"],
                "skipped_over_limit": res["skipped_over_limit"],
                "processed_at": datetime.now(UTC).isoformat(),
                "pipeline_version": PIPELINE_VERSION,
                "archive": "NASA/IPAC IRSA SPHEREx DR1 Level 2 (byte ranges from the AWS mirror or IRSA)",
            }
        return {"run_id": rid, "n_points": run.n_points}

    job_id = jobs.submit("spectrophotometry", {"run_id": rid, "ra": req.ra, "dec": req.dec}, work)
    with session() as s:
        run = s.get(PhotometryRun, rid)
        assert run is not None
        run.params = dict(run.params) | {"job_id": job_id}
    return {"run_id": rid, "status": "queued", "job_id": job_id}


@router.post("/spectra/runs")
def create_spectro_run(req: SpectroRequest) -> dict[str, Any]:
    return submit_spectro(req)


@router.get("/spectra/runs")
def list_spectro_runs(
    ra: float | None = None, dec: float | None = None, radius_arcsec: float = 10.0, candidate_id: str | None = None
) -> list[dict[str, Any]]:
    from stm.science.tracking import sep_arcsec

    with session() as s:
        rows = list(s.scalars(select(PhotometryRun).order_by(PhotometryRun.created_at.desc()).limit(200)))
        out = [run_dict(r, with_points=False) for r in rows]
    if candidate_id:
        out = [r for r in out if r["candidate_id"] == candidate_id]
    if ra is not None and dec is not None:
        out = [r for r in out if sep_arcsec(ra, dec, r["ra"], r["dec"]) <= radius_arcsec]
    return out


@router.get("/spectra/runs/{rid}")
def get_spectro_run(rid: str) -> dict[str, Any]:
    with session() as s:
        r = s.get(PhotometryRun, rid)
        if r is None:
            raise HTTPException(404, "spectrophotometry run not found")
        return run_dict(r)


@router.get("/spectra/runs/{rid}/csv")
def spectro_csv(rid: str) -> Response:
    d = get_spectro_run(rid)
    rows = [{k: v for k, v in p.items() if k != "extra"} for p in d["points"]]
    return _csv(
        rows,
        f"{rid}_spectrophotometry.csv",
        [
            f"Sky Time Machine per-exposure spectrophotometry {rid} at RA={d['ra']:.6f} Dec={d['dec']:.6f}",
            "flux_ujy: measured aperture flux density (derived from archive pixels); flux_pointsource_ujy: aperture-"
            "corrected with the detector EPSF, valid for point sources only",
            d["provenance"].get("method", ""),
        ],
    )


# ------------------------------------------------------------------------------------------ light curves
def _lightcurve(rid: str, channel: int | None, quality: str) -> dict[str, Any]:
    run = get_spectro_run(rid)
    pts = run["points"]
    by_ch: dict[int, int] = {}
    for p in pts:
        if p["status"] == "ok" and p["channel"] is not None:
            by_ch[p["channel"]] = by_ch.get(p["channel"], 0) + 1
    chans = load_channel_table(adapter())
    summary = [chans[c] | {"n_measurements": n} for c, n in sorted(by_ch.items())]
    if channel is None:
        return {
            "run_id": rid,
            "channels": summary,
            "note": "Choose a channel: only measurements in the same official channel are compared in time.",
        }
    sel = [p for p in pts if p["channel"] == channel]
    use = [
        p
        for p in sel
        if p["status"] == "ok"
        and (
            quality == "any" or p["quality"] == "good" or (quality == "warning" and p["quality"] in ("good", "warning"))
        )
    ]
    excluded = [p for p in sel if p not in use]
    stats = light_curve_stats(
        [p["t_mid_mjd"] for p in use],
        [p["flux_ujy"] for p in use],
        [p["flux_err_ujy"] for p in use],
        LightCurveConfig(),
    )
    stats["systematics"] = _lc_systematics(use, chans[channel])
    stats["systematics_possible"] = bool(stats["systematics"])
    return {
        "run_id": rid,
        "ra": run["ra"],
        "dec": run["dec"],
        "channel": chans[channel],
        "channels": summary,
        "points": use,
        "excluded": [{k: p[k] for k in ("product_id", "t_mid_mjd", "status", "quality", "message")} for p in excluded],
        "quality_filter": quality,
        "stats": stats,
        "quantity": "Measured aperture flux density (µJy) in one official channel; times are exposure midpoints.",
    }


def _lc_systematics(pts: list[dict[str, Any]], ch: dict[str, Any]) -> list[str]:
    """Measured warning signs that scatter may be instrumental rather than astrophysical."""
    out: list[str] = []
    waves = [p["wave_um"] for p in pts if p.get("wave_um") is not None]
    if len(waves) >= 2:
        spread = (max(waves) - min(waves)) / ch["bandwidth_um"]
        if spread > 0.5:
            out.append(
                f"The measurements span {spread:.2f} of the channel bandwidth in wavelength "
                f"({min(waves):.4f}–{max(waves):.4f} µm); a steep spectrum can mimic variability."
            )
    pix_sr = (6.15 / 206264.806) ** 2
    ratios = []
    for p in pts:
        bkg = (p.get("extra") or {}).get("background_mjy_sr")
        r = (p.get("extra") or {}).get("aperture_radius_pix")
        if bkg is not None and r and p.get("flux_ujy"):
            bkg_flux = abs(bkg) * pix_sr * 1e12 * math.pi * r**2
            ratios.append(bkg_flux / max(abs(p["flux_ujy"]), 1e-9))
    med_ratio = sorted(ratios)[len(ratios) // 2] if ratios else 0.0
    if med_ratio > 1.0:
        out.append(
            f"The local background in the aperture is {med_ratio:.1f}× the source flux (median): "
            "the source sits on bright extended emission, where annulus background estimates depend on detector "
            "orientation and sampling. Scatter here is likely systematic."
        )
    if len({p.get("detector") for p in pts}) > 1:
        out.append("Measurements come from more than one detector.")
    return out


@router.get("/lightcurves/{rid}")
def light_curve(
    rid: str,
    channel: int | None = Query(None, ge=0, le=101),
    quality: str = Query("warning", pattern="^(good|warning|any)$"),
) -> dict[str, Any]:
    return _lightcurve(rid, channel, quality)


@router.get("/lightcurves/{rid}/csv")
def light_curve_csv(
    rid: str, channel: int = Query(..., ge=0, le=101), quality: str = Query("warning", pattern="^(good|warning|any)$")
) -> Response:
    lc = _lightcurve(rid, channel, quality)
    st = lc["stats"]
    rows = [
        {
            k: p.get(k)
            for k in (
                "product_id",
                "obs_id",
                "t_mid_mjd",
                "wave_um",
                "flux_ujy",
                "flux_err_ujy",
                "quality",
                "masked_fraction",
                "access_url",
            )
        }
        for p in lc["points"]
    ]
    ch = lc["channel"]
    return _csv(
        rows,
        f"{rid}_channel{channel}_lightcurve.csv",
        [
            f"Light curve, run {rid}, channel {channel} (D{ch['detector']}:{ch['subchannel']}, {ch['wave_um']:.3f} µm)",
            f"verdict: {st.get('verdict')}; {st.get('explanation', '')}",
            "Quantity: measured aperture flux density (µJy). Times: exposure midpoints (MJD, UTC).",
        ],
    )


# ------------------------------------------------------------------------------------------ coverage
class CoverageRequest(BaseModel):
    ra: float = Field(..., ge=0, lt=360)
    dec: float = Field(..., ge=-90, le=90)
    size_deg: float = Field(0.5, gt=0.02, le=2.0)
    cells: int = Field(12, ge=3, le=30)
    pass_only: bool = False


def _coverage_key(req: CoverageRequest) -> str:
    return f"coverage/{stable_key(round(req.ra, 4), round(req.dec, 4), req.size_deg, req.cells, req.pass_only)}.json"


@router.post("/coverage")
def coverage_job(req: CoverageRequest) -> dict[str, Any]:
    st = adapter().storage
    key = _coverage_key(req)
    if st.exists(key):
        return {"status": "done", "job_id": None, "result": json.loads(st.read_bytes(key))}

    def work(progress: Any) -> dict[str, Any]:
        res = coverage_grid(adapter(), req.ra, req.dec, req.size_deg, req.cells, req.pass_only, progress=progress)
        res["computed_at"] = datetime.now(UTC).isoformat()
        st.write_bytes(key, json.dumps(res).encode())
        return {"key": key}

    return {"status": "queued", "job_id": jobs.submit("coverage", req.model_dump(), work)}


@router.get("/coverage")
def coverage_get(
    ra: float, dec: float, size_deg: float = 0.5, cells: int = 12, pass_only: bool = False
) -> dict[str, Any]:
    req = CoverageRequest(ra=ra, dec=dec, size_deg=size_deg, cells=cells, pass_only=pass_only)
    st = adapter().storage
    if not st.exists(_coverage_key(req)):
        raise HTTPException(404, "coverage not computed yet; POST /api/coverage to start it")
    return json.loads(st.read_bytes(_coverage_key(req)))


@router.get("/spectra/cube/tile")
def cube_tile(ra: float, dec: float) -> dict[str, Any]:
    try:
        return query_cube_record(adapter(), ra, dec).to_dict()
    except ArchiveError as e:
        raise HTTPException(502, str(e)) from e
