"""Forced aperture photometry at a fixed sky position across epochs.

Used for "how did the brightness change" questions. Because SPHEREx samples
a different wavelength at every detector position, epochs are only directly
comparable when their wavelength at the target agrees within a fraction of
the bandwidth; each measurement therefore carries its wavelength.
"""

from __future__ import annotations

from typing import Any

import numpy as np
from photutils.aperture import CircularAnnulus, CircularAperture, aperture_photometry

from stm.science.detection import pixel_solid_angle_sr
from stm.science.fitsio import ImageProduct


def forced_photometry(p: ImageProduct, ra: float, dec: float, r_fwhm: float = 1.5) -> dict[str, Any]:
    x, y = p.wcs.world_to_pixel_values(ra, dec)
    x, y = float(x), float(y)
    ny, nx = p.shape
    if not (0 <= x < nx and 0 <= y < ny):
        return {"product_id": p.product_id, "in_image": False}
    pix = p.pixel_scale_arcsec
    fwhm = p.psf_fwhm_arcsec or 2 * pix
    r = max(1.0, r_fwhm * fwhm / pix)
    img = p.image - (p.zodi if p.zodi is not None else 0.0)
    bad = p.bad_mask()
    ap = CircularAperture([(x, y)], r=r)
    an = CircularAnnulus([(x, y)], r_in=r + 2, r_out=r + 6)
    an_mask = an.to_mask(method="center")[0]
    an_vals = an_mask.get_values(np.where(bad, np.nan, img))
    an_vals = an_vals[np.isfinite(an_vals)]
    bkg = float(np.median(an_vals)) if an_vals.size >= 5 else 0.0
    t = aperture_photometry(np.where(bad, 0.0, img - bkg), ap, error=np.sqrt(np.where(bad, 0.0, p.variance)), mask=bad)
    to_ujy = pixel_solid_angle_sr(pix) * 1e12
    ap_mask = ap.to_mask(method="center")[0]
    bad_in = ap_mask.get_values(bad.astype(float))
    iy, ix = int(round(y)), int(round(x))
    return {
        "product_id": p.product_id,
        "in_image": True,
        "t_mid_mjd": p.t_mid_mjd,
        "date_iso": p.date_iso,
        "flux_ujy": float(t["aperture_sum"][0]) * to_ujy,
        "flux_err_ujy": float(t["aperture_sum_err"][0]) * to_ujy,
        "background_mjy_sr": bkg,
        "aperture_radius_pix": r,
        "masked_fraction": float(bad_in.mean()) if bad_in.size else 1.0,
        "wave_um": float(p.wave_um[iy, ix]) if p.wave_um is not None else None,
        "bandwidth_um": float(p.bandwidth_um[iy, ix]) if p.bandwidth_um is not None else None,
    }
