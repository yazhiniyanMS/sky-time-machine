"""End-to-end processing orchestration with provenance.

Stages: A retrieval -> B preprocessing/validation -> C registration ->
D differencing -> E detection -> F artifact rejection -> G ranking ->
H persistence of products, measurements and provenance.
"""

from __future__ import annotations

import io
import json
import platform
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import astropy
import numpy as np
import photutils
import reproject
import scipy
from astropy.io import fits
from sqlalchemy import select

from stm import PIPELINE_VERSION, __version__
from stm.adapters.base import ArchiveError, ObservationRecord
from stm.adapters.spherex import SPHEREX_BANDS, SpherexAdapter
from stm.db import Candidate, Comparison, session
from stm.jobs import ProgressFn
from stm.science import artifacts, ranking
from stm.science.detection import DetectionConfig, detect
from stm.science.difference import DifferenceConfig, DifferenceResult, compare
from stm.science.fitsio import ImageProduct, load_spherex_l2, wavelength_at_sky
from stm.science.registration import RegisteredProduct, register, target_grid
from stm.storage import stable_key

LAYERS = (
    "a",
    "b",
    "diff",
    "sigma",
    "significance",
    "valid",
    "dlambda_frac",
    "wave_a",
    "wave_b",
    "bad_a",
    "bad_b",
    "source_a",
    "source_b",
)

LAYER_INFO = {
    "a": ("original", "Epoch A archive IMAGE (MJy/sr), resampled to the common grid (bilinear); no background removed"),
    "b": ("original", "Epoch B archive IMAGE (MJy/sr), resampled to the common grid (bilinear); no background removed"),
    "diff": ("derived", "Difference B − A after ZODI subtraction, optional PSF matching and background plane (MJy/sr)"),
    "sigma": (
        "derived",
        "1σ uncertainty of the difference, propagated from VARIANCE and empirically rescaled (MJy/sr)",
    ),
    "significance": ("derived", "Difference / sigma (dimensionless)"),
    "valid": ("derived", "1 where both epochs are usable and spectrally matched"),
    "dlambda_frac": ("derived", "|λA − λB| / bandwidth per pixel"),
    "wave_a": ("derived", "Epoch A central wavelength per pixel (µm) from the WCS-WAVE lookup"),
    "wave_b": ("derived", "Epoch B central wavelength per pixel (µm) from the WCS-WAVE lookup"),
    "bad_a": ("derived", "1 where epoch A is masked (archive quality flags, NaN, outside footprint)"),
    "bad_b": ("derived", "1 where epoch B is masked"),
    "source_a": ("original", "Archive SOURCE flag (known catalogue source) for epoch A"),
    "source_b": ("original", "Archive SOURCE flag (known catalogue source) for epoch B"),
}


@dataclass
class ProcessingConfig:
    difference: DifferenceConfig = field(default_factory=DifferenceConfig)
    detection: DetectionConfig = field(default_factory=DetectionConfig)
    artifacts: artifacts.ArtifactConfig = field(default_factory=artifacts.ArtifactConfig)

    def to_dict(self) -> dict[str, Any]:
        return {
            "difference": self.difference.to_dict(),
            "detection": self.detection.to_dict(),
            "artifacts": self.artifacts.to_dict(),
        }


def software_versions() -> dict[str, str]:
    return {
        "sky_time_machine": __version__,
        "pipeline": PIPELINE_VERSION,
        "python": platform.python_version(),
        "astropy": astropy.__version__,
        "numpy": np.__version__,
        "scipy": scipy.__version__,
        "reproject": reproject.__version__,
        "photutils": photutils.__version__,
    }


def comparison_id(ra: float, dec: float, size_deg: float, a: str, b: str, cfg: ProcessingConfig) -> str:
    return (
        "CMP-"
        + stable_key(
            round(ra, 6),
            round(dec, 6),
            round(size_deg, 4),
            a,
            b,
            json.dumps(cfg.to_dict(), sort_keys=True),
            PIPELINE_VERSION,
        )[:12].upper()
    )


