"""Candidate detection and measurement on a significance (D / sigma_D) map.

Positive and negative changes are segmented separately with photutils.
Each segment is measured on the difference image (flux, centroid, peak
significance) and on both epochs with a matched circular aperture, so every
reported number traces back to pixels in the stored products.

Flux conversion: images are surface brightness in MJy/sr; summing over
pixels and multiplying by the pixel solid angle gives flux density in MJy,
reported here in microjansky (1 MJy = 1e12 uJy). Uncertainties assume the
rescaled per-pixel sigma and ignore residual pixel-to-pixel covariance, so
they are approximate (see docs/SCIENTIFIC_METHODOLOGY.md).
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from photutils.aperture import CircularAnnulus, CircularAperture, aperture_photometry
from photutils.segmentation import SourceCatalog, detect_sources
from photutils.utils.exceptions import NoDetectionsWarning

from stm.science.difference import DifferenceResult
from stm.science.registration import RegisteredProduct


@dataclass
class DetectionConfig:
    threshold_sigma: float = 5.0
    min_pixels: int = 2
    aperture_fwhm_mult: float = 1.5
    astrometric_floor_arcsec: float = 1.0  # added in quadrature to statistical centroid error

    def to_dict(self) -> dict[str, Any]:
        return dict(self.__dict__)


@dataclass
class Detection:
    sign: int  # +1 brightened (B > A), -1 faded
    x: float
    y: float
    ra: float
    dec: float
    npix: int
    peak_significance: float
    diff_flux_ujy: float
    diff_flux_err_ujy: float
    flux_a_ujy: float
    flux_a_err_ujy: float
    flux_b_ujy: float
    flux_b_err_ujy: float
    pos_err_arcsec: float
    wave_a_um: float | None
    wave_b_um: float | None
    bandwidth_um: float | None
    known_source_flag: bool  # archive SOURCE flag set at this position in A or B
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def snr(self) -> float:
        return abs(self.diff_flux_ujy) / self.diff_flux_err_ujy if self.diff_flux_err_ujy > 0 else 0.0

    @property
    def snr_a(self) -> float:
        return self.flux_a_ujy / self.flux_a_err_ujy if self.flux_a_err_ujy > 0 else 0.0

    @property
    def snr_b(self) -> float:
        return self.flux_b_ujy / self.flux_b_err_ujy if self.flux_b_err_ujy > 0 else 0.0

    def measurements(self) -> dict[str, Any]:
        return {
            "sign": self.sign,
            "x_pix": self.x,
            "y_pix": self.y,
            "npix": self.npix,
            "peak_significance": self.peak_significance,
            "diff_flux_ujy": self.diff_flux_ujy,
            "diff_flux_err_ujy": self.diff_flux_err_ujy,
            "diff_snr": self.snr,
            "flux_a_ujy": self.flux_a_ujy,
            "flux_a_err_ujy": self.flux_a_err_ujy,
            "snr_a": self.snr_a,
            "flux_b_ujy": self.flux_b_ujy,
            "flux_b_err_ujy": self.flux_b_err_ujy,
            "snr_b": self.snr_b,
            "pos_err_arcsec": self.pos_err_arcsec,
            "wave_a_um": self.wave_a_um,
            "wave_b_um": self.wave_b_um,
            "bandwidth_um": self.bandwidth_um,
            "known_source_flag": self.known_source_flag,
            **self.extra,
        }


def pixel_solid_angle_sr(pixscale_arcsec: float) -> float:
    return float((pixscale_arcsec / 206264.80624709636) ** 2)


def detect(
    res: DifferenceResult, ra_reg: RegisteredProduct, rb_reg: RegisteredProduct, cfg: DetectionConfig | None = None
) -> list[Detection]:
    cfg = cfg or DetectionConfig()
    wcs = ra_reg.wcs
    pix = float(abs(wcs.wcs.cdelt[0]) * 3600.0)
    omega = pixel_solid_angle_sr(pix)
    to_ujy = omega * 1e12
    fwhm_arcsec = max(ra_reg.source.psf_fwhm_arcsec or 2 * pix, rb_reg.source.psf_fwhm_arcsec or 2 * pix)
    r_ap = max(1.0, cfg.aperture_fwhm_mult * fwhm_arcsec / pix)

    sig = np.where(res.valid, res.significance, 0.0)
    out: list[Detection] = []
    for sign in (+1, -1):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", NoDetectionsWarning)
            seg = detect_sources(sign * sig, cfg.threshold_sigma, n_pixels=cfg.min_pixels, mask=~res.valid)
        if seg is None:
            continue
        cat = SourceCatalog(
            np.where(res.valid, sign * res.diff, 0.0), seg, error=np.where(res.valid, res.sigma, 0.0), mask=~res.valid
        )
        for src in cat:
            x, y = float(src.x_centroid), float(src.y_centroid)
            if not (np.isfinite(x) and np.isfinite(y)):
                continue
            label_mask = seg.data == src.label
            peak = float(np.nanmax(sign * sig[label_mask]))
            ap = CircularAperture([(x, y)], r=r_ap)
            ann = CircularAnnulus([(x, y)], r_in=r_ap + 2, r_out=r_ap + 6).to_mask(method="center")[0]

            def phot(img: np.ndarray, var: np.ndarray, local_bkg: bool, ap=ap, ann=ann) -> tuple[float, float]:
                good = np.isfinite(img) & np.isfinite(var)
                bkg = 0.0
                if local_bkg:
                    vals = ann.get_values(np.where(good, img, np.nan))
                    vals = vals[np.isfinite(vals)]
                    bkg = float(np.median(vals)) if vals.size >= 5 else 0.0
                t = aperture_photometry(
                    np.where(good, img - bkg, 0.0), ap, error=np.sqrt(np.where(good, var, 0.0)), mask=~good
                )
                return float(t["aperture_sum"][0]) * to_ujy, float(t["aperture_sum_err"][0]) * to_ujy

            # Difference image is already background-subtracted (plane fit);
            # epoch images get a local annulus median removed.
            dflux, dferr = phot(res.diff, res.sigma**2, local_bkg=False)
            fa, fae = phot(res.a, res.var_a, local_bkg=True)
            fb, fbe = phot(res.b, res.var_b, local_bkg=True)
            snr = abs(dflux) / dferr if dferr > 0 else 0.0
            pos_err = float(np.hypot(fwhm_arcsec / (2.3548 * max(snr, 1e-3)), cfg.astrometric_floor_arcsec))
            sky = wcs.pixel_to_world_values(x, y)
            iy, ix = int(round(y)), int(round(x))
            iy = min(max(iy, 0), sig.shape[0] - 1)
            ix = min(max(ix, 0), sig.shape[1] - 1)

            def at(arr: np.ndarray | None, iy: int = iy, ix: int = ix) -> float | None:
                if arr is None:
                    return None
                v = arr[iy, ix]
                return float(v) if np.isfinite(v) else None

            bw = None
            if ra_reg.bandwidth_um is not None and rb_reg.bandwidth_um is not None:
                bw = 0.5 * ((at(ra_reg.bandwidth_um) or 0) + (at(rb_reg.bandwidth_um) or 0)) or None
            out.append(
                Detection(
                    sign=sign,
                    x=x,
                    y=y,
                    ra=float(sky[0]) % 360.0,
                    dec=float(sky[1]),
                    npix=int(src.area.value),
                    peak_significance=sign * peak,
                    diff_flux_ujy=dflux,
                    diff_flux_err_ujy=dferr,
                    flux_a_ujy=fa,
                    flux_a_err_ujy=fae,
                    flux_b_ujy=fb,
                    flux_b_err_ujy=fbe,
                    pos_err_arcsec=pos_err,
                    wave_a_um=at(ra_reg.wave_um),
                    wave_b_um=at(rb_reg.wave_um),
                    bandwidth_um=bw,
                    known_source_flag=bool(ra_reg.source_flag[iy, ix] or rb_reg.source_flag[iy, ix]),
                    extra={"aperture_radius_pix": r_ap, "fwhm_arcsec": fwhm_arcsec},
                )
            )
    return out
