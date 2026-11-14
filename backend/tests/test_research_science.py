"""Algorithm tests for V2 science modules (SYNTHETIC inputs with known answers, plus the real channel table)."""

from __future__ import annotations

import io
import json

import httpx
import numpy as np
import pytest
from astropy.io import fits
from conftest import FIXTURES

from stm.adapters.base import ObservationRecord
from stm.adapters.spherex import SpherexAdapter
from stm.config import Settings
from stm.science import crossmatch
from stm.science.lightcurve import LightCurveConfig, light_curve_stats, visits
from stm.science.psf import EPSFGrid
from stm.science.spectro import aperture_correction, assign_channel, load_channel_table
from stm.storage import LocalStorage

# ----------------------------------------------------------------------------- light curves


def test_weighted_mean_and_chi2_match_analytic():
    t = np.array([0.0, 1.0, 2.0, 3.0])
    f = np.array([10.0, 12.0, 8.0, 10.0])
    e = np.array([1.0, 2.0, 2.0, 1.0])
    st = light_curve_stats(t, f, e, LightCurveConfig(systematic_frac=0.0))
    w = 1 / e**2
    m = np.sum(w * f) / np.sum(w)
    assert st["weighted_mean_ujy"] == pytest.approx(m)
    assert st["weighted_mean_err_ujy"] == pytest.approx(1 / np.sqrt(w.sum()))
    assert st["chi2"] == pytest.approx(np.sum(((f - m) / e) ** 2))
    assert st["dof"] == 3 and st["median_ujy"] == 10.0


def test_heteroscedastic_noise_is_not_variability():
    """Constant source measured with very different noise levels: scatter is large, but not significant."""
    rng = np.random.default_rng(1)
    err = np.where(np.arange(40) % 2 == 0, 1.0, 25.0)
    f = 100.0 + rng.normal(0, err)
    st = light_curve_stats(np.arange(40.0), f, err)
    assert st["relative_scatter"] > 0.1  # visibly scattered
    assert st["verdict"] == "no_significant_variability"


def test_injected_variability_is_significant():
    t = np.linspace(0, 200, 30)
    f = 100 + 20 * np.sin(t / 15.0)
    st = light_curve_stats(t, f + np.random.default_rng(2).normal(0, 1, t.size), np.ones_like(t))
    assert st["verdict"] == "significant_variability" and st["p_value_constant"] < 1e-6
    assert st["fractional_excess_variance"] > 0.05


def test_insufficient_data_and_bad_values():
    st = light_curve_stats([1, 2, np.nan], [1, 2, 3], [1, 0, 1])
    assert st["n_points"] == 1 and st["verdict"] == "insufficient_data"
    assert light_curve_stats([], [], [])["verdict"] == "no_data"


def test_visits_and_cadence_gaps():
    t = np.array([0.0, 0.01, 0.02, 0.3, 180.0, 180.01, 400.0])
    v = visits(t, 0.5)
    assert v.max() + 1 == 3  # four exposures within hours form one visit
    st = light_curve_stats(t, np.full(t.size, 5.0), np.ones(t.size))
    assert st["n_visits"] == 3 and len(st["coverage_gaps"]) == 2


# ----------------------------------------------------------------------------- channels and aperture correction


def test_real_channel_table_and_assignment():
    ch = load_channel_table()
    assert len(ch) == 102 and {c["detector"] for c in ch} == {1, 2, 3, 4, 5, 6}
    assert all(sum(1 for c in ch if c["detector"] == d) == 17 for d in range(1, 7))
    c = assign_channel(ch, 1, 0.7712)
    assert c is not None and c["detector"] == 1 and c["subchannel"] == 2
    assert assign_channel(ch, 4, 0.7712) is None  # wavelength outside detector 4
    assert assign_channel(ch, None, 1.0) is None


def test_aperture_correction_matches_gaussian_enclosed_energy():
    s, ov, n = 1.0, 5, 41
    c = (n - 1) / 2
    yy, xx = np.mgrid[0:n, 0:n].astype(float)
    p = np.exp(-(((xx - c) / ov) ** 2 + ((yy - c) / ov) ** 2) / (2 * s**2))
    p /= p.sum()
    grid = EPSFGrid(np.array([0.0, 100.0]), np.array([0.0, 100.0]), np.tile(p, (2, 2, 1, 1)), (ov, ov), (0.0, 0.0), {})
    r = 2.5
    ac = aperture_correction(grid, 50.0, 50.0, r)
    # Point-sampled pixel responses inside a pixelated circle: compare with the analytic enclosed fraction
    assert ac == pytest.approx(1 - np.exp(-(r**2) / (2 * s**2)), abs=0.03)


