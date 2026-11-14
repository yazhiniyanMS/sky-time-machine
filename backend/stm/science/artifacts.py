"""Artifact rejection: per-candidate quality checks.

Each check is a documented, measurable test. A failed *error* check marks
the candidate as rejected (kept for audit, excluded from default views);
*warning* checks lower the quality tier but keep the candidate visible.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
from scipy.ndimage import distance_transform_edt

from stm.science.detection import Detection
from stm.science.difference import DifferenceResult
from stm.science.fitsio import DEFAULT_BAD_FLAGS, SOFT_FLAGS, CheckResult
from stm.science.registration import RegisteredProduct


@dataclass
class ArtifactConfig:
    max_masked_fraction_in_aperture: float = 0.3
    min_edge_distance_fwhm: float = 1.5
    dipole_search_fwhm: float = 2.0
    dipole_min_ratio: float = 0.3  # opposite lobe |S| relative to candidate |S|
    bright_residual_snr: float = 50.0  # epoch S/N above which small fractional changes are suspect
    bright_residual_max_frac: float = 0.1  # |dF| / F below which a bright-source change is suspect
    max_dlambda_frac: float = 0.5
    flag_dilation_pix: int = 1

    def to_dict(self) -> dict[str, Any]:
        return dict(self.__dict__)


def _flag_names_near(reg: RegisteredProduct, x: float, y: float, r: float) -> list[str]:
    yy, xx = np.mgrid[0 : reg.flags.shape[0], 0 : reg.flags.shape[1]]
    near = (xx - x) ** 2 + (yy - y) ** 2 <= r**2
    bits = int(np.bitwise_or.reduce(reg.flags[near].astype(np.int64))) if near.any() else 0
    return sorted(
        n for n, b in reg.source.flag_bits.items() if bits & (1 << b) and (n in DEFAULT_BAD_FLAGS or n in SOFT_FLAGS)
    )


def assess(
    det: Detection,
    all_dets: list[Detection],
    res: DifferenceResult,
    ra_reg: RegisteredProduct,
    rb_reg: RegisteredProduct,
    cfg: ArtifactConfig | None = None,
) -> list[CheckResult]:
    cfg = cfg or ArtifactConfig()
    pix = float(abs(ra_reg.wcs.wcs.cdelt[0]) * 3600.0)
    fwhm_pix = (det.extra.get("fwhm_arcsec") or 2 * pix) / pix
    r_ap = det.extra.get("aperture_radius_pix", 1.5 * fwhm_pix)
    ny, nx = res.valid.shape
    yy, xx = np.mgrid[0:ny, 0:nx]
    in_ap = (xx - det.x) ** 2 + (yy - det.y) ** 2 <= r_ap**2
    checks: list[CheckResult] = []

    masked = float((~res.valid[in_ap]).mean()) if in_ap.any() else 1.0
    checks.append(
        CheckResult(
            "aperture_masking",
            masked <= cfg.max_masked_fraction_in_aperture,
            f"{masked:.0%} of the measurement aperture is masked (bad pixels, coverage, or spectral mismatch)",
            masked,
            cfg.max_masked_fraction_in_aperture,
        )
    )

    # distance to the nearest unusable pixel (footprint edge, masked pixel, spectral mismatch)
    dist = distance_transform_edt(np.pad(res.valid, 1))[1:-1, 1:-1]
    iy, ix = min(max(int(round(det.y)), 0), ny - 1), min(max(int(round(det.x)), 0), nx - 1)
    edge = float(dist[iy, ix]) / fwhm_pix
    checks.append(
        CheckResult(
            "edge_distance",
            edge >= cfg.min_edge_distance_fwhm,
            f"{edge:.1f} FWHM from the nearest unusable pixel",
            edge,
            cfg.min_edge_distance_fwhm,
            "warning",
        )
    )

    near_a = _flag_names_near(ra_reg, det.x, det.y, r_ap + cfg.flag_dilation_pix)
    near_b = _flag_names_near(rb_reg, det.x, det.y, r_ap + cfg.flag_dilation_pix)
    checks.append(
        CheckResult(
            "quality_flags_nearby",
            not (near_a or near_b),
            f"archive quality flags near candidate: A={near_a or 'none'}, B={near_b or 'none'}",
            {"A": near_a, "B": near_b},
            "none",
            "warning",
        )
    )

    # Dipole: an opposite-sign detection close by suggests misregistration,
    # PSF mismatch, or a source that moved by less than ~2 FWHM.
    dipole = None
    for o in all_dets:
        if o is det or o.sign == det.sign:
            continue
        sep = np.hypot(o.x - det.x, o.y - det.y)
        if sep <= cfg.dipole_search_fwhm * fwhm_pix and abs(o.peak_significance) >= cfg.dipole_min_ratio * abs(
            det.peak_significance
        ):
            dipole = (float(sep), float(o.peak_significance))
            break
    checks.append(
        CheckResult(
            "dipole",
            dipole is None,
            "no opposite-sign residual nearby"
            if dipole is None
            else f"opposite-sign residual {dipole[0]:.1f} px away (S={dipole[1]:.1f}): possible "
            "registration/PSF residual",
            dipole,
            f"<{cfg.dipole_min_ratio} x |S| within {cfg.dipole_search_fwhm} FWHM",
            "warning",
        )
    )

    # Bright-source residual: a small fractional change on a high-S/N source
    # is typical of PSF variation across the detector rather than real change.
    ref_snr = max(det.snr_a, det.snr_b)
    ref_flux = max(abs(det.flux_a_ujy), abs(det.flux_b_ujy))
    frac = abs(det.diff_flux_ujy) / ref_flux if ref_flux > 0 else np.inf
    bright_resid = ref_snr >= cfg.bright_residual_snr and frac < cfg.bright_residual_max_frac
    checks.append(
        CheckResult(
            "bright_source_residual",
            not bright_resid,
            f"fractional change {frac:.3f} on a source with epoch S/N {ref_snr:.0f}",
            {"fractional_change": frac, "epoch_snr": ref_snr},
            f"not (S/N>={cfg.bright_residual_snr} and frac<{cfg.bright_residual_max_frac})",
            "warning",
        )
    )

    # Spectral consistency at the candidate position.
    if det.wave_a_um is not None and det.wave_b_um is not None and det.bandwidth_um:
        dl = abs(det.wave_a_um - det.wave_b_um) / det.bandwidth_um
        checks.append(
            CheckResult(
                "spectral_consistency",
                dl <= cfg.max_dlambda_frac,
                f"|λA-λB| = {abs(det.wave_a_um - det.wave_b_um) * 1000:.1f} nm ({dl:.2f} of bandwidth)",
                dl,
                cfg.max_dlambda_frac,
            )
        )

    # Compactness: SPHEREx PSFs are ~1.2 px FWHM, so 2-pixel detections are
    # possible for real point sources but also typical of residual hot pixels.
    checks.append(
        CheckResult("extent", det.npix >= 3, f"{det.npix} pixels above threshold", det.npix, ">=3", "warning")
    )
    return checks


def is_rejected(checks: list[CheckResult]) -> bool:
    return any((not c.passed) and c.severity == "error" for c in checks)
