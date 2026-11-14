"""Coverage-map counting with SYNTHETIC exposure headers (known answers)."""

from __future__ import annotations

import numpy as np
from astropy.io import fits
from synthetic import make_wcs

from stm.adapters.base import ObservationRecord
from stm.science.coverage import coverage_grid

RA, DEC = 120.0, -10.0


class FakeCoverageAdapter:
    """Six exposures: two visits on day 0 (4 exposures, minutes apart) and two exposures 180 days later.

    Detector 1 only; every exposure covers the whole field. Wavelength at the field centre depends on
    the header's raw-coordinate offset (CRPIX2W), so we can control which pairs match spectrally.
    """

    def __init__(self) -> None:
        self.recs = []
        self.headers = {}
        # (t_mjd, wavelength offset in raw-y pixels) — LUT gradient is 1e-4 um/px
        plan = [(61000.000, 0), (61000.002, 0), (61000.004, 300), (61000.006, 300), (61180.0, 0), (61180.002, 1500)]
        for k, (t, dy) in enumerate(plan):
            pid = f"SYNTHETIC-{k:02d}D1"
            w = make_wcs(RA, DEC, 200)
            h = w.to_header()
            h.update(
                {
                    "NAXIS1": 200,
                    "NAXIS2": 200,
                    "MJD-AVG": t,
                    "CRPIX1W": 1.0,
                    "CRPIX2W": 1.0 - dy,
                    "CRVAL1W": 1.0,
                    "CRVAL2W": 1.0,
                    "CDELT1W": 1.0,
                    "CDELT2W": 1.0,
                    "L1DQAFLG": "Pass",
                }
            )
            self.headers[pid] = h
            self.recs.append(
                ObservationRecord(
                    "SYNTHETIC",
                    "synthetic",
                    pid,
                    f"SYNTHETIC-{k:02d}",
                    1,
                    "D1",
                    None,
                    None,
                    t,
                    t + 0.001,
                    100.0,
                    RA,
                    DEC,
                    "",
                    f"synthetic://{pid}",
                )
            )
        grid = np.linspace(1, 3000, 9)
        gy = np.meshgrid(grid, grid, indexing="ij")[0]
        wave = 0.9 + 1e-4 * gy
        self.lut = {"x": grid.tolist(), "y": grid.tolist(), "values": np.stack([wave, wave / 40], -1).tolist()}

    def query_position(self, ra, dec, radius_deg=0.01, collection=None, fresh=False):
        return list(self.recs)

    def fetch_headers(self, recs, workers=8):
        return {r.product_id: fits.Header(self.headers[r.product_id]) for r in recs}

    def fetch_wavelength_lookup(self, rec):
        return self.lut


def test_images_exposures_visits_and_pairs_are_distinct():
    c = coverage_grid(FakeCoverageAdapter(), RA, DEC, size_deg=0.2, cells=5)  # type: ignore[arg-type]
    L = {k: np.array(v) for k, v in c["layers"].items() if k != "pairs_by_detector"}
    centre = (2, 2)
    assert L["images"][centre] == 6 and L["exposures"][centre] == 6
    assert L["visits"][centre] == 2  # four exposures within minutes are ONE visit; two more 180 d later
    assert L["detectors"][centre] == 1
    # Matched pairs need >= 0.5 d baseline and |dλ| <= 0.5 bandwidth:
    # exposures 0,1 (offset 0) pair with 4 (offset 0) -> 2 pairs; offsets 300 px (0.03 um) and 1500 px do not match.
    assert L["pairs"][centre] == 2
    assert c["n_products_queried"] == 6 and c["skipped"] == {"no_header": 0, "dqa_fail": 0}
