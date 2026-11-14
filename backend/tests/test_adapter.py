"""Archive adapter tests (offline): VOTable parsing, retries, HTTP Range header walking."""

from __future__ import annotations

import httpx
import pytest
from conftest import FIXTURES

from stm.adapters.base import ArchiveError
from stm.adapters.spherex import SpherexAdapter
from stm.config import Settings
from stm.storage import LocalStorage


def make_adapter(tmp_path, handler) -> SpherexAdapter:
    s = Settings(data_dir=tmp_path, http_retries=2)
    return SpherexAdapter(
        settings=s, storage=LocalStorage(tmp_path), client=httpx.Client(transport=httpx.MockTransport(handler))
    )


def test_parse_real_sia_votable(tmp_path):
    ad = make_adapter(tmp_path, lambda r: httpx.Response(500))
    recs = ad.parse_sia_votable((FIXTURES / "sia_spherex_dr1_m31_first12.xml").read_bytes())
    assert len(recs) == 12
    r = next(x for x in recs if x.obs_id == "2025W28_2A_0101_1" and x.detector == 1)
    assert r.product_id == "2025W28_2A_0101_1D1"
    assert r.band_name == "SPHEREx-D1"
    assert abs(r.em_min_um - 0.7455) < 1e-4  # metres -> microns
    assert abs(r.t_min_mjd - 60867.045305) < 1e-6
    assert r.access_url.startswith("https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/")
    assert r.source_row["obs_collection"] == "spherex_dr1"
    assert [x.t_min_mjd for x in recs] == sorted(x.t_min_mjd for x in recs)


def test_query_retries_then_succeeds(tmp_path, monkeypatch):
    monkeypatch.setattr("time.sleep", lambda s: None)
    calls = {"n": 0}
    body = (FIXTURES / "sia_spherex_dr1_m31_first12.xml").read_bytes()

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(503) if calls["n"] < 2 else httpx.Response(200, content=body)

    recs = make_adapter(tmp_path, handler).query_position(10.6847, 41.269)
    assert len(recs) == 12 and calls["n"] == 2


def test_query_gives_up_with_archive_error(tmp_path, monkeypatch):
    monkeypatch.setattr("time.sleep", lambda s: None)
    with pytest.raises(ArchiveError, match="unreachable"):
        make_adapter(tmp_path, lambda r: httpx.Response(503)).query_position(1.0, 1.0)


def test_client_error_is_not_retried(tmp_path):
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(404)

    with pytest.raises(ArchiveError, match="HTTP 404"):
        make_adapter(tmp_path, handler).query_position(1.0, 1.0)
    assert calls["n"] == 1


def test_remote_header_walk_with_range_requests(tmp_path):
    data = (FIXTURES / "spherex_dr1_m31_cutout_noepsf.fits").read_bytes()

    def handler(req: httpx.Request) -> httpx.Response:
        rng = req.headers["Range"].split("=")[1]
        a, b = (int(x) for x in rng.split("-"))
        return httpx.Response(206, content=data[a : b + 1])

    ad = make_adapter(tmp_path, handler)
    names = [n for n, *_ in ad.iter_remote_headers("https://example.invalid/x.fits")]
    assert names == ["PRIMARY", "IMAGE", "FLAGS", "VARIANCE", "ZODI", "WCS-WAVE"]
    from stm.adapters.base import ObservationRecord

    rec = ObservationRecord(
        "SPHEREx",
        "spherex_dr1",
        "2025W28_2A_0101_1D1",
        "2025W28_2A_0101_1",
        1,
        "SPHEREx-D1",
        None,
        None,
        0,
        0,
        None,
        0,
        0,
        "",
        "https://example.invalid/l2b-v27-2026-216/x.fits",
    )
    hdr = ad.fetch_image_header(rec)
    assert hdr["OBSID"] == "2025W28_2A_0101_1"
    lut = ad.fetch_wavelength_lookup(rec)
    assert lut["pipeline_version"] == "l2b-v27" and len(lut["values"]) == 9
    assert "spectral_wcs_1" in lut["calibration_source"]


def test_range_ignored_is_an_error(tmp_path):
    ad = make_adapter(tmp_path, lambda r: httpx.Response(200, content=b"x" * 100))
    with pytest.raises(ArchiveError, match="Range"):
        list(ad.iter_remote_headers("https://example.invalid/x.fits"))


def test_cutout_must_be_fits(tmp_path):
    ad = make_adapter(tmp_path, lambda r: httpx.Response(200, content=b"<html>error</html>"))
    rec = ad.parse_sia_votable((FIXTURES / "sia_spherex_dr1_m31_first12.xml").read_bytes())[0]
    with pytest.raises(ArchiveError, match="not a FITS"):
        ad.fetch_cutout(rec, 10.68, 41.27, 0.1)
