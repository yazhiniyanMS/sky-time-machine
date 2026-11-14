"""Integration tests against the live NASA/IPAC IRSA archive.

Run with ``pytest -m network``. They download a few small SPHEREx DR1
cutouts (~4 MB each) of M31. Results depend on archive availability.
"""

from __future__ import annotations

import numpy as np
import pytest
from synthetic import PIX_ARCSEC

from stm.adapters.spherex import SpherexAdapter
from stm.pipeline import ProcessingConfig, process_products, spectral_timeline
from stm.science.fitsio import load_spherex_l2

pytestmark = pytest.mark.network
M31 = (10.6847, 41.2690)
PAIR = ("2025W28_1B_0600_1D1", "2025W33_2C_0100_1D1")  # same wavelength at M31, 35.6 d apart


@pytest.fixture(scope="module")
def adapter():
    return SpherexAdapter()


def test_live_sia_query(adapter):
    recs = adapter.query_position(*M31)
    assert len(recs) > 50
    assert {r.detector for r in recs} == {1, 2, 3, 4, 5, 6}
    assert all(r.access_url.startswith("https://irsa.ipac.caltech.edu/") for r in recs)


def test_live_spectral_timeline_finds_matched_pair(adapter):
    tl = spectral_timeline(adapter, *M31, detector=1)
    assert len(tl["observations"]) > 10
    pairs = {(p["a"], p["b"]) for p in tl["pairs"]}
    assert PAIR in pairs


@pytest.fixture(scope="module")
def real_pair(adapter):
    recs = {r.product_id: r for r in adapter.query_position(*M31)}
    return [load_spherex_l2(adapter.fetch_cutout(recs[p], *M31, 0.16), p) for p in PAIR]


def test_live_real_pair_registration_and_noise(real_pair):
    a, b = real_pair
    out = process_products(a, b, *M31, 0.1, ProcessingConfig())
    res = out["res"]
    assert res.accepted, [c.detail for c in res.checks if not c.passed]
    assert res.metrics["residual_shift_pix"] < 0.2
    assert res.metrics["dlambda_frac_median"] < 0.05
    s = res.significance[res.valid]
    assert 0.7 < np.nanstd(s) < 1.6


def test_live_injection_recovery_on_real_data(real_pair):
    """Inject a SYNTHETIC point source into a real epoch and recover it.

    This measures recovery of a known signal in real SPHEREx noise and
    backgrounds; it is not a detection of anything astrophysical.
    """
    a, b = real_pair
    ra_inj, dec_inj = M31[0] + 0.025 / np.cos(np.radians(M31[1])), M31[1] - 0.02
    x, y = b.wcs.world_to_pixel_values(ra_inj, dec_inj)
    yy, xx = np.mgrid[0 : b.shape[0], 0 : b.shape[1]]
    sig = (b.psf_fwhm_arcsec or 7.5) / 2.3548 / PIX_ARCSEC
    peak = 25 * float(np.sqrt(np.median(b.variance)))  # bright enough to be unambiguous
    b.image = b.image + peak * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * sig**2))
    out = process_products(a, b, *M31, 0.1, ProcessingConfig())
    hits = [
        i
        for i in out["items"]
        if i["detection"].sign > 0
        and np.hypot((i["detection"].ra - ra_inj) * np.cos(np.radians(M31[1])), i["detection"].dec - dec_inj) * 3600
        < 10
    ]
    assert hits, "injected source not recovered"


# --------------------------------------------------------------------------- V2: spectra, stamps, catalogues


def test_live_cube_spectrum_m31(adapter):
    from stm.science.spectro import cube_spectrum

    cs = cube_spectrum(adapter, *M31)
    assert len(cs["channels"]) == 102 and cs["unit"] == "MJy/sr"
    blank = {f"D{c['detector']}:{c['subchannel']:02d}" for c in cs["channels"] if c["missing"]}
    assert set(cs["blank_channels"]) <= blank  # archive-declared blank planes are reported missing
    assert any(c["surface_brightness_mjy_sr"] for c in cs["channels"])
    assert all(c["surface_brightness_mjy_sr"] is None for c in cs["channels"] if c["missing"])


def test_live_range_stamp_equals_irsa_cutout(adapter):
    """Pixels read by HTTP Range (incl. RICE-compressed FLAGS) equal the IRSA cutout service's pixels."""
    from stm.science.spectro import read_stamp

    recs = {r.product_id: r for r in adapter.query_position(*M31)}
    rec = recs["2025W28_2A_0263_3D1"]
    pos = (M31[0] + 0.025 / np.cos(np.radians(M31[1])), M31[1] - 0.02)
    st = read_stamp(adapter, rec, *pos, lut=adapter.fetch_wavelength_lookup(rec))
    cut = load_spherex_l2(adapter.fetch_cutout(rec, *M31, 0.16), rec.product_id)
    x, y = (int(round(float(v))) for v in cut.wcs.world_to_pixel_values(*pos))
    xs, ys = (int(round(float(v))) for v in st.wcs.world_to_pixel_values(*pos))
    sl_c = np.s_[y - 4 : y + 5, x - 4 : x + 5]
    sl_s = np.s_[ys - 4 : ys + 5, xs - 4 : xs + 5]
    assert np.array_equal(cut.flags[sl_c], st.flags[sl_s])
    assert np.allclose(cut.image[sl_c], st.image[sl_s]) and np.allclose(cut.variance[sl_c], st.variance[sl_s])
    assert np.allclose(cut.wave_um[sl_c], st.wave_um[sl_s])


def test_live_spectrophotometry_small_run(adapter):
    from stm.science.spectro import spectrophotometry

    pos = (M31[0] + 0.025 / np.cos(np.radians(M31[1])), M31[1] - 0.02)
    res = spectrophotometry(adapter, *pos, detectors=[1], max_exposures=6)
    ok = [p for p in res["points"] if p["status"] == "ok"]
    assert ok and all(p["channel"] is not None for p in ok)
    assert all(0.7 < p["wave_um"] < 1.12 and p["flux_err_ujy"] > 0 for p in ok)
    assert all(p["aperture_correction"] is None or 0.5 < p["aperture_correction"] < 1.0 for p in ok)


def test_live_simbad_cone():
    from stm.catalogs import CatalogService

    res = CatalogService().simbad_cone(*M31, radius_arcsec=30)
    assert res.status == "ok" and res.rows, res.message
    assert all(r["sep_arcsec"] <= 30.01 for r in res.rows) and res.rows[0]["id"]
