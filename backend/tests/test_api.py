"""API tests. Archive access is replaced by a fake adapter serving SYNTHETIC files."""

from __future__ import annotations

import time

import numpy as np
import pytest
from fastapi.testclient import TestClient
from synthetic import Src, write_mef

import stm.api.candidates as api_candidates
import stm.api.comparisons as api_comparisons
import stm.api.observations as api_observations
from stm.adapters.base import ObservationRecord
from stm.adapters.spherex import SpherexAdapter
from stm.main import app

RA, DEC = 150.0, 2.0
STARS = [Src(RA + 0.02, DEC + 0.01, 3.0), Src(RA - 0.03, DEC - 0.02, 1.5)]
NEW = Src(RA - 0.015, DEC + 0.025, 1.2)


class FakeAdapter(SpherexAdapter):
    """Serves SYNTHETIC files instead of contacting IRSA."""

    def __init__(self, tmp_path):
        super().__init__()
        self.files = {
            "SYNTHETIC-0001_1D1": write_mef(
                tmp_path / "a.fits",
                ra=RA,
                dec=DEC,
                sources=STARS,
                t_mjd=61000.0,
                seed=1,
                product_id="SYNTHETIC-0001_1D1",
            ),
            "SYNTHETIC-0002_1D1": write_mef(
                tmp_path / "b.fits",
                ra=RA,
                dec=DEC,
                sources=STARS + [NEW],
                t_mjd=61030.0,
                seed=2,
                product_id="SYNTHETIC-0002_1D1",
            ),
        }
        self.times = {"SYNTHETIC-0001_1D1": 61000.0, "SYNTHETIC-0002_1D1": 61030.0}

    def query_position(self, ra, dec, radius_deg=0.01):
        return [
            ObservationRecord(
                "SYNTHETIC",
                "synthetic",
                pid,
                pid[:-2],
                1,
                "SPHEREx-D1",
                0.75,
                1.1,
                t,
                t + 0.001,
                112.0,
                RA,
                DEC,
                "",
                f"synthetic://{pid}",
            )
            for pid, t in self.times.items()
        ]

    def fetch_cutout(self, record, ra, dec, size_deg):
        return self.files[record.product_id]


@pytest.fixture
def client(tmp_path, monkeypatch):
    fake = FakeAdapter(tmp_path)
    for mod in (api_observations, api_comparisons, api_candidates):
        monkeypatch.setattr(mod, "adapter", lambda: fake)
    with TestClient(app) as c:
        yield c