# ----------------------------------------------------------------------------- range reads


def _adapter_for_bytes(tmp_path, data: bytes) -> SpherexAdapter:
    def handler(req: httpx.Request) -> httpx.Response:
        a, b = (int(x) for x in req.headers["Range"].split("=")[1].split("-"))
        if a >= len(data):
            return httpx.Response(416)
        return httpx.Response(206, content=data[a : b + 1])

    return SpherexAdapter(
        settings=Settings(data_dir=tmp_path, prefer_cloud_mirror=False),
        storage=LocalStorage(tmp_path),
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )


def test_row_reads_from_plain_and_rice_compressed_hdus(tmp_path):
    """SYNTHETIC file with the full-frame layout: float IMAGE and RICE_1-compressed integer FLAGS (one tile per row)."""
    rng = np.random.default_rng(3)
    img = rng.normal(size=(64, 50)).astype(np.float32)
    flg = rng.integers(0, 2**28, size=(64, 50)).astype(np.int32)
    hdul = fits.HDUList(
        [
            fits.PrimaryHDU(),
            fits.ImageHDU(img, name="IMAGE"),
            fits.CompImageHDU(flg, name="FLAGS", compression_type="RICE_1", tile_shape=(1, 50)),
        ]
    )
    buf = io.BytesIO()
    hdul.writeto(buf)
    ad = _adapter_for_bytes(tmp_path, buf.getvalue())
    rec = ObservationRecord(
        "SYNTHETIC",
        "synthetic",
        "SYN-1",
        "SYN",
        1,
        "",
        None,
        None,
        0,
        0,
        None,
        0,
        0,
        "",
        "https://example.invalid/syn.fits",
    )
    idx = ad.hdu_index(rec)  # walks to the end of file; HTTP 416 is end-of-file, not an error
    assert set(idx) == {"PRIMARY", "IMAGE", "FLAGS"}
    assert np.array_equal(ad.read_rows(rec, idx["IMAGE"], 10, 20), img[10:21].astype(float))
    assert np.array_equal(ad.read_rows(rec, idx["FLAGS"], 30, 40), flg[30:41])


# ----------------------------------------------------------------------------- cross-matching


def _rows(*seps, err=0.05):
    return [{"id": f"S{i}", "sep_arcsec": s, "pos_err_arcsec": err} for i, s in enumerate(seps)]


def test_crossmatch_classes():
    radius = 15.0
    one_close = crossmatch.score_counterparts(_rows(0.5), cand_err_arcsec=1.0, radius_arcsec=radius)
    assert crossmatch.classify_catalog(one_close, "ok") == "confirmed_positional"
    two_close = crossmatch.score_counterparts(_rows(0.5, 1.5), 1.0, radius)
    assert crossmatch.classify_catalog(two_close, "ok") == "possible"
    crowded = crossmatch.score_counterparts(_rows(0.5, *np.linspace(4, 15, 80)), 1.0, radius)
    assert crowded["expected_chance"] > 0.05
    assert crossmatch.classify_catalog(crowded, "ok") == "possible"
    far = crossmatch.score_counterparts(_rows(9.0), 1.0, radius)
    assert crossmatch.classify_catalog(far, "ok") == "inconclusive"
    assert crossmatch.classify_catalog(crossmatch.score_counterparts([], 1.0, radius), "ok") == "none"
    assert crossmatch.classify_catalog(crossmatch.score_counterparts([], 1.0, radius), "failed") == "inconclusive"
    trunc = crossmatch.score_counterparts(_rows(0.5), 1.0, radius, truncated=True)
    assert crossmatch.classify_catalog(trunc, "ok") == "possible"


def test_crossmatch_combination_never_hides_failures():
    assert crossmatch.combine({"SIMBAD": "none", "Gaia DR3": "none"}) == "none"
    assert crossmatch.combine({"SIMBAD": "none", "Gaia DR3": "inconclusive"}) == "inconclusive"
    assert crossmatch.combine({"SIMBAD": "possible", "Gaia DR3": "confirmed_positional"}) == "confirmed_positional"
    for text in crossmatch.CLASS_TEXT.values():
        assert "new object" not in text.lower() or "does not" in text.lower()


def test_channel_fixture_provenance():
    d = json.loads((FIXTURES / "spherex_dr1_spectral_channels.json").read_text())
    assert "SPECTRAL_CHANNELS" in d["source"] and "irsa.ipac.caltech.edu" in d["source"]
