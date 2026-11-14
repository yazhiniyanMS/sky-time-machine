"""FITS parsing, metadata validation, WCS and wavelength tests (real SPHEREx fixture)."""

from __future__ import annotations

import re
import warnings

import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS

from stm.science.fitsio import (
    SPHEREX_DEFAULT_FLAGS,
    celestial_wcs,
    load_spherex_l2,
    parse_flag_definitions,
    raw_coords,
    validate_wcs,
)


def test_real_cutout_loads_and_validates(real_cutout):
    p = load_spherex_l2(real_cutout)
    assert p.shape == (59, 58)
    assert p.detector == 1
    assert p.unit == "MJy / sr"
    assert abs(p.t_mid_mjd - 60867.04597112) < 1e-8
    assert abs(p.pixel_scale_arcsec - 6.15) < 0.05
    failed = [c.name for c in p.checks if not c.passed and c.severity == "error"]
    assert failed == []
    assert p.header_meta["OBSID"] == "2025W28_2A_0101_1"


def test_flag_definitions_are_read_from_header(real_cutout):
    with fits.open(real_cutout) as h:
        defs = parse_flag_definitions(h["FLAGS"].header)
    assert defs["SOURCE"] == 21 and defs["TRANSIENT"] == 0 and defs["HALO"] == 28
    assert defs == {k: v for k, v in SPHEREX_DEFAULT_FLAGS.items() if k in defs}


def test_wavelength_map_matches_astropy_tab_without_sip(real_cutout):
    """Our bilinear WCS-WAVE evaluation equals wcslib's -TAB evaluation.

    The archive header carries the celestial SIP coefficients, which astropy
    would also apply to the wavelength ('W') WCS; they are removed here so that
    both implement the FITS Paper III -TAB algorithm on the same pixels.
    """
    p = load_spherex_l2(real_cutout)
    with fits.open(real_cutout) as h:
        ih = h["IMAGE"].header.copy()
        for k in list(ih.keys()):
            if re.match(r"^(A|B|AP|BP)_(\d_\d|ORDER)$", k):
                del ih[k]
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            w = WCS(ih, fobj=h, key="W")
        yy, xx = np.mgrid[0 : p.shape[0], 0 : p.shape[1]]
        wave, bw = w.pixel_to_world_values(xx, yy)
    assert np.max(np.abs(wave - p.wave_um)) < 1e-9
    assert np.max(np.abs(bw - p.bandwidth_um)) < 1e-9
    # Detector 1 covers ~0.75-1.09 um; this cutout sits near 0.86 um.
    assert 0.85 < np.median(p.wave_um) < 0.87


def test_raw_coords_offsets():
    h = fits.Header({"CRPIX1W": -620.0, "CRPIX2W": -1230.0, "CRVAL1W": 1.0, "CRVAL2W": 1.0})
    xr, yr = raw_coords(h, np.array(0.0), np.array(0.0))
    assert (float(xr), float(yr)) == (622.0, 1232.0)


def test_wcs_validation_detects_missing_celestial():
    w = WCS(naxis=2)
    w.wcs.ctype = ["LINEAR", "LINEAR"]
    checks = validate_wcs(w, (10, 10))
    assert checks[0].name == "wcs_celestial" and not checks[0].passed


def test_celestial_wcs_roundtrip(real_cutout):
    with fits.open(real_cutout) as h:
        w = celestial_wcs(h["IMAGE"].header)
    ra, dec = w.pixel_to_world_values(29, 29)
    assert abs(ra - 10.6847) < 0.01 and abs(dec - 41.269) < 0.01


def test_missing_extension_raises(tmp_path, real_cutout):
    with fits.open(real_cutout) as h:
        fits.HDUList([h[0].copy(), h["IMAGE"].copy()]).writeto(tmp_path / "bad.fits")
    with pytest.raises(ValueError, match="missing FLAGS"):
        load_spherex_l2(tmp_path / "bad.fits")
