"""FITS reading, validation and per-pixel wavelength for SPHEREx Level 2 products.

SPHEREx images are taken through linear variable filters: the central
wavelength changes across the detector (mostly along the y axis), so every
pixel of a spectral image has its own wavelength. Any comparison between two
epochs must therefore check that the *same sky pixel* was observed at the
*same wavelength* in both. This module exposes the per-pixel wavelength map
built from the product's own WCS-WAVE lookup table.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from astropy.io import fits
from astropy.time import Time
from astropy.utils.exceptions import AstropyWarning
from astropy.wcs import WCS, FITSFixedWarning
from astropy.wcs.utils import proj_plane_pixel_scales
from scipy.interpolate import RegularGridInterpolator

# Fallback flag definitions, copied from the MSKN/MSKM keywords of a DR1
# FLAGS extension. Real products carry their own definitions, which take
# precedence (see parse_flag_definitions).
SPHEREX_DEFAULT_FLAGS: dict[str, int] = {
    "TRANSIENT": 0,
    "OVERFLOW": 1,
    "SUR_ERROR": 2,
    "NONFUNC": 6,
    "DICHROIC": 7,
    "MISSING_DATA": 9,
    "HOT": 10,
    "COLD": 11,
    "FULLSAMPLE": 12,
    "PHANMISS": 14,
    "NONLINEAR": 15,
    "PERSIST": 17,
    "OUTLIER": 19,
    "CROSSTALK": 20,
    "SOURCE": 21,
    "GHOST": 22,
    "GHOST_FPA": 23,
    "GHOST_EXT": 24,
    "STREAK": 25,
    "BLOOM": 26,
    "SNOWBALL": 27,
    "HALO": 28,
}

# Flags that make a pixel unusable for differencing ("hard" mask). These
# mark detector/readout failures or features that can mimic a change between
# epochs (persistence, ghosts, halos, streaks, snowballs).
DEFAULT_BAD_FLAGS: tuple[str, ...] = (
    "TRANSIENT",
    "OVERFLOW",
    "SUR_ERROR",
    "NONFUNC",
    "MISSING_DATA",
    "HOT",
    "COLD",
    "NONLINEAR",
    "PERSIST",
    "OUTLIER",
    "GHOST",
    "GHOST_FPA",
    "GHOST_EXT",
    "STREAK",
    "BLOOM",
    "SNOWBALL",
    "HALO",
)
# Flags reported per candidate but not masked ("soft"). CROSSTALK covers most
# pixels around bright extended sources (e.g. >60 % of a 0.15 deg M31 cutout),
# so masking it would remove whole galaxies; candidates touching it are
# down-ranked by the quality_flags_nearby check instead.
SOFT_FLAGS: tuple[str, ...] = ("CROSSTALK", "DICHROIC", "PHANMISS")
# Informational only: SOURCE (pixel maps to a known catalogue source), FULLSAMPLE.

PROVENANCE_KEYS = (
    "OBSID",
    "DETECTOR",
    "EXPIDN",
    "DATE-OBS",
    "DATE-AVG",
    "MJD-AVG",
    "MJD-BEG",
    "MJD-END",
    "XPOSURE",
    "BUNIT",
    "PSF_FWHM",
    "FINAST",
    "ASTRONETSOLVED",
    "MATCH_NSTARS",
    "L1DQAFLG",
    "SPS_TARGET",
    "SPS_FLAGS",
    "PXSRCMSK",
    "OMEGA_MEDIAN",
    "RADESYS",
)


@dataclass
class CheckResult:
    name: str
    passed: bool
    detail: str
    value: Any = None
    threshold: Any = None
    severity: str = "error"  # error | warning | info

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "passed": bool(self.passed),
            "detail": self.detail,
            "value": _jsonable(self.value),
            "threshold": _jsonable(self.threshold),
            "severity": self.severity,
        }


@dataclass
class ImageProduct:
    """A calibrated image with its per-pixel uncertainty, quality and wavelength."""

    product_id: str
    survey: str
    image: np.ndarray  # surface brightness, BUNIT
    variance: np.ndarray  # BUNIT^2
    flags: np.ndarray  # integer bitmask
    wcs: WCS  # celestial WCS (2-D)
    t_mid_mjd: float
    exptime_s: float | None
    unit: str
    detector: int | None = None
    zodi: np.ndarray | None = None
    wave_um: np.ndarray | None = None  # per-pixel central wavelength
    bandwidth_um: np.ndarray | None = None
    psf_fwhm_arcsec: float | None = None
    flag_bits: dict[str, int] = field(default_factory=lambda: dict(SPHEREX_DEFAULT_FLAGS))
    header_meta: dict[str, Any] = field(default_factory=dict)
    synthetic: bool = False
    checks: list[CheckResult] = field(default_factory=list)

    @property
    def shape(self) -> tuple[int, int]:
        return self.image.shape  # type: ignore[return-value]

    @property
    def pixel_scale_arcsec(self) -> float:
        return float(np.mean(proj_plane_pixel_scales(self.wcs)) * 3600.0)

    def bad_mask(self, bad_flags: tuple[str, ...] = DEFAULT_BAD_FLAGS) -> np.ndarray:
        bits = 0
        for name in bad_flags:
            if name in self.flag_bits:
                bits |= 1 << self.flag_bits[name]
        bad = (self.flags.astype(np.int64) & bits) != 0
        bad |= ~np.isfinite(self.image) | ~np.isfinite(self.variance) | (self.variance <= 0)
        return bad

    def flag_mask(self, name: str) -> np.ndarray:
        if name not in self.flag_bits:
            return np.zeros(self.shape, bool)
        return (self.flags.astype(np.int64) & (1 << self.flag_bits[name])) != 0

    @property
    def date_iso(self) -> str:
        return Time(self.t_mid_mjd, format="mjd", scale="utc").isot


def parse_flag_definitions(header: fits.Header) -> dict[str, int]:
    """Read MSKNnnnn / MSKMnnnn keywords (flag name -> bit index)."""
    out: dict[str, int] = {}
    for key in header:
        if key.startswith("MSKN") and key[4:].isdigit():
            n = int(key[4:])
            mask = header.get(f"MSKM{key[4:]}")
            if mask is not None and int(mask) != (1 << n):
                continue  # inconsistent definition; ignore
            out[str(header[key]).strip()] = n
    return out


def wavelength_lookup_from_table(table: Any) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    x = np.asarray(table["X"][0], dtype=float)
    y = np.asarray(table["Y"][0], dtype=float)
    values = np.asarray(table["VALUES"][0], dtype=float)  # (ny, nx, 2) = [iy][ix][wave, bandwidth]
    return x, y, values


def wavelength_at_raw(
    x_grid: np.ndarray, y_grid: np.ndarray, values: np.ndarray, xr: np.ndarray, yr: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Bilinear interpolation of the lookup at raw 1-based detector coordinates."""
    xr = np.clip(xr, x_grid[0], x_grid[-1])
    yr = np.clip(yr, y_grid[0], y_grid[-1])
    pts = np.stack([np.ravel(yr), np.ravel(xr)], axis=-1)
    wave = RegularGridInterpolator((y_grid, x_grid), values[..., 0])(pts).reshape(np.shape(xr))
    bw = RegularGridInterpolator((y_grid, x_grid), values[..., 1])(pts).reshape(np.shape(xr))
    return wave, bw