def find_records(adapter: SpherexAdapter, ra: float, dec: float, ids: list[str]) -> dict[str, ObservationRecord]:
    recs = {r.product_id: r for r in adapter.query_position(ra, dec, 0.01)}
    missing = [i for i in ids if i not in recs]
    if missing:
        raise ArchiveError(f"Products not found covering ({ra:.5f}, {dec:.5f}): {missing}")
    return {i: recs[i] for i in ids}


def spectral_timeline(adapter: SpherexAdapter, ra: float, dec: float, detector: int) -> dict[str, Any]:
    """Per-observation wavelength at (ra, dec) for one detector, plus spectrally matched pairs."""
    recs = [r for r in adapter.query_position(ra, dec, 0.01) if r.detector == detector]
    if not recs:
        return {"detector": detector, "observations": [], "pairs": []}
    headers = adapter.fetch_headers(recs)
    lut = adapter.fetch_wavelength_lookup(recs[0])
    rows = []
    for r in recs:
        h = headers.get(r.product_id)
        row: dict[str, Any] = {
            "product_id": r.product_id,
            "obs_id": r.obs_id,
            "t_mid_mjd": r.t_mid_mjd,
            "date_iso": h.get("DATE-AVG") if h is not None else None,
        }
        if h is None:
            row["error"] = "header unavailable"
        else:
            row.update(wavelength_at_sky(h, lut, ra, dec))
            row["psf_fwhm_arcsec"] = h.get("PSF_FWHM")
            row["astrometry_solved"] = h.get("ASTRONETSOLVED")
            row["l1_dqa"] = h.get("L1DQAFLG")
        rows.append(row)
    pairs = []
    good = [r for r in rows if r.get("in_footprint") and "wave_um" in r]
    for i, x in enumerate(good):
        for y in good[i + 1 :]:
            dt = y["t_mid_mjd"] - x["t_mid_mjd"]
            bw = 0.5 * (x["bandwidth_um"] + y["bandwidth_um"])
            dl = abs(x["wave_um"] - y["wave_um"]) / bw
            if dl <= 0.5 and dt >= 0.5:
                pairs.append(
                    {
                        "a": x["product_id"],
                        "b": y["product_id"],
                        "baseline_days": dt,
                        "dlambda_frac": dl,
                        "dlambda_nm": abs(x["wave_um"] - y["wave_um"]) * 1000,
                    }
                )
    pairs.sort(key=lambda p: (p["dlambda_frac"] > 0.25, -p["baseline_days"]))
    return {
        "detector": detector,
        "band": SPHEREX_BANDS.get(detector),
        "observations": rows,
        "pairs": pairs,
        "wavelength_lookup": {
            "calibration_source": lut.get("calibration_source"),
            "pipeline_version": lut.get("pipeline_version"),
            "from_product": lut.get("from_product"),
        },
        "method": "Wavelength at the target estimated from each exposure's full-frame WCS (read via HTTP "
        "Range) and the detector's WCS-WAVE lookup table. Pairs: |Δλ| ≤ 0.5 bandwidth and "
        "baseline ≥ 0.5 day.",
    }


def _pack_layers(res: DifferenceResult, ra_reg: RegisteredProduct, rb_reg: RegisteredProduct) -> dict[str, np.ndarray]:
    z = lambda shape: np.full(shape, np.nan, dtype=np.float32)  # noqa: E731
    shape = res.diff.shape
    return {
        "a": ra_reg.image.astype(np.float32),
        "b": rb_reg.image.astype(np.float32),
        "diff": res.diff.astype(np.float32),
        "sigma": res.sigma.astype(np.float32),
        "significance": res.significance.astype(np.float32),
        "valid": res.valid.astype(np.float32),
        "dlambda_frac": res.dlambda_frac.astype(np.float32) if res.dlambda_frac is not None else z(shape),
        "wave_a": ra_reg.wave_um.astype(np.float32) if ra_reg.wave_um is not None else z(shape),
        "wave_b": rb_reg.wave_um.astype(np.float32) if rb_reg.wave_um is not None else z(shape),
        "bad_a": ra_reg.bad.astype(np.float32),
        "bad_b": rb_reg.bad.astype(np.float32),
        "source_a": ra_reg.source_flag.astype(np.float32),
        "source_b": rb_reg.source_flag.astype(np.float32),
    }


