"""SYNTHETIC test data generator.

Everything produced here is artificial and exists only to test algorithms
with known ground truth. Files carry ``SYNTHET = T`` and product ids start
with ``SYNTHETIC-``; they are never presented as NASA observations.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

from stm.science.fitsio import SPHEREX_DEFAULT_FLAGS

PIX_ARCSEC = 6.15
FWHM_ARCSEC = 7.5


@dataclass
class Src:
    ra: float
    dec: float
    flux_mjy_sr_peak: float  # peak surface brightness of the PSF (MJy/sr)


def make_wcs(ra: float, dec: float, n: int, rot_deg: float = 0.0, offset_pix: tuple[float, float] = (0.0, 0.0)) -> WCS:
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2 + offset_pix[0], (n + 1) / 2 + offset_pix[1]]
    s = PIX_ARCSEC / 3600.0
    th = np.radians(rot_deg)
    w.wcs.cd = np.array([[-s * np.cos(th), s * np.sin(th)], [s * np.sin(th), s * np.cos(th)]])
    w.wcs.radesys = "ICRS"
    return w


def render(wcs: WCS, n: int, sources: list[Src], fwhm_arcsec: float = FWHM_ARCSEC) -> np.ndarray:
    yy, xx = np.mgrid[0:n, 0:n].astype(float)
    img = np.zeros((n, n))
    sig = fwhm_arcsec / 2.3548 / PIX_ARCSEC
    for s in sources:
        x, y = wcs.world_to_pixel_values(s.ra, s.dec)
        img += s.flux_mjy_sr_peak * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * sig**2))
    return img


def gauss2d(dx: np.ndarray, dy: np.ndarray, sx: float, sy: float, theta_deg: float) -> np.ndarray:
    """Elliptical Gaussian (detector-pixel offsets), peak 1."""
    t = np.radians(theta_deg)
    u = dx * np.cos(t) + dy * np.sin(t)
    v = -dx * np.sin(t) + dy * np.cos(t)
    return np.exp(-0.5 * ((u / sx) ** 2 + (v / sy) ** 2))


def epsf_table(n: int, sx: float, sy: float, theta_deg: float, ov: int = 5, size: int = 33) -> fits.BinTableHDU:
    """SYNTHETIC EPSF table in the DR1 layout: 3x3 identical zones, oversampled, unit sum."""
    c = (size - 1) / 2
    yy, xx = np.mgrid[0:size, 0:size].astype(float)
    p = gauss2d((xx - c) / ov, (yy - c) / ov, sx, sy, theta_deg)
    p /= p.sum()
    centres = [n / 6, n / 2, 5 * n / 6]
    rows = [(i, j, centres[i], centres[j]) for j in range(3) for i in range(3)]  # x-fast then y
    cols = [
        fits.Column("BINX", "J", array=[r[0] for r in rows]),
        fits.Column("BINY", "J", array=[r[1] for r in rows]),
        fits.Column("XCENTER", "E", array=[r[2] for r in rows]),
        fits.Column("YCENTER", "E", array=[r[3] for r in rows]),
        fits.Column("EPSF", f"{size * size}D", dim=f"({size},{size})", array=np.repeat(p[None], len(rows), axis=0)),
    ]
    t = fits.BinTableHDU.from_columns(cols, name="EPSF")
    t.header["OVSMPX"] = ov
    t.header["OVSMPY"] = ov
    t.header["SYNTHET"] = (True, "SYNTHETIC test PSF")
    return t


def write_mef(
    path: Path,
    *,
    ra: float,
    dec: float,
    n: int = 81,
    sources: list[Src],
    t_mjd: float,
    seed: int,
    noise: float = 0.05,
    background: float = 0.3,
    zodi: float = 0.2,
    detector: int = 1,
    wave_offset_um: float = 0.0,
    offset_pix: tuple[float, float] = (0.0, 0.0),
    rot_deg: float = 0.0,
    bad_pixels: list[tuple[int, int, str]] | None = None,
    fwhm_arcsec: float = FWHM_ARCSEC,
    product_id: str | None = None,
    epsf: tuple[float, float, float] | None = None,
) -> Path:
    """Write a SYNTHETIC multi-extension FITS file with the SPHEREx L2 layout."""
    rng = np.random.default_rng(seed)
    w = make_wcs(ra, dec, n, rot_deg, offset_pix)
    if epsf is None:
        sky = render(w, n, sources, fwhm_arcsec)
    else:
        # Stars rendered with the same elliptical detector-frame PSF that goes into the EPSF table.
        sx, sy, th = epsf
        fwhm_arcsec = 2.3548 * float(np.sqrt(0.5 * (sx**2 + sy**2))) * PIX_ARCSEC
        yy, xx = np.mgrid[0:n, 0:n].astype(float)
        sky = np.zeros((n, n))
        for src in sources:
            x, y = w.world_to_pixel_values(src.ra, src.dec)
            sky += src.flux_mjy_sr_peak * gauss2d(xx - x, yy - y, sx, sy, th)
    sky = sky + background + zodi
    img = sky + rng.normal(0, noise, (n, n))
    var = np.full((n, n), noise**2)
    flags = np.zeros((n, n), dtype=np.int32)
    for x, y, name in bad_pixels or []:
        flags[y, x] |= 1 << SPHEREX_DEFAULT_FLAGS[name]
        img[y, x] += 50.0  # what a hot / bad pixel might look like
    hdr = w.to_header()
    pid = product_id or f"SYNTHETIC-{seed}"
    hdr.update(
        {
            "EXTNAME": "IMAGE",
            "BUNIT": "MJy / sr",
            "DETECTOR": detector,
            "OBSID": pid[:-2] if pid.endswith(f"D{detector}") else pid,
            "MJD-AVG": t_mjd,
            "MJD-OBS": t_mjd,
            "DATE-AVG": "synthetic",
            "XPOSURE": 112.0,
            "PSF_FWHM": fwhm_arcsec,
            "L1DQAFLG": "Pass",
            "SYNTHET": (True, "SYNTHETIC test data, not an observation"),
            "CRPIX1W": 1.0,
            "CRPIX2W": 1.0,
            "CRVAL1W": 1.0,
            "CRVAL2W": 1.0,
            "CDELT1W": 1.0,
            "CDELT2W": 1.0,
            "CRPIX1A": 1.0,
            "CRPIX2A": 1.0,
        }
    )
    fh = fits.Header()
    fh["EXTNAME"] = "FLAGS"
    for name, bit in SPHEREX_DEFAULT_FLAGS.items():
        fh[f"MSKN{bit:04d}"] = name
        fh[f"MSKM{bit:04d}"] = 1 << bit
    # Wavelength lookup: linear gradient along y, 9x9 grid over raw coordinates 1..n
    grid = np.linspace(1, n, 9)
    gy, gx = np.meshgrid(grid, grid, indexing="ij")
    wave = 0.90 + wave_offset_um + 1.8e-4 * (gy - 1)
    bw = wave / 40.0
    values = np.stack([wave, bw], axis=-1).astype(np.float32)[None]
    cols = [
        fits.Column("X", "9J", array=grid.astype(np.int32)[None], dim="(9)"),
        fits.Column("Y", "9J", array=grid.astype(np.int32)[None], dim="(9)"),
        fits.Column("VALUES", "162E", array=values, dim="(2,9,9)"),
    ]
    tab = fits.BinTableHDU.from_columns(cols, name="WCS-WAVE")
    zh = w.to_header()
    zh["EXTNAME"] = "ZODI"
    prim = fits.PrimaryHDU()
    prim.header["SYNTHET"] = (True, "SYNTHETIC test data, not an observation")
    hdul = fits.HDUList(
        [
            prim,
            fits.ImageHDU(img.astype(np.float32), hdr, name="IMAGE"),
            fits.ImageHDU(flags, fh, name="FLAGS"),
            fits.ImageHDU(var.astype(np.float32), w.to_header(), name="VARIANCE"),
            fits.ImageHDU(np.full((n, n), zodi, np.float32), zh, name="ZODI"),
            tab,
        ]
        + ([epsf_table(n, *epsf)] if epsf is not None else [])
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    hdul.writeto(path, overwrite=True)
    return path
