"""Positional cross-matching of candidates against catalogue sources.

Angular proximity is not physical association. Each counterpart is scored by
its normalised separation r = sep / sigma, where sigma = sqrt(sigma_cand^2 +
sigma_cat^2), and the candidate as a whole gets one of four classes:

* confirmed_positional — exactly one counterpart within 3 sigma, and fewer than
  0.05 unrelated sources of that catalogue are expected inside the 3 sigma circle,
  given the catalogue's density in the search cone. Positions agree; this does
  not mean the candidate *is* that object.
* possible — counterpart(s) within 3 sigma, but more than one, or a chance
  coincidence is not unlikely (expected >= 0.05).
* inconclusive — counterparts only beyond 3 sigma inside the search radius, or
  a catalogue service failed.
* none — every queried catalogue answered and none has a source in the search radius.
"""

from __future__ import annotations

import math
from typing import Any

N_SIGMA = 3.0
CHANCE_MAX = 0.05
DEFAULT_CAT_ERR_ARCSEC = 0.1  # used when a catalogue row has no positional error

CLASS_TEXT = {
    "confirmed_positional": "Positionally confirmed: one counterpart within 3σ and a chance alignment is unlikely "
    "(< 5 %). Positions agree; physical identity is not established.",
    "possible": "Possible association: counterpart(s) within 3σ, but several candidates or a non-negligible chance "
    "alignment.",
    "inconclusive": "Inconclusive: no counterpart within 3σ (only farther sources in the search radius), or a "
    "catalogue could not be queried.",
    "none": "No known counterpart in the queried catalogues within the search radius. This does not make the "
    "candidate a new object.",
}


def score_counterparts(
    rows: list[dict[str, Any]], cand_err_arcsec: float, radius_arcsec: float, truncated: bool = False
) -> dict[str, Any]:
    """Annotate catalogue rows with normalised separations and compute the chance expectation."""
    scored = []
    for r in rows:
        sep = r.get("sep_arcsec")
        if sep is None:
            continue
        cat_err = r.get("pos_err_arcsec") or DEFAULT_CAT_ERR_ARCSEC
        sigma = math.hypot(cand_err_arcsec, cat_err)
        scored.append(
            r | {"sigma_arcsec": sigma, "n_sigma": float(sep) / sigma, "within_3sigma": float(sep) <= N_SIGMA * sigma}
        )
    density = len(rows) / (math.pi * radius_arcsec**2) if radius_arcsec > 0 else 0.0  # per arcsec^2
    match_radius = N_SIGMA * math.hypot(cand_err_arcsec, DEFAULT_CAT_ERR_ARCSEC)
    expected_chance = density * math.pi * match_radius**2
    scored.sort(key=lambda r: r["n_sigma"])
    return {
        "rows": scored,
        "density_per_arcmin2": density * 3600.0,
        "expected_chance": expected_chance,
        "match_radius_arcsec": match_radius,
        "truncated": truncated,
    }


def classify_catalog(scored: dict[str, Any], status: str) -> str:
    if status != "ok":
        return "inconclusive"
    rows = scored["rows"]
    if not rows:
        return "none"
    inside = [r for r in rows if r["within_3sigma"]]
    if not inside:
        return "inconclusive"
    # A truncated result only gives a lower bound on source density, so chance alignment cannot be excluded.
    if len(inside) == 1 and scored["expected_chance"] < CHANCE_MAX and not scored.get("truncated"):
        return "confirmed_positional"
    return "possible"


ORDER = {"confirmed_positional": 0, "possible": 1, "inconclusive": 2, "none": 3}


def combine(classes: dict[str, str]) -> str:
    """Overall class: best evidence wins, but any failure prevents a 'none' verdict."""
    vals = list(classes.values())
    if not vals:
        return "inconclusive"
    best = min(vals, key=lambda c: ORDER[c])
    if best == "none" and any(v == "inconclusive" for v in vals):
        return "inconclusive"
    return best