def wait_job(client, job_id, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = client.get(f"/api/jobs/{job_id}").json()
        if j["status"] in ("done", "failed"):
            return j
        time.sleep(0.1)
    raise TimeoutError(job_id)


def test_health(client):
    r = client.get("/api/health").json()
    assert r["status"] == "ok" and r["pipeline_version"].startswith("stm-pipeline")


def test_observations_timeline(client):
    r = client.get("/api/observations", params={"ra": RA, "dec": DEC}).json()
    assert r["n_exposures"] == 2
    assert r["coverage_gaps"][0]["days"] == pytest.approx(30.0, abs=0.01)


def test_validation_errors(client):
    assert client.get("/api/observations", params={"ra": 400, "dec": 0}).status_code == 422
    bad = {"ra": RA, "dec": DEC, "product_a": "SYNTHETIC-0001_1D1", "product_b": "SYNTHETIC-0001_1D1"}
    assert client.post("/api/comparisons", json=bad).status_code == 400
    assert client.get("/api/comparisons/CMP-NOPE").status_code == 404
    assert client.get("/api/candidates/ST-0000-000000").status_code == 404


def test_full_comparison_flow(client):
    body = {"ra": RA, "dec": DEC, "size_deg": 0.1, "product_a": "SYNTHETIC-0001_1D1", "product_b": "SYNTHETIC-0002_1D1"}
    r = client.post("/api/comparisons", json=body).json()
    job = wait_job(client, r["job_id"])
    assert job["status"] == "done", job["message"]
    cid = r["comparison_id"]

    comp = client.get(f"/api/comparisons/{cid}").json()
    assert comp["status"] == "done"
    prov = comp["provenance"]
    assert prov["software"]["pipeline"].startswith("stm-pipeline")
    assert [i["product_id"] for i in prov["inputs"]] == ["SYNTHETIC-0001_1D1", "SYNTHETIC-0002_1D1"]
    assert all(i["synthetic"] is True for i in prov["inputs"])  # synthetic inputs are labelled as such
    assert prov["layers"]["a"]["kind"] == "original" and prov["layers"]["diff"]["kind"] == "derived"
    cands = [c for c in comp["candidates"] if not c["rejected"]]
    assert len(cands) == 1
    cand_id = cands[0]["id"]
    assert cand_id.startswith("ST-")

    # Re-submitting identical inputs returns the stored comparison (reproducible id).
    again = client.post("/api/comparisons", json=body).json()
    assert again["comparison_id"] == cid and again["job_id"] is None

    # Binary layer
    lr = client.get(f"/api/comparisons/{cid}/layers/significance")
    rows, cols = map(int, lr.headers["X-Shape"].split(","))
    arr = np.frombuffer(lr.content, "<f4").reshape(rows, cols)
    assert np.nanmax(arr) > 5
    assert lr.headers["X-Layer-Kind"] == "derived"
    # FITS download with provenance keywords
    fr = client.get(f"/api/comparisons/{cid}/fits/diff")
    assert fr.content.startswith(b"SIMPLE") and b"STM_KIND" in fr.content

    # Candidate detail
    c = client.get(f"/api/candidates/{cand_id}").json()
    assert c["verification_status"] == "unverified"
    assert c["machine_class"] == "new_source_candidate"
    assert "Ranked by quality tier" in c["rank_explanation"]

    # Community: annotations never change verification status
    for kind in ("interesting", "interesting", "interesting"):
        assert (
            client.post("/api/annotations", json={"target_id": cand_id, "author": "tester", "kind": kind}).status_code
            == 200
        )
    assert client.get(f"/api/candidates/{cand_id}").json()["verification_status"] == "unverified"
    held = client.post(
        "/api/annotations",
        json={"target_id": cand_id, "author": "spam", "kind": "note", "body": "see http://example.com"},
    ).json()
    assert held["status"] == "pending"
    summary = client.get(f"/api/annotations/summary/{cand_id}").json()
    assert summary["counts"]["interesting"] == 3

    # Moderation requires the token
    assert (
        client.post(
            f"/api/annotations/{held['id']}/moderate", json={"action": "approve", "reason": "ok link"}
        ).status_code
        == 403
    )
    ok = client.post(
        f"/api/annotations/{held['id']}/moderate",
        json={"action": "approve", "reason": "ok link"},
        headers={"X-Moderator-Token": "test-moderator-token"},
    )
    assert ok.status_code == 200 and ok.json()["status"] == "visible"

    # Verification needs an explicit reviewer action
    assert (
        client.post(
            f"/api/candidates/{cand_id}/verification",
            json={"status": "under_review", "reviewer": "rev", "reason": "needs follow-up"},
        ).status_code
        == 403
    )
    v = client.post(
        f"/api/candidates/{cand_id}/verification",
        json={"status": "under_review", "reviewer": "rev", "reason": "needs follow-up"},
        headers={"X-Moderator-Token": "test-moderator-token"},
    )
    assert v.json()["verification_status"] == "under_review"
    audit = client.get("/api/audit", params={"target_id": cand_id}).json()
    assert any(e["action"] == "verification_change" for e in audit)

    # Listing and tracking
    lst = client.get("/api/candidates", params={"ra": RA, "dec": DEC, "radius": 0.2}).json()
    assert cand_id in [x["id"] for x in lst["candidates"]]
    tr = client.post("/api/tracks", json={"ra": RA, "dec": DEC, "radius_deg": 0.2}).json()
    assert any(cand_id in t["members"] for t in tr["tracks"])

    # Assistant (rule-based in tests) grounds its answer in the candidate
    a = client.post(
        "/api/assistant/chat", json={"question": "Why was this flagged?", "context": {"candidate_id": cand_id}}
    ).json()
    assert a["mode"] == "rule-based"
    assert cand_id in a["answer"] and a["grounding"]["candidate"] == cand_id


def test_assistant_without_data(client):
    a = client.post("/api/assistant/chat", json={"question": "What changed?", "context": {"ra": 1.0, "dec": -50.0}})
    assert a.status_code == 200
    assert "No processed comparisons" in a.json()["answer"]