def process_products(
    pa: ImageProduct, pb: ImageProduct, ra: float, dec: float, size_deg: float, cfg: ProcessingConfig
) -> dict[str, Any]:
    """Pure processing on in-memory products (used by the pipeline and by tests)."""
    if pa.t_mid_mjd > pb.t_mid_mjd:
        pa, pb = pb, pa
    pixscale = round(min(pa.pixel_scale_arcsec, pb.pixel_scale_arcsec), 3)
    wcs_out, shape = target_grid(ra, dec, size_deg, pixscale)
    ra_reg = register(pa, wcs_out, shape, cfg.difference.bad_flags)
    rb_reg = register(pb, wcs_out, shape, cfg.difference.bad_flags)
    res = compare(ra_reg, rb_reg, cfg.difference)
    dets = detect(res, ra_reg, rb_reg, cfg.detection) if res.accepted else []
    items: list[dict[str, Any]] = []
    for k, d in enumerate(dets):
        d.extra["pixscale_arcsec"] = pixscale
        checks = artifacts.assess(d, dets, res, ra_reg, rb_reg, cfg.artifacts)
        tier = ranking.quality_tier(checks)
        items.append(
            {"key": k, "detection": d, "checks": checks, "tier": tier, "machine_class": ranking.classify(d, checks)}
        )
    ranking.mark_moving_pairs(items)
    items.sort(key=lambda i: ranking.rank_key(i["tier"], i["detection"].peak_significance))
    for r, i in enumerate(items, start=1):
        i["rank"] = r
        i["explanation"] = ranking.explain(i["detection"], i["tier"], i["checks"], i["machine_class"])
    return {
        "pa": pa,
        "pb": pb,
        "wcs": wcs_out,
        "shape": shape,
        "ra_reg": ra_reg,
        "rb_reg": rb_reg,
        "res": res,
        "items": items,
        "pixscale": pixscale,
    }


