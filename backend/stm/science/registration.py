"""Registration of image products onto a common celestial pixel grid.

Each product is resampled onto a tangent-plane grid centred on the region of
interest using its own (archive-provided) astrometric WCS. Science and
variance planes use bilinear interpolation; flag planes use nearest
neighbour so bit values are never mixed. Bilinear resampling correlates noise
between neighbouring pixels; this is *not* captured by the per-pixel
variance, and is corrected empirically downstream (see difference.py).

After resampling we measure the residual translation between the two
registered images by phase correlation as an astrometric consistency check.
We report the residual but do not apply it: the archive WCS is the
calibrated solution, and a large residual is a reason to reject the
comparison, not to silently shift the data.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np
from astropy.wcs import WCS
from reproject import reproject_interp

from stm.science.fitsio import DEFAULT_BAD_FLAGS, CheckResult, ImageProduct


@dataclass
class RegisteredProduct:
    source: ImageProduct
    wcs: WCS
    image: np.ndarray
    variance: np.ndarray
    flags: np.ndarray
    bad: np.ndarray  # True where unusable (flags, NaN, outside footprint)
    footprint: np.ndarray  # fraction of each output pixel covered by input
    zodi: np.ndarray | None
    wave_um: np.ndarray | None
    bandwidth_um: np.ndarray | None
    source_flag: np.ndarray  # SOURCE (known catalogue source) bit, informational
    checks: list[CheckResult] = field(default_factory=list)


def target_grid(ra: float, dec: float, size_deg: float, pixscale_arcsec: float) -> tuple[WCS, tuple[int, int]]:
    n = int(np.ceil(size_deg * 3600.0 / pixscale_arcsec))
    n += (n + 1) % 2  # odd so the target sits on the central pixel
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2.0, (n + 1) / 2.0]
    w.wcs.cdelt = [-pixscale_arcsec / 3600.0, pixscale_arcsec / 3600.0]
    w.wcs.cunit = ["deg", "deg"]
    w.wcs.radesys = "ICRS"
    return w, (n, n)


def _reproject(
    data: np.ndarray, wcs_in: WCS, wcs_out: WCS, shape: tuple[int, int], order: str
) -> tuple[np.ndarray, np.ndarray]:
    out, fp = reproject_interp((data, wcs_in), wcs_out, shape_out=shape, order=order, return_footprint=True)
    return np.asarray(out, dtype=np.float64), np.asarray(fp, dtype=np.float64)


def register(
    product: ImageProduct, wcs_out: WCS, shape: tuple[int, int], bad_flags: tuple[str, ...] = DEFAULT_BAD_FLAGS
) -> RegisteredProduct:
    image, fp = _reproject(product.image, product.wcs, wcs_out, shape, "bilinear")
    var, _ = _reproject(product.variance, product.wcs, wcs_out, shape, "bilinear")
    # Nearest-neighbour for bit masks (float64 represents int32 bit patterns exactly).
    flags_f, _ = _reproject(product.flags.astype(np.float64), product.wcs, wcs_out, shape, "nearest-neighbor")
    flags = np.where(np.isfinite(flags_f), flags_f, 0).astype(np.int64)
    # Bad-pixel mask is grown by resampling it bilinearly: any output pixel
    # that draws on a bad input pixel is itself marked bad.
    bad_in = product.bad_mask(bad_flags).astype(np.float64)
    bad_r, _ = _reproject(bad_in, product.wcs, wcs_out, shape, "bilinear")
    bad = ~np.isfinite(bad_r) | (bad_r > 0) | (fp < 0.999) | ~np.isfinite(image) | ~np.isfinite(var) | (var <= 0)
    zodi = _reproject(product.zodi, product.wcs, wcs_out, shape, "bilinear")[0] if product.zodi is not None else None
    wave = (
        _reproject(product.wave_um, product.wcs, wcs_out, shape, "bilinear")[0] if product.wave_um is not None else None
    )
    bw = (
        _reproject(product.bandwidth_um, product.wcs, wcs_out, shape, "bilinear")[0]
        if product.bandwidth_um is not None
        else None
    )
    src_bit = product.flag_bits.get("SOURCE")
    source_flag = ((flags & (1 << src_bit)) != 0) if src_bit is not None else np.zeros(shape, bool)

    coverage = float((fp >= 0.999).mean())
    checks = [
        CheckResult(
            "coverage", coverage > 0.5, f"{coverage:.1%} of region covered by {product.product_id}", coverage, 0.5
        )
    ]
    usable = float((~bad).mean())
    checks.append(
        CheckResult("usable_pixels", usable > 0.3, f"{usable:.1%} of region usable after masking", usable, 0.3, "error")
    )
    return RegisteredProduct(product, wcs_out, image, var, flags, bad, fp, zodi, wave, bw, source_flag, checks)


def phase_correlation_shift(
    a: np.ndarray, b: np.ndarray, valid: np.ndarray, max_shift: int = 5
) -> tuple[float, float, float]:
    """Residual (dy, dx) translation of b relative to a in pixels, and peak contrast.

    Plain (non-whitened) cross-correlation of masked, median-subtracted
    images. The peak is searched only within +/- ``max_shift`` pixels, since
    the archive WCS is assumed to be approximately right; this keeps an
    isolated hot pixel or a single new source from producing a spurious
    distant peak. Sub-pixel precision comes from a parabolic fit.
    """

    def prep(img: np.ndarray) -> np.ndarray:
        return np.where(valid, img - np.median(img[valid]), 0.0)

    a = prep(a)
    b = prep(b)
    win = np.outer(np.hanning(a.shape[0]), np.hanning(a.shape[1]))
    cc = np.fft.fftshift(np.real(np.fft.ifft2(np.fft.fft2(a * win) * np.conj(np.fft.fft2(b * win)))))
    cy, cx = cc.shape[0] // 2, cc.shape[1] // 2
    sub_cc = cc[cy - max_shift : cy + max_shift + 1, cx - max_shift : cx + max_shift + 1]
    jy, jx = np.unravel_index(np.argmax(sub_cc), sub_cc.shape)
    iy, ix = jy + cy - max_shift, jx + cx - max_shift

    def sub(c_m: float, c_0: float, c_p: float) -> float:
        den = c_m - 2 * c_0 + c_p
        return 0.0 if den == 0 else 0.5 * (c_m - c_p) / den

    dy = sub(cc[iy - 1, ix], cc[iy, ix], cc[iy + 1, ix])
    dx = sub(cc[iy, ix - 1], cc[iy, ix], cc[iy, ix + 1])
    contrast = float((cc[iy, ix] - np.median(cc)) / (np.std(cc) + 1e-12))
    # cc peaks at (centre - shift): return the shift of b relative to a
    return -(iy + dy - cy), -(ix + dx - cx), contrast


def registration_check(
    ra: RegisteredProduct, rb: RegisteredProduct, max_shift_pix: float = 0.35
) -> tuple[CheckResult, dict[str, Any]]:
    valid = ~(ra.bad | rb.bad)
    if valid.sum() < 50:
        return CheckResult(
            "registration", False, "too few common valid pixels to verify alignment", int(valid.sum()), 50
        ), {}
    dy, dx, contrast = phase_correlation_shift(ra.image, rb.image, valid)
    shift = float(np.hypot(dx, dy))
    info = {"residual_dx_pix": dx, "residual_dy_pix": dy, "residual_shift_pix": shift, "correlation_contrast": contrast}
    if contrast < 5:
        return CheckResult(
            "registration",
            True,
            f"no distinct correlation peak (contrast {contrast:.1f}); residual shift unmeasured",
            shift,
            max_shift_pix,
            "warning",
        ), info
    ok = shift <= max_shift_pix
    return CheckResult(
        "registration",
        ok,
        f"residual shift after WCS resampling {shift:.2f} px (dx={dx:.2f}, dy={dy:.2f})",
        shift,
        max_shift_pix,
        "error",
    ), info
