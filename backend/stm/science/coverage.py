"""Observation-coverage maps for a field.

For every SPHEREx Level 2 image overlapping the field we use its own header WCS
(exact footprint) and wavelength lookup to evaluate, on a grid of cells:

* images      — number of (exposure, detector) products covering the cell
* exposures   — number of distinct exposures (one exposure = 6 simultaneous detector images)
* visits      — independent epochs: exposures closer than ``visit_gap_days`` are one visit
* detectors   — number of detectors with any coverage
* pairs       — per detector, pairs of exposures that observed the cell within half a
                bandwidth in wavelength and at least ``min_baseline_days`` apart (usable
                for difference imaging)

Images are never counted as epochs.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from stm.adapters.spherex import SpherexAdapter
from stm.science.fitsio import celestial_wcs, raw_coords, wavelength_at_raw
from stm.science.lightcurve import visits
from stm.science.registration import target_grid


def query_field(
    adapter: SpherexAdapter, ra: float, dec: float, size_deg: float, tiles: int = 3, progress: Any = None
) -> list[Any]:
    """All products overlapping a square field, from a tiles x tiles grid of small SIA cones.

    One large cone over a dense field can time out at the archive proxy; the union of
    sub-cones circumscribing each sub-square covers the whole field. Products are de-duplicated.
    """
    wcs, (n, _) = target_grid(ra, dec, size_deg, size_deg * 3600.0 / tiles)
    sub_r = (size_deg / tiles) / np.sqrt(2.0) * 1.02
    seen: dict[str, Any] = {}
    k = 0
    for j in range(n):
        for i in range(n):
            cra, cdec = (float(v) for v in wcs.pixel_to_world_values(i, j))
            for r in adapter.query_position(cra % 360.0, cdec, sub_r):
                if r.detector:
                    seen.setdefault(r.product_id, r)
            k += 1
            if progress:
                progress(0.02 + 0.08 * k / (n * n), f"Archive query {k}/{n * n} ({len(seen)} products so far)")
    return sorted(seen.values(), key=lambda r: (r.t_mid_mjd, r.detector or 0))


def coverage_grid(
    adapter: SpherexAdapter,
    ra: float,
    dec: float,
    size_deg: float = 0.5,
    cells: int = 12,
    pass_only: bool = False,
    visit_gap_days: float = 0.5,
    min_baseline_days: float = 0.5,
    progress: Any = None,
) -> dict[str, Any]:
    prog = progress or (lambda p, m: None)
    recs = query_field(adapter, ra, dec, size_deg, progress=prog)
    prog(0.1, f"Reading {len(recs)} image headers (HTTP Range, cached after the first time)")
    headers = adapter.fetch_headers(recs)
    luts: dict[int, Any] = {}
    for r in recs:
        if r.detector not in luts and headers.get(r.product_id) is not None:
            luts[int(r.detector or 0)] = adapter.fetch_wavelength_lookup(r)
    prog(0.8, "Evaluating footprints and wavelengths on the grid")
    wcs_grid, (n, _) = target_grid(ra, dec, size_deg, size_deg * 3600.0 / cells)
    yy, xx = np.mgrid[0:n, 0:n].astype(float)
    cra, cdec = wcs_grid.pixel_to_world_values(xx, yy)
    per_cell: list[list[list[dict[str, Any]]]] = [[[] for _ in range(n)] for _ in range(n)]
    skipped = {"no_header": 0, "dqa_fail": 0}
    for r in recs:
        h = headers.get(r.product_id)
        if h is None:
            skipped["no_header"] += 1
            continue
        if pass_only and str(h.get("L1DQAFLG", "Pass")).strip() != "Pass":
            skipped["dqa_fail"] += 1
            continue
        w = celestial_wcs(h)
        px, py = (np.asarray(v, float) for v in w.world_to_pixel_values(cra, cdec))
        inside = (px >= 0) & (py >= 0) & (px < int(h.get("NAXIS1", 2040))) & (py < int(h.get("NAXIS2", 2040)))
        if not inside.any():
            continue
        lut = luts[int(r.detector or 0)]
        xr, yr = raw_coords(h, px, py)
        wave, bw = wavelength_at_raw(np.asarray(lut["x"]), np.asarray(lut["y"]), np.asarray(lut["values"]), xr, yr)
        for j, i in zip(*np.where(inside), strict=False):
            per_cell[j][i].append(
                {
                    "obs": r.obs_id,
                    "det": int(r.detector or 0),
                    "t": float(h.get("MJD-AVG", r.t_mid_mjd)),
                    "w": float(wave[j, i]),
                    "bw": float(bw[j, i]),
                }
            )
    images = np.zeros((n, n), int)
    exposures = np.zeros((n, n), int)
    nvisits = np.zeros((n, n), int)
    ndet = np.zeros((n, n), int)
    pairs = np.zeros((n, n), int)
    pairs_by_det = np.zeros((6, n, n), int)
    span = np.zeros((n, n))
    for j in range(n):
        for i in range(n):
            items = per_cell[j][i]
            if not items:
                continue
            images[j, i] = len(items)
            exp_t = {it["obs"]: it["t"] for it in items}
            exposures[j, i] = len(exp_t)
            ts = np.array(list(exp_t.values()))
            nvisits[j, i] = int(visits(ts, visit_gap_days).max() + 1)
            span[j, i] = float(ts.max() - ts.min())
            ndet[j, i] = len({it["det"] for it in items})
            for d in range(1, 7):
                sub = [it for it in items if it["det"] == d]
                cnt = 0
                for a in range(len(sub)):
                    for b in range(a + 1, len(sub)):
                        x, y = sub[a], sub[b]
                        if abs(x["t"] - y["t"]) >= min_baseline_days and abs(x["w"] - y["w"]) <= 0.25 * (
                            x["bw"] + y["bw"]
                        ):
                            cnt += 1
                pairs_by_det[d - 1, j, i] = cnt
            pairs[j, i] = int(pairs_by_det[:, j, i].sum())
    prog(1.0, "done")
    return {
        "ra": ra,
        "dec": dec,
        "size_deg": size_deg,
        "cells": n,
        "cell_size_arcmin": size_deg * 60.0 / cells,
        "pass_only": pass_only,
        "n_products_queried": len(recs),
        "skipped": skipped,
        "cell_ra": cra.tolist(),
        "cell_dec": cdec.tolist(),
        "layers": {
            "images": images.tolist(),
            "exposures": exposures.tolist(),
            "visits": nvisits.tolist(),
            "detectors": ndet.tolist(),
            "pairs": pairs.tolist(),
            "pairs_by_detector": {str(d + 1): pairs_by_det[d].tolist() for d in range(6)},
            "time_span_days": span.tolist(),
        },
        "orientation": "row 0 = south edge, column 0 = east edge (north up, east left when drawn with rows reversed)",
        "method": f"Exact header WCS footprints; visits = exposures within {visit_gap_days} d grouped; pairs = same "
        f"detector, |Δλ| ≤ 0.5 bandwidth at the cell centre, baseline ≥ {min_baseline_days} d.",
    }
