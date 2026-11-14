"""Empirical PSFs (EPSF extension) and PSF matching kernels.

SPHEREx DR1/QR3 Level 2 files carry an ``EPSF`` binary table: one oversampled
effective PSF per detector zone (21 x 21 zones of ~97 px), each a 33 x 33
array at OVSMPX x OVSMPY = 5 x 5 oversampling, normalised to unit sum. Zone
centres (XCENTER, YCENTER) are 0-based *active-pixel* coordinates of the full
2040 x 2040 array; IRSA cutouts map their pixels to that frame through the
``A`` WCS keywords (CRPIX1A/CRPIX2A).

``psf_on_grid`` turns the EPSF at a sky position into a kernel sampled on the
common comparison grid, including the local rotation/scale between the
epoch's detector and that grid (epochs are taken at different position
angles), so PSFs of different epochs can be matched in a common frame.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from scipy.ndimage import map_coordinates


@dataclass
class EPSFGrid:
    xc: np.ndarray  # unique zone-centre x (active pixels, 0-based), ascending
    yc: np.ndarray  # unique zone-centre y
    psfs: np.ndarray  # (ny_zones, nx_zones, ny_psf, nx_psf), each normalised to unit sum
    oversampling: tuple[int, int]  # (x, y)
    active_offset: tuple[float, float]  # active0 = array0 + offset (x, y)
    meta: dict[str, Any]

    def at_active(self, xa: float, ya: float) -> np.ndarray:
        """Bilinear interpolation of the PSF between the four nearest zone centres."""

        def bracket(grid: np.ndarray, v: float) -> tuple[int, int, float]:
            if v <= grid[0]:
                return 0, 0, 0.0
            if v >= grid[-1]:
                return len(grid) - 1, len(grid) - 1, 0.0
            j = int(np.searchsorted(grid, v) - 1)
            return j, j + 1, float((v - grid[j]) / (grid[j + 1] - grid[j]))

        i0, i1, ty = bracket(self.yc, ya)
        j0, j1, tx = bracket(self.xc, xa)
        p = (
            (1 - ty) * (1 - tx) * self.psfs[i0, j0]
            + (1 - ty) * tx * self.psfs[i0, j1]
            + ty * (1 - tx) * self.psfs[i1, j0]
            + ty * tx * self.psfs[i1, j1]
        )
        return p / p.sum()

    def at_array(self, x0: float, y0: float) -> np.ndarray:
        return self.at_active(x0 + self.active_offset[0], y0 + self.active_offset[1])


def load_epsf(hdul: fits.HDUList, image_header: fits.Header) -> EPSFGrid | None:
    """Read the EPSF table (DR1/QR3 layout). Returns None if absent or in another layout."""
    if "EPSF" not in [h.name for h in hdul]:
        return None
    hdu = hdul["EPSF"]
    if not isinstance(hdu, fits.BinTableHDU):
        return None
    t = hdu.data
    names = t.columns.names
    if not {"XCENTER", "YCENTER", "EPSF"} <= set(names):
        return None
    xs = np.asarray(t["XCENTER"], float)
    ys = np.asarray(t["YCENTER"], float)
    xc = np.unique(np.round(xs, 3))
    yc = np.unique(np.round(ys, 3))
    stack = np.asarray(t["EPSF"], float)  # (nzones, ny, nx); FITS TDIM is x-fastest -> numpy [y, x]
    cube = np.zeros((len(yc), len(xc)) + stack.shape[1:])
    filled = np.zeros((len(yc), len(xc)), bool)
    for k in range(len(t)):
        i = int(np.argmin(np.abs(yc - ys[k])))
        j = int(np.argmin(np.abs(xc - xs[k])))
        s = stack[k].sum()
        if s > 0 and np.all(np.isfinite(stack[k])):
            cube[i, j] = stack[k] / s
            filled[i, j] = True
    if not filled.all():
        return None
    h = hdu.header
    ov = (int(h.get("OVSMPX", 1)), int(h.get("OVSMPY", 1)))
    # active0 = (array0 + 1) - CRPIXnA  (WCS 'A' is 0-based active pixels with CRVAL=0, CDELT=1)
    off = (1.0 - float(image_header.get("CRPIX1A", 1.0)), 1.0 - float(image_header.get("CRPIX2A", 1.0)))
    meta = {
        "n_zones": int(len(t)),
        "zone_grid": [len(yc), len(xc)],
        "oversampling": list(ov),
        "psf_shape": list(stack.shape[1:]),
        "calibration": " ".join(str(c) for c in h.get("HISTORY", []) if "Calibration source" in str(c)),
    }
    return EPSFGrid(xc, yc, cube, ov, off, meta)


def local_jacobian(wcs_out: WCS, wcs_in: WCS, x_out: float, y_out: float, eps: float = 0.5) -> np.ndarray:
    """d(input pixel)/d(output pixel) at an output-grid position (2 x 2, rows = input x, y)."""

    def to_in(u: float, v: float) -> np.ndarray:
        sky = wcs_out.pixel_to_world_values(u, v)
        return np.array(wcs_in.world_to_pixel_values(*sky), float)

    jx = (to_in(x_out + eps, y_out) - to_in(x_out - eps, y_out)) / (2 * eps)
    jy = (to_in(x_out, y_out + eps) - to_in(x_out, y_out - eps)) / (2 * eps)
    return np.column_stack([jx, jy])


def psf_on_grid(
    epsf: EPSFGrid,
    wcs_in: WCS,
    wcs_out: WCS,
    ra: float,
    dec: float,
    half: int = 4,
    shape_out: tuple[int, int] | None = None,
) -> tuple[np.ndarray, dict[str, Any]]:
    """EPSF at (ra, dec) resampled onto the output grid as a (2*half+1)^2 unit-sum kernel.

    Each kernel pixel (u, v) on the output grid maps to a detector offset
    J @ (u, v); the oversampled ePSF (already pixel-integrated) is sampled
    there with cubic interpolation.
    """
    x_in, y_in = (float(v) for v in wcs_in.world_to_pixel_values(ra, dec))
    x_out, y_out = (float(v) for v in wcs_out.world_to_pixel_values(ra, dec))
    jac = local_jacobian(wcs_out, wcs_in, x_out, y_out)
    p = epsf.at_array(x_in, y_in)
    ovx, ovy = epsf.oversampling
    cy, cx = (p.shape[0] - 1) / 2.0, (p.shape[1] - 1) / 2.0
    vv, uu = np.mgrid[-half : half + 1, -half : half + 1].astype(float)
    dx = jac[0, 0] * uu + jac[0, 1] * vv
    dy = jac[1, 0] * uu + jac[1, 1] * vv
    k = map_coordinates(p, [cy + dy * ovy, cx + dx * ovx], order=3, mode="constant", cval=0.0)
    k = np.clip(k, 0.0, None) * ovx * ovy  # oversampled unit-sum ePSF -> per-native-pixel fraction
    captured = float(k.sum())
    k = k / k.sum()
    # Bilinear resampling onto the grid blurs an epoch by an amount that depends on the
    # sub-pixel phases of the output pixels in the input frame: interpolating at phase t adds
    # variance t(1-t) along that input axis. A grid-aligned epoch is not blurred, a rotated or
    # shifted one is (<= 0.25 px^2), so the blur does not cancel between epochs and is modelled.
    v_interp = interpolation_variance(wcs_in, wcs_out, shape_out) if shape_out else (0.0, 0.0)
    k = _blur3(k, *v_interp)
    xa, ya = x_in + epsf.active_offset[0], y_in + epsf.active_offset[1]
    info = {
        "detector_position_active": [xa, ya],
        "jacobian": jac.tolist(),
        "rotation_deg": float(np.degrees(np.arctan2(jac[1, 0], jac[0, 0]))),
        "captured_fraction": captured,
        "interpolation_variance_pix2": list(v_interp),
        "fwhm_moment_arcsec": moment_fwhm(k) * float(abs(wcs_out.wcs.cdelt[0]) * 3600.0),
    }
    return k, info


def interpolation_variance(wcs_in: WCS, wcs_out: WCS, shape_out: tuple[int, int]) -> tuple[float, float]:
    """Mean bilinear-interpolation variance t(1-t) per input axis over the output grid."""
    ny, nx = shape_out
    yy, xx = np.mgrid[0:ny, 0:nx].astype(float)
    sky = wcs_out.pixel_to_world_values(xx.ravel(), yy.ravel())
    xi, yi = (np.asarray(v, float) for v in wcs_in.world_to_pixel_values(*sky))
    good = np.isfinite(xi) & np.isfinite(yi)
    tx = xi[good] - np.floor(xi[good])
    ty = yi[good] - np.floor(yi[good])
    return float(np.mean(tx * (1 - tx))), float(np.mean(ty * (1 - ty)))


def _blur3(k: np.ndarray, vx: float, vy: float) -> np.ndarray:
    """Separable 3-tap blur [a, 1-2a, a] with variance 2a = v along each axis (v <= 0.25)."""
    from scipy.ndimage import convolve1d

    out = k
    for axis, v in ((1, vx), (0, vy)):
        a = min(max(v, 0.0), 0.25) / 2.0
        if a > 0:
            out = convolve1d(out, np.array([a, 1 - 2 * a, a]), axis=axis, mode="constant")
    return out / out.sum()


def moment_fwhm(k: np.ndarray) -> float:
    """Gaussian-equivalent FWHM (pixels) from the kernel's second moments."""
    yy, xx = np.mgrid[0 : k.shape[0], 0 : k.shape[1]].astype(float)
    s = k.sum()
    mx, my = (k * xx).sum() / s, (k * yy).sum() / s
    vx = (k * (xx - mx) ** 2).sum() / s
    vy = (k * (yy - my) ** 2).sum() / s
    return float(2.3548 * np.sqrt(0.5 * (vx + vy)))


def convolve_full(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Full linear convolution of two small kernels (for the effective matched PSF)."""
    from scipy.signal import fftconvolve

    out = np.clip(fftconvolve(a, b, mode="full"), 0.0, None)
    return out / out.sum()