def run_comparison(
    ra: float,
    dec: float,
    size_deg: float,
    product_a: str,
    product_b: str,
    progress: ProgressFn | None = None,
    cfg: ProcessingConfig | None = None,
    adapter: SpherexAdapter | None = None,
) -> dict[str, Any]:
    cfg = cfg or ProcessingConfig()
    adapter = adapter or SpherexAdapter()
    prog = progress or (lambda p, m: None)
    cid = comparison_id(ra, dec, size_deg, product_a, product_b, cfg)
    with session() as s:
        existing = s.get(Comparison, cid)
        if existing is not None and existing.status in ("done", "rejected"):
            return {"comparison_id": cid, "cached": True}
        if existing is None:
            s.add(
                Comparison(
                    id=cid,
                    ra=ra,
                    dec=dec,
                    size_deg=size_deg,
                    product_a=product_a,
                    product_b=product_b,
                    status="running",
                    pipeline_version=PIPELINE_VERSION,
                )
            )
        else:
            existing.status = "running"
            existing.error = None
    started = datetime.now(UTC)
    try:
        prog(0.05, "Stage A: resolving archive records")
        recs = find_records(adapter, ra, dec, [product_a, product_b])
        paths = {}
        for i, (pid, rec) in enumerate(recs.items()):
            prog(0.1 + 0.3 * i, f"Stage A: downloading cutout {pid}")
            paths[pid] = adapter.fetch_cutout(rec, ra, dec, size_deg * 1.6)
        prog(0.45, "Stage B: reading and validating FITS")
        pa = load_spherex_l2(paths[product_a], product_a)
        pb = load_spherex_l2(paths[product_b], product_b)
        prog(0.55, "Stages C–G: registration, differencing, detection, artifact checks, ranking")
        out = process_products(pa, pb, ra, dec, size_deg, cfg)
        res: DifferenceResult = out["res"]
        pa, pb = out["pa"], out["pb"]
        prog(0.85, "Stage H: storing products and provenance")
        layers = _pack_layers(res, out["ra_reg"], out["rb_reg"])
        buf = io.BytesIO()
        np.savez_compressed(buf, **layers)  # type: ignore[arg-type]
        arrays_key = f"products/{cid}.npz"
        adapter.storage.write_bytes(arrays_key, buf.getvalue())
        wcs_hdr = out["wcs"].to_header()
        adapter.storage.write_bytes(f"products/{cid}.wcs.hdr", wcs_hdr.tostring().encode("ascii"))

        provenance = {
            "inputs": [
                _input_prov(recs[p.product_id], p, paths[p.product_id], adapter, ra, dec, size_deg * 1.6)
                for p in (pa, pb)
            ],
            "processed_at": started.isoformat(),
            "finished_at": datetime.now(UTC).isoformat(),
            "software": software_versions(),
            "config": cfg.to_dict(),
            "grid": {
                "ra": ra,
                "dec": dec,
                "size_deg": size_deg,
                "pixscale_arcsec": out["pixscale"],
                "shape": list(out["shape"]),
                "projection": "TAN",
                "wcs_header": dict(wcs_hdr),
            },
            "quality_checks": [c.to_dict() for c in res.checks],
            "metrics": _jsonify(res.metrics),
            "layers": {k: {"kind": v[0], "description": v[1]} for k, v in LAYER_INFO.items()},
            "input_validation": {p.product_id: [c.to_dict() for c in p.checks] for p in (pa, pb)},
        }
        n_rej = sum(1 for i in out["items"] if i["tier"] == "R")
        summary = {
            "accepted": res.accepted,
            "n_candidates": len(out["items"]),
            "n_rejected": n_rej,
            "n_tier_a": sum(1 for i in out["items"] if i["tier"] == "A"),
            "baseline_days": res.metrics.get("baseline_days"),
            "rejection_reasons": [c.detail for c in res.checks if not c.passed and c.severity == "error"],
        }
        with session() as s:
            comp = s.get(Comparison, cid)
            assert comp is not None
            comp.status = "done" if res.accepted else "rejected"
            comp.detector = pa.detector
            comp.product_a, comp.product_b = pa.product_id, pb.product_id
            comp.t_a_mjd, comp.t_b_mjd = pa.t_mid_mjd, pb.t_mid_mjd
            comp.arrays_key = arrays_key
            comp.provenance = provenance
            comp.summary = summary
            for c in list(comp.candidates):
                s.delete(c)
            s.flush()
            year = started.year
            for it in out["items"]:
                d = it["detection"]
                meas = _jsonify(d.measurements())
                meas["epoch_signal_mjd"] = pb.t_mid_mjd if d.sign > 0 else pa.t_mid_mjd
                if it.get("pair_with"):
                    meas["paired_with_keys"] = it["pair_with"]
                cand = Candidate(
                    id=f"tmp-{cid}-{it['key']}",
                    comparison_id=cid,
                    ra=d.ra,
                    dec=d.dec,
                    sign=d.sign,
                    peak_significance=d.peak_significance,
                    quality_tier=it["tier"],
                    rejected=it["tier"] == "R",
                    machine_class=it["machine_class"],
                    rank_in_comparison=it["rank"],
                    rank_explanation=it["explanation"],
                    measurements=meas,
                    quality_checks=[c.to_dict() for c in it["checks"]],
                    pipeline_version=PIPELINE_VERSION,
                )
                s.add(cand)
                s.flush()
                cand.id = f"ST-{year}-{cand.pk:06d}"
                it["candidate_id"] = cand.id
            # resolve moving-pair keys to candidate ids
            key_to_id = {it["key"]: it["candidate_id"] for it in out["items"]}
            for cand in comp.candidates:
                keys = cand.measurements.get("paired_with_keys")
                if keys:
                    m = dict(cand.measurements)
                    m["paired_with"] = [key_to_id[k] for k in keys]
                    m.pop("paired_with_keys", None)
                    cand.measurements = m
        prog(1.0, "done")
        return {"comparison_id": cid, "cached": False, **summary}
    except Exception as e:
        with session() as s:
            comp = s.get(Comparison, cid)
            if comp is not None:
                comp.status = "failed"
                comp.error = f"{type(e).__name__}: {e}"
        raise


