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
