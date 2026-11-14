"""Algorithm tests on SYNTHETIC images with known ground truth.

These validate the implementation of registration, differencing,
uncertainty propagation, detection and artifact rejection. Passing them does
not validate the pipeline's scientific performance on real SPHEREx data.
"""

from __future__ import annotations

import numpy as np
import pytest
from synthetic import Src, write_mef

from stm.pipeline import ProcessingConfig, comparison_id, process_products
from stm.science.difference import DifferenceConfig, compare
from stm.science.fitsio import load_spherex_l2
from stm.science.registration import phase_correlation_shift, register, target_grid

RA, DEC = 150.0, 2.0
STARS = [Src(RA + 0.02, DEC + 0.01, 3.0), Src(RA - 0.03, DEC - 0.02, 1.5), Src(RA + 0.01, DEC - 0.03, 0.8)]


def pair(tmp_path, b_sources=None, **kw_b):
    a = load_spherex_l2(
        write_mef(
            tmp_path / "a.fits", ra=RA, dec=DEC, sources=STARS, t_mjd=61000.0, seed=1, product_id="SYNTHETIC-AD1"
        ),
        "SYNTHETIC-AD1",
    )
    b = load_spherex_l2(
        write_mef(
            tmp_path / "b.fits",
            ra=RA,
            dec=DEC,
            sources=b_sources or STARS,
            t_mjd=61030.0,
            seed=2,
            product_id="SYNTHETIC-BD1",
            **kw_b,
        ),
        "SYNTHETIC-BD1",
    )
    return a, b


def test_registration_aligns_offset_rotated_frames(tmp_path):
    a, b = pair(tmp_path, offset_pix=(3.4, -2.7), rot_deg=7.0)
    w, shape = target_grid(RA, DEC, 0.12, 6.15)
    ra_, rb_ = register(a, w, shape), register(b, w, shape)
    valid = ~(ra_.bad | rb_.bad)
    dy, dx, contrast = phase_correlation_shift(ra_.image, rb_.image, valid)
    assert contrast > 5
    assert np.hypot(dx, dy) < 0.15  # aligned to a small fraction of a pixel


def test_phase_correlation_recovers_known_shift():
    rng = np.random.default_rng(0)
    yy, xx = np.mgrid[0:64, 0:64]

    def img(x0, y0):
        return np.exp(-((xx - x0) ** 2 + (yy - y0) ** 2) / 4) + 0.5 * np.exp(-((xx - 20) ** 2 + (yy - 40) ** 2) / 4)

    a = img(30, 30) + rng.normal(0, 0.01, (64, 64))
    b = np.roll(a, (2, -3), axis=(0, 1))
    dy, dx, _ = phase_correlation_shift(a, b, np.ones_like(a, bool))
    assert round(dy) == 2 and round(dx) == -3


def test_identical_scenes_give_unit_significance_and_no_detections(tmp_path):
    a, b = pair(tmp_path)
    out = process_products(a, b, RA, DEC, 0.12, ProcessingConfig())
    res = out["res"]
    assert res.accepted
    s = res.significance[res.valid]
    assert abs(np.median(s)) < 0.1
    assert 0.8 < np.std(s) < 1.2
    assert out["items"] == []


def test_uncertainty_propagation_without_rescale(tmp_path):
    a, b = pair(tmp_path)
    w, shape = target_grid(RA, DEC, 0.12, 6.15)
    res = compare(register(a, w, shape), register(b, w, shape), DifferenceConfig(noise_rescale=False, psf_match=False))
    # synthetic variance is 0.05^2 per epoch -> sigma_D = sqrt(2) * 0.05
    assert np.allclose(res.sigma[res.valid], np.sqrt(2) * 0.05, rtol=1e-6)
    assert res.metrics["noise_rescale_factor"] == 1.0


def test_injected_transient_is_detected_and_measured(tmp_path):
    new = Src(RA - 0.015, DEC + 0.025, 1.2)
    a, b = pair(tmp_path, b_sources=STARS + [new])
    out = process_products(a, b, RA, DEC, 0.12, ProcessingConfig())
    good = [i for i in out["items"] if i["tier"] != "R"]
    assert len(good) == 1
    d = good[0]["detection"]
    assert d.sign == 1
    sep = np.hypot((d.ra - new.ra) * np.cos(np.radians(DEC)), d.dec - new.dec) * 3600
    assert sep < 3 * d.pos_err_arcsec
    assert good[0]["machine_class"] == "new_source_candidate"
    # injected integrated flux: peak * 2*pi*sigma^2 pixels * pixel solid angle -> uJy
    sig_pix = 7.5 / 2.3548 / 6.15
    omega = (6.15 / 206264.806) ** 2
    injected_ujy = 1.2 * 2 * np.pi * sig_pix**2 * omega * 1e12
    # aperture of 1.5 FWHM captures ~99.8 % of a Gaussian
    assert abs(d.diff_flux_ujy - injected_ujy) < 4 * d.diff_flux_err_ujy + 0.05 * injected_ujy


