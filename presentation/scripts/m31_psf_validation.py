"""Re-run the M31 detector-1 comparison (CMP-51639AE12EE9 inputs) with the old and new PSF matching.

Uses the locally cached IRSA DR1 cutouts written by the pipeline. Prints the measured numbers and writes
presentation/assets/m31_validation.json. Run from the repository root:
    .venv/bin/python presentation/scripts/m31_psf_validation.py
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from stm.pipeline import ProcessingConfig, process_products
from stm.science.fitsio import load_spherex_l2

ROOT = Path(__file__).resolve().parents[2]
CUT = ROOT / "data/spherex/cutouts"
A = CUT / "2025W28_2A_0263_3D1_6fed951d3c826bb6ae66.fits"
B = CUT / "2026W01_2A_0680_1D1_6fed951d3c826bb6ae66.fits"
RA, DEC, SIZE = 10.6847, 41.269, 0.1


def run(method: str) -> dict:
    cfg = ProcessingConfig()
    cfg.difference.psf_method = method
    pa = load_spherex_l2(A, "2025W28_2A_0263_3D1")
    pb = load_spherex_l2(B, "2026W01_2A_0680_1D1")
    out = process_products(pa, pb, RA, DEC, SIZE, cfg)
    res = out["res"]
    sig = np.where(res.valid, res.significance, np.nan)
    np.savez_compressed(
        ROOT / f"presentation/assets/m31_{method}.npz",
        a=out["ra_reg"].image,
        b=out["rb_reg"].image,
        a_bs=res.a,
        significance=sig,
        valid=res.valid,
    )
    return {
        "method": method,
        "psf_method_recorded": res.metrics.get("psf_method"),
        "peak_abs_sigma": float(np.nanmax(np.abs(sig))),
        "peak_pos_sigma": float(np.nanmax(sig)),
        "peak_neg_sigma": float(np.nanmin(sig)),
        "noise_rescale_factor": res.metrics.get("noise_rescale_factor"),
        "psf_fwhm_effective_arcsec": res.metrics.get("psf_fwhm_effective_arcsec"),
        "candidates": [
            {
                "rank": i["rank"],
                "tier": i["tier"],
                "class": i["machine_class"],
                "peak_sigma": float(i["detection"].peak_significance),
                "checks_failed": [c.name for c in i["checks"] if not c.passed],
            }
            for i in out["items"]
        ],
        "metrics": {k: v for k, v in res.metrics.items() if isinstance(v, (int, float, str, bool))},
        "psf": {k: res.metrics.get(k) for k in ("psf_a", "psf_b", "psf_kernel_a", "psf_kernel_b")},
        "registration_residual_px": res.metrics.get("residual_shift_pix"),
        "wave_um": [res.metrics.get("wave_a_um_median"), res.metrics.get("wave_b_um_median")],
        "baseline_days": res.metrics.get("baseline_days"),
    }


if __name__ == "__main__":
    results = {m: run(m) for m in ("gaussian", "epsf_cross")}
    (ROOT / "presentation/assets/m31_validation.json").write_text(json.dumps(results, indent=2))
    for m, r in results.items():
        print(m, r["psf_method_recorded"], "peak|S|=%.2f" % r["peak_abs_sigma"], "min=%.2f max=%.2f" % (r["peak_neg_sigma"], r["peak_pos_sigma"]))
        for c in r["candidates"]:
            print("   ", c)
