from __future__ import annotations

from stm.science.tracking import TrackInput, associate, sep_arcsec


def ti(cid, ra, dec, t, comp, sign=1, err=2.0):
    return TrackInput(cid, ra, dec, err, t, comp, sign, 10.0)


def test_sep_arcsec():
    assert abs(sep_arcsec(10, 0, 10, 1 / 3600) - 1.0) < 1e-6


def test_stationary_association_across_comparisons():
    items = [
        ti("a", 10.0, 20.0, 61000, "c1"),
        ti("b", 10.0 + 1 / 3600, 20.0, 61030, "c2"),
        ti("far", 10.1, 20.0, 61030, "c2"),
    ]
    tracks = associate(items)
    kinds = {t.kind: t for t in tracks}
    assert sorted(kinds["stationary_repeated"].members) == ["a", "b"]
    assert any(t.kind == "single_detection" and t.members == ["far"] for t in tracks)


def test_same_comparison_detections_are_not_merged():
    items = [ti("a", 10.0, 20.0, 61000, "c1"), ti("b", 10.0, 20.0, 61000, "c1")]
    assert all(t.kind == "single_detection" for t in associate(items))


def test_linear_motion_is_linked():
    # 30 arcsec/hour eastward motion sampled at three epochs
    rate_deg_per_day = 30 * 24 / 3600
    t0 = 61000.0
    items = [
        ti(f"m{i}", 10.0 + rate_deg_per_day * dt / 0.9397, 20.0, t0 + dt, f"c{i}")
        for i, dt in enumerate([0.0, 0.1, 0.25])
    ]
    tracks = associate(items)
    mov = [t for t in tracks if t.kind == "potential_moving_object"]
    assert len(mov) == 1
    assert abs(mov[0].metrics["rate_arcsec_per_hr"] - 30) < 1.0


def test_inconsistent_motion_is_not_linked():
    items = [
        ti("p", 10.0, 20.0, 61000.0, "c1"),
        ti("q", 10.01, 20.0, 61000.1, "c2"),
        ti("r", 10.0, 20.05, 61000.2, "c3"),
    ]
    assert not [t for t in associate(items) if t.kind == "potential_moving_object"]
