"""API tests for the research platform. Archive and catalogue services are replaced by SYNTHETIC fakes."""

from __future__ import annotations

import sqlite3

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from test_api import DEC, RA, FakeAdapter, wait_job

import stm.api.candidates as api_candidates
import stm.api.comparisons as api_comparisons
import stm.api.observations as api_observations
import stm.api.research as api_research
import stm.api.workspace as api_workspace
from stm.catalogs import CatalogResult
from stm.main import app


class FakeCatalogs:
    """SYNTHETIC catalogue answers: one SIMBAD source 0.4″ away, Gaia service down."""

    def simbad_cone(self, ra, dec, radius_arcsec, limit=200):
        return CatalogResult(
            "simbad",
            "ok",
            "fake://simbad",
            [
                {
                    "id": "SYNTHETIC-SIMBAD-1",
                    "type": "Star",
                    "ra": ra,
                    "dec": dec + 0.4 / 3600,
                    "sep_arcsec": 0.4,
                    "pos_err_arcsec": 0.05,
                    "reference": "SYNTHETIC",
                    "url": None,
                }
            ],
            0.0,
        )

    def gaia_cone(self, ra, dec, radius_arcsec, limit=500):
        return CatalogResult("gaia_dr3", "failed", None, [], 0.0, "fake outage")

    def objects_by_type(self, ra, dec, radius_deg, kind, limit=500):
        return CatalogResult(
            f"simbad_{kind}",
            "ok",
            "fake://simbad",
            [{"main_id": "SYNTHETIC-G", "ra": ra, "dec": dec, "otype": "G", "galdim_majaxis": 1.0}],
            0.0,
        )


@pytest.fixture
def env(tmp_path, monkeypatch):
    fake = FakeAdapter(tmp_path)
    for mod in (api_observations, api_comparisons, api_candidates, api_research, api_workspace):
        monkeypatch.setattr(mod, "adapter", lambda: fake)
    monkeypatch.setattr(api_research, "catalogs", lambda: FakeCatalogs())
    with TestClient(app) as c:
        body = {
            "ra": RA,
            "dec": DEC,
            "size_deg": 0.1,
            "product_a": "SYNTHETIC-0001_1D1",
            "product_b": "SYNTHETIC-0002_1D1",
        }
        r = c.post("/api/comparisons", json=body).json()
        if r["job_id"]:
            assert wait_job(c, r["job_id"])["status"] == "done"
        comp = c.get(f"/api/comparisons/{r['comparison_id']}").json()
        cand = next(x for x in comp["candidates"] if not x["rejected"])
        yield c, fake, comp["id"], cand["id"]


def test_discovery_feed_filters_sort_and_pages(env):
    c, _, cid, cand = env
    d = c.get("/api/discoveries", params={"page_size": 1}).json()
    assert d["total"] >= 1 and d["page"] == 1 and len(d["items"]) == 1 and d["n_comparisons_processed"] >= 1
    item = next(i for i in c.get("/api/discoveries", params={"page_size": 200}).json()["items"] if i["id"] == cand)
    for key in (
        "ra",
        "dec",
        "machine_class",
        "peak_significance",
        "diff_snr",
        "t_a_mjd",
        "t_b_mjd",
        "survey",
        "pipeline_version",
        "quality_tier",
        "verification_status",
    ):
        assert key in item
    assert c.get("/api/discoveries", params={"q": cand}).json()["items"][0]["id"] == cand
    assert c.get("/api/discoveries", params={"machine_class": "no_such_class"}).json()["total"] == 0
    assert c.get("/api/discoveries", params={"min_snr": 1e9}).json()["total"] == 0
    assert c.get("/api/discoveries", params={"ra": 0.0, "dec": -80.0, "radius": 0.1}).json()["total"] == 0
    by_date = c.get("/api/discoveries", params={"sort": "date", "order": "asc"}).json()
    assert by_date["sort"] == "date"
    assert c.get("/api/discoveries", params={"sort": "bogus"}).status_code == 422


def test_csv_exports(env):
    c, _, cid, cand = env
    r = c.get("/api/export/candidates.csv")
    assert r.headers["content-type"].startswith("text/csv") and cand in r.text and "unverified" in r.text
    ref = c.get(f"/api/comparisons/{cid}/references.csv").text
    assert "SYNTHETIC-0001_1D1" in ref and "synthetic" in ref