def _input_prov(
    rec: ObservationRecord, p: ImageProduct, path: Any, adapter: SpherexAdapter, ra: float, dec: float, size: float
) -> dict[str, Any]:
    return {
        "product_id": p.product_id,
        "obs_id": rec.obs_id,
        "detector": rec.detector,
        "band": rec.band_name,
        "collection": rec.collection,
        "access_url": rec.access_url,
        "cutout_url": adapter.cutout_url(rec, ra, dec, min(size, adapter.settings.max_cutout_deg)),
        "cloud_access": rec.cloud_access,
        "t_mid_mjd": p.t_mid_mjd,
        "date_iso": p.date_iso,
        "exptime_s": p.exptime_s,
        "psf_fwhm_arcsec": p.psf_fwhm_arcsec,
        "header": p.header_meta,
        "flag_definitions": p.flag_bits,
        "local_cache": str(path),
        "synthetic": p.synthetic,
    }


def load_layers(storage: Any, comp: Comparison) -> dict[str, np.ndarray]:
    if not comp.arrays_key:
        raise FileNotFoundError("comparison has no stored products")
    with np.load(io.BytesIO(storage.read_bytes(comp.arrays_key))) as z:
        return {k: z[k] for k in z.files}


def layer_fits(storage: Any, comp: Comparison, layer: str) -> bytes:
    arrs = load_layers(storage, comp)
    hdr = fits.Header.fromstring(storage.read_bytes(f"products/{comp.id}.wcs.hdr").decode("ascii"))
    kind, desc = LAYER_INFO[layer]
    hdr["STM_LAYR"] = (layer, "Sky Time Machine layer")
    hdr["STM_KIND"] = (kind, "original (archive pixels) or derived")
    hdr["STM_CMP"] = (comp.id, "comparison id")
    hdr["STM_PIPE"] = (comp.pipeline_version, "pipeline version")
    hdr["STM_A"] = (comp.product_a, "epoch A product")
    hdr["STM_B"] = (comp.product_b, "epoch B product")
    ascii_desc = (
        desc.replace("−", "-")
        .replace("σ", "sigma")
        .replace("λ", "lambda")
        .replace("µ", "u")
        .encode("ascii", "replace")
        .decode()
    )
    hdr.add_comment(ascii_desc)
    hdr.add_comment("Source data: NASA/IPAC IRSA SPHEREx. Derived by Sky Time Machine; not an archive product.")
    buf = io.BytesIO()
    fits.PrimaryHDU(data=arrs[layer], header=hdr).writeto(buf)
    return buf.getvalue()


def candidates_near(ra: float, dec: float, radius_deg: float) -> list[Candidate]:
    from stm.science.tracking import sep_arcsec

    with session() as s:
        cosd = max(np.cos(np.radians(dec)), 1e-3)
        q = select(Candidate).where(Candidate.dec.between(dec - radius_deg, dec + radius_deg))
        out = []
        for c in s.scalars(q):
            dra = ((c.ra - ra + 180) % 360) - 180
            if abs(dra) * cosd <= radius_deg * 1.01 and sep_arcsec(ra, dec, c.ra, c.dec) <= radius_deg * 3600:
                out.append(c)
        return out


def _jsonify(v: Any) -> Any:
    if isinstance(v, dict):
        return {str(k): _jsonify(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_jsonify(x) for x in v]
    if isinstance(v, (np.floating, float)):
        f = float(v)
        return f if np.isfinite(f) else None
    if isinstance(v, np.integer):
        return int(v)
    if isinstance(v, np.bool_):
        return bool(v)
    return v
