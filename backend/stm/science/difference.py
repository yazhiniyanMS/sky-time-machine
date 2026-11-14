"""Difference imaging between two registered epochs of the same band.

Steps (each recorded in the returned provenance):

1. Compatibility: same survey, same detector/band, same units, positive
   time baseline. Incompatible pairs are rejected, not subtracted.
2. Spectral matching (SPHEREx linear-variable filters): pixels whose central
   wavelength differs between epochs by more than ``max_dlambda_frac`` of the
   local bandwidth are masked. If too few pixels remain the comparison is
   rejected.
3. Background: the archive zodiacal-light model (ZODI extension) is
   subtracted from each epoch, then a sigma-clipped plane is fitted to the
   residual difference and removed.
4. PSF matching (optional, Gaussian approximation): the sharper epoch is
   convolved to the broader epoch's FWHM using the header PSF_FWHM values.
5. Uncertainty: sigma_D = sqrt(var_A + var_B) after the same operations,
   then rescaled by the robust (MAD) width of D/sigma_D over source-free
   pixels to absorb resampling-correlated noise. The factor is recorded.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np
from astropy.convolution import Gaussian2DKernel, convolve
from astropy.stats import sigma_clip

from stm.science.fitsio import DEFAULT_BAD_FLAGS, CheckResult
from stm.science.registration import RegisteredProduct, registration_check


@dataclass
class DifferenceConfig:
    max_dlambda_frac: float = 0.5  # |lambda_A - lambda_B| / bandwidth allowed per pixel
    min_valid_fraction: float = 0.2  # of region pixels usable in both epochs
    subtract_zodi: bool = True
    fit_background_plane: bool = True
    psf_match: bool = True
    psf_match_min_ratio: float = 1.05  # only match if FWHMs differ by more than 5 %
    noise_rescale: bool = True
    max_registration_shift_pix: float = 0.35
    min_baseline_days: float = 0.0
    bad_flags: tuple[str, ...] = DEFAULT_BAD_FLAGS

    def to_dict(self) -> dict[str, Any]:
        d = dict(self.__dict__)
        d["bad_flags"] = list(self.bad_flags)
        return d


@dataclass
class DifferenceResult:
    a: np.ndarray  # epoch A, background-subtracted (and PSF-matched if applied)
    b: np.ndarray
    diff: np.ndarray  # B - A
    sigma: np.ndarray  # 1-sigma uncertainty of diff (after rescale)
    significance: np.ndarray  # diff / sigma
    valid: np.ndarray
    dlambda_frac: np.ndarray | None
    var_a: np.ndarray
    var_b: np.ndarray
    accepted: bool
    checks: list[CheckResult]
    metrics: dict[str, Any] = field(default_factory=dict)


def _plane_fit(z: np.ndarray, mask: np.ndarray) -> tuple[np.ndarray, list[float]]:
    yy, xx = np.mgrid[0 : z.shape[0], 0 : z.shape[1]]
    good = mask & np.isfinite(z)
    if good.sum() < 10:
        return np.zeros_like(z), [0.0, 0.0, 0.0]
    clipped = sigma_clip(z[good], sigma=3, maxiters=5)
    keep = ~np.ma.getmaskarray(clipped)
    A = np.c_[np.ones(keep.sum()), xx[good][keep], yy[good][keep]]
    coef, *_ = np.linalg.lstsq(A, z[good][keep], rcond=None)
    return coef[0] + coef[1] * xx + coef[2] * yy, [float(c) for c in coef]


def compare(ra: RegisteredProduct, rb: RegisteredProduct, cfg: DifferenceConfig | None = None) -> DifferenceResult:
    cfg = cfg or DifferenceConfig()
    A, B = ra.source, rb.source
    checks: list[CheckResult] = list(ra.checks) + list(rb.checks)
    metrics: dict[str, Any] = {}

    checks.append(CheckResult("same_survey", A.survey == B.survey, f"{A.survey} vs {B.survey}"))
    checks.append(
        CheckResult(
            "same_detector",
            A.detector == B.detector,
            f"detector {A.detector} vs {B.detector} (different bands cannot be subtracted)",
        )
    )
    checks.append(
        CheckResult("same_unit", A.unit.replace(" ", "") == B.unit.replace(" ", ""), f"{A.unit!r} vs {B.unit!r}")
    )
    baseline = B.t_mid_mjd - A.t_mid_mjd
    metrics["baseline_days"] = baseline
    checks.append(
        CheckResult(
            "time_baseline",
            baseline > cfg.min_baseline_days,
            f"B - A = {baseline:.4f} d",
            baseline,
            cfg.min_baseline_days,
        )
    )

    valid = ~(ra.bad | rb.bad)

    dl = None
    if ra.wave_um is not None and rb.wave_um is not None:
        bw = np.fmax(np.nan_to_num(ra.bandwidth_um, nan=np.inf), 1e-9) if ra.bandwidth_um is not None else 1.0
        if rb.bandwidth_um is not None and ra.bandwidth_um is not None:
            bw = 0.5 * (ra.bandwidth_um + rb.bandwidth_um)
        dl = np.abs(ra.wave_um - rb.wave_um) / bw
        spectral_ok = dl <= cfg.max_dlambda_frac
        metrics["dlambda_frac_median"] = float(np.nanmedian(dl[valid])) if valid.any() else None
        metrics["wave_a_um_median"] = float(np.nanmedian(ra.wave_um[valid])) if valid.any() else None
        metrics["wave_b_um_median"] = float(np.nanmedian(rb.wave_um[valid])) if valid.any() else None
        frac_spec = float(spectral_ok[valid].mean()) if valid.any() else 0.0
        checks.append(
            CheckResult(
                "spectral_match",
                frac_spec > 0,
                f"{frac_spec:.1%} of common pixels within {cfg.max_dlambda_frac} bandwidth "
                f"(median |dλ|/Δλ = {metrics['dlambda_frac_median']})",
                frac_spec,
                ">0",
            )
        )
        valid &= spectral_ok
    else:
        checks.append(
            CheckResult(
                "spectral_match", True, "no per-pixel wavelength available; assumed broadband", None, None, "warning"
            )
        )

    vfrac = float(valid.mean())
    metrics["valid_fraction"] = vfrac
    checks.append(
        CheckResult(
            "valid_fraction",
            vfrac >= cfg.min_valid_fraction,
            f"{vfrac:.1%} of region usable in both epochs",
            vfrac,
            cfg.min_valid_fraction,
        )
    )

    reg_check, reg_info = registration_check(ra, rb, cfg.max_registration_shift_pix)
    checks.append(reg_check)
    metrics.update(reg_info)

    a = ra.image.copy()
    b = rb.image.copy()
    var_a = ra.variance.copy()
    var_b = rb.variance.copy()
    if cfg.subtract_zodi and ra.zodi is not None and rb.zodi is not None:
        a -= ra.zodi
        b -= rb.zodi
        metrics["zodi_a_median"] = float(np.nanmedian(ra.zodi))
        metrics["zodi_b_median"] = float(np.nanmedian(rb.zodi))

    # PSF matching (Gaussian approximation; SPHEREx PSFs are undersampled and
    # position dependent, so this is only a first-order correction).
    fa, fb = A.psf_fwhm_arcsec, B.psf_fwhm_arcsec
    metrics["psf_fwhm_a_arcsec"], metrics["psf_fwhm_b_arcsec"] = fa, fb
    metrics["psf_matched"] = False
    if cfg.psf_match and fa and fb and max(fa, fb) / min(fa, fb) > cfg.psf_match_min_ratio:
        pix = float(np.abs(ra.wcs.wcs.cdelt[0]) * 3600.0)
        s_kernel = np.sqrt(max(fa, fb) ** 2 - min(fa, fb) ** 2) / 2.3548 / pix
        k = Gaussian2DKernel(s_kernel)
        k2 = k.array**2
        if fa < fb:
            a = convolve(np.where(valid, a, np.nan), k, boundary="extend", nan_treatment="interpolate")
            var_a = (
                convolve(np.where(valid, var_a, np.nan), k2 / k2.sum(), boundary="extend", nan_treatment="interpolate")
                * k2.sum()
            )
        else:
            b = convolve(np.where(valid, b, np.nan), k, boundary="extend", nan_treatment="interpolate")
            var_b = (
                convolve(np.where(valid, var_b, np.nan), k2 / k2.sum(), boundary="extend", nan_treatment="interpolate")
                * k2.sum()
            )
        metrics["psf_matched"] = True
        metrics["psf_kernel_sigma_pix"] = float(s_kernel)

    diff = b - a
    bg_mask = valid & ~(ra.source_flag | rb.source_flag)
    if bg_mask.sum() < 30:
        bg_mask = valid
    if cfg.fit_background_plane:
        plane, coef = _plane_fit(diff, bg_mask)
        diff = diff - plane
        metrics["background_plane"] = {"c0": coef[0], "cx": coef[1], "cy": coef[2]}

    sigma = np.sqrt(var_a + var_b)
    sig = np.where(valid, diff / sigma, np.nan)
    scale = 1.0
    if cfg.noise_rescale and bg_mask.sum() >= 30:
        s = sig[bg_mask & np.isfinite(sig)]
        mad = float(np.median(np.abs(s - np.median(s))) * 1.4826)
        if np.isfinite(mad) and mad > 0:
            scale = float(np.clip(mad, 0.5, 5.0))
    metrics["noise_rescale_factor"] = scale
    sigma = sigma * scale
    sig = np.where(valid, diff / sigma, np.nan)

    accepted = all(c.passed for c in checks if c.severity == "error")
    return DifferenceResult(
        a=np.where(valid, a, np.nan),
        b=np.where(valid, b, np.nan),
        diff=np.where(valid, diff, np.nan),
        sigma=np.where(valid, sigma, np.nan),
        significance=sig,
        valid=valid,
        dlambda_frac=dl,
        var_a=var_a,
        var_b=var_b,
        accepted=accepted,
        checks=checks,
        metrics=metrics,
    )