def test_assessment_and_counterparts(env):
    c, _, cid, cand = env
    a = c.get(f"/api/candidates/{cand}/assessment").json()
    assert "threshold" in a["why_detected"]["text"] and a["data_kinds"]["ai"]
    assert a["psf"]["psf_method"] in ("epsf_cross", "gaussian", "gaussian_not_needed", "none")
    assert any("cross-matching has not been run" in u for u in a["remaining_uncertainties"])
    cp = c.get(f"/api/candidates/{cand}/counterparts", params={"radius_arcsec": 15}).json()
    assert cp["catalogs"]["Gaia DR3"]["association"] == "inconclusive"  # service failure is never "none"
    assert cp["catalogs"]["SIMBAD"]["counterparts"][0]["id"] == "SYNTHETIC-SIMBAD-1"
    assert cp["association"] in ("confirmed_positional", "possible")
    again = c.get(f"/api/candidates/{cand}/counterparts", params={"radius_arcsec": 15}).json()
    assert again["assessed_at"] == cp["assessed_at"]  # stored, not re-queried
    a2 = c.get(f"/api/candidates/{cand}/assessment").json()
    assert a2["counterparts"]["association"] == cp["association"]
    objs = c.get("/api/catalog/objects", params={"ra": RA, "dec": DEC, "radius": 0.5, "kind": "galaxy"}).json()
    assert objs["objects"][0]["otype"] == "G"


def test_investigation_workspace_and_report(env):
    c, _, cid, cand = env
    inv = c.post(
        "/api/investigations",
        json={"title": "Test field", "description": "d", "owner": "tester", "ra": RA, "dec": DEC, "radius_deg": 0.2},
    ).json()
    iid = inv["id"]
    assert iid.startswith("INV-")
    c.post(f"/api/investigations/{iid}/items", json={"kind": "candidate", "ref_id": cand, "note": "check"})
    c.post(f"/api/investigations/{iid}/items", json={"kind": "comparison", "ref_id": cid})
    dup = c.post(f"/api/investigations/{iid}/items", json={"kind": "candidate", "ref_id": cand}).json()
    assert dup["n_items"] == 2  # duplicates are ignored
    assert c.post(f"/api/investigations/{iid}/items", json={"kind": "candidate", "ref_id": "ST-0-0"}).status_code == 404
    p = c.patch(
        f"/api/investigations/{iid}",
        json={"notes": "Residual near star.", "references": [{"title": "Paper", "url": "https://example.org"}]},
    )
    assert p.json()["notes"] == "Residual near star."
    got = c.get(f"/api/investigations/{iid}").json()
    assert got["items"][0]["payload"]["machine_class"]  # snapshot of the record
    md = c.get(f"/api/investigations/{iid}/export.md").text
    assert cand in md and "None is a confirmed discovery" in md
    js = c.get(f"/api/investigations/{iid}/export.json").json()
    assert js["candidates"][0]["id"] == cand and js["comparisons"]
    html = c.get(f"/api/investigations/{iid}/report.html").text
    for section in (
        "Overview",
        "Observation provenance",
        "Processing methodology",
        "Measurements and uncertainty",
        "Classification",
        "Limitations",
        "References",
    ):
        assert section in html
    assert "preliminary" in html and "Confirmed discovery" not in html and "SYNTHETIC" in html
    item_id = got["items"][0]["id"]
    assert c.delete(f"/api/investigations/{iid}/items/{item_id}").json()["n_items"] == 1
    assert any(i["id"] == iid for i in c.get("/api/investigations").json())
    assert c.delete(f"/api/investigations/{iid}").json()["deleted"] == iid
    assert c.get(f"/api/investigations/{iid}").status_code == 404


def test_watchlist_detects_newly_released_products(env):
    c, fake, _, cand = env
    w = c.post("/api/watchlists", json={"kind": "region", "ra": RA, "dec": DEC, "label": "field"}).json()
    assert w["n_known_products"] == 2 and w["checks"][0]["message"] == "baseline recorded"
    fake.times["SYNTHETIC-0003_1D1"] = 61200.0  # a later release adds one product
    chk = c.post(f"/api/watchlists/{w['id']}/check").json()
    assert chk["last_new_count"] == 1 and chk["checks"][0]["new_products"] == ["SYNTHETIC-0003_1D1"]
    again = c.post(f"/api/watchlists/{w['id']}/check").json()
    assert again["last_new_count"] == 0
    wc = c.post("/api/watchlists", json={"kind": "candidate", "ref_id": cand}).json()
    assert wc["kind"] == "candidate" and wc["ra"] is not None
    assert c.delete(f"/api/watchlists/{w['id']}").json()["deleted"] == w["id"]