def raw_coords(header: fits.Header, x0: np.ndarray, y0: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """0-based array pixel -> raw 1-based lookup coordinates using the 'W' WCS keywords."""
    xr = (x0 + 1 - float(header.get("CRPIX1W", 1))) * float(header.get("CDELT1W", 1)) + float(header.get("CRVAL1W", 1))
    yr = (y0 + 1 - float(header.get("CRPIX2W", 1))) * float(header.get("CDELT2W", 1)) + float(header.get("CRVAL2W", 1))
    return xr, yr


def celestial_wcs(header: fits.Header) -> WCS:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        warnings.simplefilter("ignore", AstropyWarning)
        return WCS(header, naxis=2, relax=True).celestial


def validate_wcs(wcs: WCS, shape: tuple[int, int], expected_scale_arcsec: float | None = None) -> list[CheckResult]:
    checks: list[CheckResult] = []
    ok = wcs.has_celestial
    checks.append(CheckResult("wcs_celestial", ok, "WCS defines celestial axes" if ok else "No celestial WCS"))
    if not ok:
        return checks
    try:
        ny, nx = shape
        sky = wcs.pixel_to_world_values(np.array([0, nx - 1, nx / 2]), np.array([0, ny - 1, ny / 2]))
        back = wcs.world_to_pixel_values(*sky)
        err = float(np.max(np.hypot(back[0] - np.array([0, nx - 1, nx / 2]), back[1] - np.array([0, ny - 1, ny / 2]))))
        finite = bool(np.all(np.isfinite(sky)))
        checks.append(
            CheckResult(
                "wcs_roundtrip", finite and err < 0.01, f"pixel->sky->pixel round trip error {err:.2e} px", err, 0.01
            )
        )
    except Exception as e:  # pragma: no cover - defensive
        checks.append(CheckResult("wcs_roundtrip", False, f"WCS transform failed: {e}"))
    scale = float(np.mean(proj_plane_pixel_scales(wcs)) * 3600.0)
    if expected_scale_arcsec:
        ok_scale = abs(scale / expected_scale_arcsec - 1) < 0.1
        checks.append(
            CheckResult(
                "pixel_scale", ok_scale, f"pixel scale {scale:.3f} arcsec", scale, expected_scale_arcsec, "warning"
            )
        )
    return checks


def load_spherex_l2(path: str | Path, product_id: str | None = None) -> ImageProduct:
    """Load a SPHEREx Level 2 spectral image MEF (full frame or IRSA cutout)."""
    with fits.open(path, memmap=False) as hdul:
        names = [h.name for h in hdul]
        for required in ("IMAGE", "FLAGS", "VARIANCE"):
            if required not in names:
                raise ValueError(f"{path}: missing {required} extension (found {names})")
        ih = hdul["IMAGE"].header
        image = np.asarray(hdul["IMAGE"].data, dtype=np.float64)
        flags = np.asarray(hdul["FLAGS"].data).astype(np.int64)
        variance = np.asarray(hdul["VARIANCE"].data, dtype=np.float64)
        zodi = np.asarray(hdul["ZODI"].data, dtype=np.float64) if "ZODI" in names else None
        flag_bits = parse_flag_definitions(hdul["FLAGS"].header) or dict(SPHEREX_DEFAULT_FLAGS)
        wcs = celestial_wcs(ih)

        checks: list[CheckResult] = []
        shapes = {
            n: hdul[n].data.shape for n in ("IMAGE", "FLAGS", "VARIANCE") + (("ZODI",) if zodi is not None else ())
        }
        same = len(set(shapes.values())) == 1
        checks.append(CheckResult("extension_shapes", same, f"extension shapes {shapes}"))
        unit = str(ih.get("BUNIT", "")).strip()
        checks.append(CheckResult("unit", unit.replace(" ", "") == "MJy/sr", f"BUNIT = {unit!r}", unit, "MJy / sr"))
        finite_frac = float(np.isfinite(image).mean())
        checks.append(
            CheckResult("finite_pixels", finite_frac > 0.5, f"{finite_frac:.1%} finite pixels", finite_frac, 0.5)
        )
        neg_var = int(np.sum(variance < 0))
        checks.append(
            CheckResult("variance_nonnegative", neg_var == 0, f"{neg_var} negative variance pixels", neg_var, 0)
        )
        has_time = "MJD-AVG" in ih or "MJD-OBS" in ih
        checks.append(CheckResult("time_keywords", has_time, "MJD-AVG present" if has_time else "no MJD keywords"))
        checks += validate_wcs(wcs, image.shape, expected_scale_arcsec=6.15)
        l1 = str(ih.get("L1DQAFLG", "")).strip()
        if l1:
            checks.append(
                CheckResult(
                    "l1_dqa", l1.lower() == "pass", f"Level 1 data-quality assessment: {l1}", l1, "Pass", "warning"
                )
            )

        wave = bw = None
        if "WCS-WAVE" in names:
            xg, yg, vals = wavelength_lookup_from_table(hdul["WCS-WAVE"].data)
            yy, xx = np.mgrid[0 : image.shape[0], 0 : image.shape[1]].astype(float)
            xr, yr = raw_coords(ih, xx, yy)
            wave, bw = wavelength_at_raw(xg, yg, vals, xr, yr)
            checks.append(
                CheckResult(
                    "wavelength_map",
                    True,
                    f"per-pixel wavelength {np.nanmin(wave):.4f}-{np.nanmax(wave):.4f} um",
                    None,
                    None,
                    "info",
                )
            )
        else:
            checks.append(CheckResult("wavelength_map", False, "no WCS-WAVE extension", None, None, "warning"))

        t_mid = float(ih.get("MJD-AVG", ih.get("MJD-OBS", np.nan)))
        meta = {k: _jsonable(ih.get(k)) for k in PROVENANCE_KEYS if k in ih}
        meta["software_version"] = str(hdul[0].header.get("VERSION", ""))
        if "WCS-WAVE" in names:
            meta["spectral_wcs_calibration"] = " ".join(
                str(c) for c in hdul["WCS-WAVE"].header.get("HISTORY", []) if "Calibration source" in str(c)
            )
        det = ih.get("DETECTOR")
        return ImageProduct(
            product_id=product_id or str(ih.get("OBSID", Path(path).stem)) + (f"D{det}" if det else ""),
            survey="SPHEREx",
            image=image,
            variance=variance,
            flags=flags,
            wcs=wcs,
            t_mid_mjd=t_mid,
            exptime_s=_float_or_none(ih.get("XPOSURE")),
            unit=unit,
            detector=int(det) if det is not None else None,
            zodi=zodi,
            wave_um=wave,
            bandwidth_um=bw,
            psf_fwhm_arcsec=_float_or_none(ih.get("PSF_FWHM")),
            flag_bits=flag_bits,
            header_meta=meta,
            checks=checks,
            synthetic=bool(ih.get("SYNTHET", False) or hdul[0].header.get("SYNTHET", False)),
        )


def wavelength_at_sky(header: fits.Header, lut: dict[str, Any], ra: float, dec: float) -> dict[str, Any]:
    """Estimate the central wavelength observed at (ra, dec) from a full-frame header + detector lookup."""
    wcs = celestial_wcs(header)
    x, y = wcs.world_to_pixel_values(ra, dec)
    nx = int(header.get("NAXIS1", 2040))
    ny = int(header.get("NAXIS2", 2040))
    inside = bool(0 <= x < nx and 0 <= y < ny)
    xr, yr = raw_coords(header, np.asarray(x, float), np.asarray(y, float))
    wave, bw = wavelength_at_raw(np.asarray(lut["x"]), np.asarray(lut["y"]), np.asarray(lut["values"]), xr, yr)
    return {
        "x_pix": float(x),
        "y_pix": float(y),
        "in_footprint": inside,
        "wave_um": float(wave),
        "bandwidth_um": float(bw),
        "edge_distance_pix": float(min(x, y, nx - 1 - x, ny - 1 - y)),
    }


def _float_or_none(v: Any) -> float | None:
    try:
        f = float(v)
        return f if np.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def _jsonable(v: Any) -> Any:
    if isinstance(v, (np.floating,)):
        return float(v)
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, np.bool_):
        return bool(v)
    if isinstance(v, fits.card.Undefined):
        return None
    return v