def test_variable_star_and_fading_source(tmp_path):
    brighter = [Src(s.ra, s.dec, s.flux_mjy_sr_peak * (1.6 if i == 1 else 1.0)) for i, s in enumerate(STARS)]
    faded = brighter[:2]  # third star disappears
    a, b = pair(tmp_path, b_sources=faded)
    out = process_products(a, b, RA, DEC, 0.12, ProcessingConfig())
    classes = sorted(i["machine_class"] for i in out["items"] if i["tier"] != "R")
    assert "variable_candidate" in classes
    assert "disappeared_source_candidate" in classes or "possible_moving_object_pair" in classes


def test_flagged_bad_pixel_is_masked_not_detected(tmp_path):
    a, b = pair(tmp_path, bad_pixels=[(30, 50, "HOT"), (55, 20, "TRANSIENT")])
    out = process_products(a, b, RA, DEC, 0.12, ProcessingConfig())
    assert [i for i in out["items"] if i["tier"] != "R"] == []


def test_unflagged_hot_pixel_never_becomes_tier_a(tmp_path):
    """An unflagged single-pixel spike is either below min_pixels or fails the extent check."""
    a, b = pair(tmp_path)
    b.image[40, 25] += 3.0  # single-pixel spike that the archive did not flag
    out = process_products(a, b, RA, DEC, 0.12, ProcessingConfig())
    assert all(i["tier"] != "A" for i in out["items"])
    # A two-pixel spike passes min_pixels but must still be down-ranked.
    b.image[40, 26] += 3.0
    out = process_products(a, b, RA, DEC, 0.12, ProcessingConfig())
    assert out["items"], "expected the two-pixel spike to be detected"
    assert all(i["tier"] != "A" for i in out["items"])


def test_misregistration_produces_dipole_or_rejection(tmp_path):
    a, b = pair(tmp_path)
    # Corrupt epoch B's WCS by ~0.8 px so the archive astrometry is wrong.
    b.wcs.wcs.crpix = b.wcs.wcs.crpix + np.array([0.8, 0.0])
    out = process_products(a, b, RA, DEC, 0.12, ProcessingConfig())
    reg = next(c for c in out["res"].checks if c.name == "registration")
    assert not reg.passed, reg.detail
    assert not out["res"].accepted


def test_different_detectors_are_never_subtracted(tmp_path):
    a = load_spherex_l2(
        write_mef(tmp_path / "a.fits", ra=RA, dec=DEC, sources=STARS, t_mjd=61000, seed=1, detector=1), "SYNTHETIC-AD1"
    )
    b = load_spherex_l2(
        write_mef(tmp_path / "b.fits", ra=RA, dec=DEC, sources=STARS, t_mjd=61010, seed=2, detector=2), "SYNTHETIC-BD2"
    )
    out = process_products(a, b, RA, DEC, 0.12, ProcessingConfig())
    assert not out["res"].accepted
    assert out["items"] == []
    assert any(c.name == "same_detector" and not c.passed for c in out["res"].checks)


def test_spectral_mismatch_is_rejected(tmp_path):
    a, b = pair(tmp_path, wave_offset_um=0.05)  # ~2 bandwidths away
    out = process_products(a, b, RA, DEC, 0.12, ProcessingConfig())
    assert not out["res"].accepted
    assert out["res"].metrics["valid_fraction"] == 0.0


def test_partial_spectral_overlap_masks_pixels(tmp_path):
    a, b = pair(tmp_path, wave_offset_um=0.004)
    out = process_products(a, b, RA, DEC, 0.12, ProcessingConfig())
    dl = out["res"].dlambda_frac
    assert np.all(dl[out["res"].valid] <= 0.5)


def test_processing_is_deterministic(tmp_path):
    a, b = pair(tmp_path, b_sources=STARS + [Src(RA, DEC + 0.02, 1.0)])
    o1 = process_products(a, b, RA, DEC, 0.12, ProcessingConfig())
    o2 = process_products(a, b, RA, DEC, 0.12, ProcessingConfig())
    assert np.array_equal(o1["res"].diff, o2["res"].diff, equal_nan=True)
    assert [i["detection"].measurements() for i in o1["items"]] == [i["detection"].measurements() for i in o2["items"]]
    cfg = ProcessingConfig()
    assert comparison_id(RA, DEC, 0.12, "x", "y", cfg) == comparison_id(RA, DEC, 0.12, "x", "y", ProcessingConfig())
    cfg.detection.threshold_sigma = 4.0
    assert comparison_id(RA, DEC, 0.12, "x", "y", cfg) != comparison_id(RA, DEC, 0.12, "x", "y", ProcessingConfig())


def test_epoch_order_is_normalised(tmp_path):
    a, b = pair(tmp_path)
    out = process_products(b, a, RA, DEC, 0.12, ProcessingConfig())
    assert out["pa"].t_mid_mjd < out["pb"].t_mid_mjd


@pytest.mark.parametrize("fwhm_b", [7.5, 10.0])
def test_psf_matching_flag(tmp_path, fwhm_b):
    a, b = pair(tmp_path, fwhm_arcsec=fwhm_b)
    out = process_products(a, b, RA, DEC, 0.12, ProcessingConfig())
    assert out["res"].metrics["psf_matched"] is (fwhm_b != 7.5)