def test_spectra_and_light_curve_api(env, monkeypatch):
    c, _, _, cand = env
    pts = [
        {
            "product_id": f"SYN-{i}D1",
            "obs_id": f"SYN-{i}",
            "detector": 1,
            "t_mid_mjd": 61000.0 + 30 * i,
            "access_url": "synthetic://",
            "status": "ok",
            "wave_um": 0.7712,
            "bandwidth_um": 0.019,
            "channel": 1,
            "subchannel": 2,
            "flux_ujy": 100.0 + (5 if i % 2 else -5),
            "flux_err_ujy": 5.0,
            "aperture_correction": 0.95,
            "flux_pointsource_ujy": 105.0,
            "flux_pointsource_err_ujy": 5.3,
            "masked_fraction": 0.0,
            "quality": "good",
            "quality_reasons": [],
        }
        for i in range(6)
    ]
    pts.append(
        {
            "product_id": "SYN-9D1",
            "obs_id": "SYN-9",
            "detector": 1,
            "t_mid_mjd": 61400.0,
            "access_url": "x",
            "status": "masked",
            "message": "every aperture pixel is flagged; no measurement",
            "channel": 1,
        }
    )
    fake_result = {
        "ra": RA,
        "dec": DEC,
        "n_exposures": 7,
        "points": pts,
        "skipped_over_limit": [],
        "calibration": {},
        "method": "SYNTHETIC test points",
    }
    monkeypatch.setattr(api_research, "spectrophotometry", lambda *a, **k: fake_result)
    r = c.post("/api/spectra/runs", json={"ra": RA, "dec": DEC, "candidate_id": cand}).json()
    assert wait_job(c, r["job_id"])["status"] == "done"
    run = c.get(f"/api/spectra/runs/{r['run_id']}").json()
    assert run["n_points"] == 6 and len(run["points"]) == 7
    lc = c.get(f"/api/lightcurves/{r['run_id']}", params={"channel": 1}).json()
    assert lc["stats"]["n_points"] == 6 and lc["stats"]["verdict"] == "no_significant_variability"
    assert lc["excluded"][0]["status"] == "masked"
    assert "verdict" in c.get(f"/api/lightcurves/{r['run_id']}/csv", params={"channel": 1}).text
    assert c.get(f"/api/spectra/runs/{r['run_id']}/csv").text.count("\nSYN-") == 7  # one data row per exposure
    assert c.get("/api/spectra/runs", params={"candidate_id": cand}).json()[0]["id"] == r["run_id"]
    # the assistant now cites the run and the light-curve verdict
    a = c.post(
        "/api/assistant/chat",
        json={"question": "Compare its brightness across epochs", "context": {"candidate_id": cand}},
    ).json()
    assert r["run_id"] in a["answer"] and a["grounding"]["spectrophotometry_run"] == r["run_id"]
    assert any(x["ref"] == cand for x in a["grounding"]["citations"])


def test_assistant_counterparts_and_similar(env):
    c, _, _, cand = env
    c.get(f"/api/candidates/{cand}/counterparts")
    a = c.post(
        "/api/assistant/chat",
        json={"question": "Show its known catalogue counterparts", "context": {"candidate_id": cand}},
    ).json()
    assert "Known counterparts" in a["answer"] and "SYNTHETIC-SIMBAD-1" in a["answer"] and "### Sources" in a["answer"]
    s = c.post(
        "/api/assistant/chat",
        json={"question": "Find other candidates with similar measured properties", "context": {"candidate_id": cand}},
    ).json()
    assert "similar measured properties" in s["answer"]


def test_legacy_database_is_stamped_and_upgraded(tmp_path):
    from stm.db import LEGACY_TABLES, Base, run_migrations

    url = f"sqlite:///{tmp_path / 'legacy.sqlite'}"
    eng = create_engine(url)
    Base.metadata.create_all(eng, tables=[t for n, t in Base.metadata.tables.items() if n in LEGACY_TABLES])
    with eng.begin() as conn:
        conn.exec_driver_sql(
            "INSERT INTO comparisons (id, created_at, status, survey, ra, dec, size_deg, product_a, product_b, "
            "pipeline_version, provenance, summary) VALUES ('CMP-LEGACY', '2026-11-14 00:00:00', 'done', 'SPHEREx', "
            "1, 2, 0.1, 'a', 'b', 'stm-pipeline-0.1.0', '{}', '{}')"
        )
    run_migrations(eng)
    db = sqlite3.connect(tmp_path / "legacy.sqlite")
    assert db.execute("select version_num from alembic_version").fetchone()[0] == "0002"
    assert db.execute("select pipeline_version from comparisons").fetchone()[0] == "stm-pipeline-0.1.0"
    tables = {r[0] for r in db.execute("select name from sqlite_master where type='table'")}
    assert {"investigations", "photometry_runs", "watchlist_entries", "counterpart_assessments"} <= tables
