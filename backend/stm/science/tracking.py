"""Cross-comparison association of candidates ("tracking").

Inputs are candidates from any number of comparisons in a region. Two
detections are *positionally consistent* when their separation is below
``n_sigma`` times the combined positional uncertainty. Association does not
assume that consistent detections are the same physical object; the output
labels describe what the measurements support:

* ``stationary_repeated``   — ≥2 detections from different epoch pairs at a
                              consistent position.
* ``potential_moving_object`` — ≥3 detections at distinct times that are
                              mutually inconsistent in position but fit a
                              constant-velocity track within uncertainties.
* ``single_detection``      — no consistent partner; association uncertain.
"""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass, field
from typing import Any


@dataclass
class TrackInput:
    candidate_id: str
    ra: float
    dec: float
    pos_err_arcsec: float
    t_mjd: float  # epoch the signal belongs to (B for brightening, A for fading)
    comparison_id: str
    sign: int
    diff_flux_ujy: float
    wave_um: float | None = None


@dataclass
class Track:
    kind: str
    members: list[str]
    metrics: dict[str, Any] = field(default_factory=dict)


def sep_arcsec(ra1: float, dec1: float, ra2: float, dec2: float) -> float:
    r1, d1, r2, d2 = map(math.radians, (ra1, dec1, ra2, dec2))
    s = math.sin((d2 - d1) / 2) ** 2 + math.cos(d1) * math.cos(d2) * math.sin((r2 - r1) / 2) ** 2
    return math.degrees(2 * math.asin(min(1.0, math.sqrt(s)))) * 3600.0


def _tangent_offsets(ra0: float, dec0: float, ra: float, dec: float) -> tuple[float, float]:
    """Gnomonic offsets (arcsec) of (ra, dec) about (ra0, dec0)."""
    a0, d0, a, d = map(math.radians, (ra0, dec0, ra, dec))
    cosc = math.sin(d0) * math.sin(d) + math.cos(d0) * math.cos(d) * math.cos(a - a0)
    xi = math.cos(d) * math.sin(a - a0) / cosc
    eta = (math.cos(d0) * math.sin(d) - math.sin(d0) * math.cos(d) * math.cos(a - a0)) / cosc
    return math.degrees(xi) * 3600.0, math.degrees(eta) * 3600.0


def associate(items: list[TrackInput], n_sigma: float = 3.0, max_rate_arcsec_per_hr: float = 3600.0) -> list[Track]:
    n = len(items)
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, j in itertools.combinations(range(n), 2):
        a, b = items[i], items[j]
        if a.comparison_id == b.comparison_id:
            continue
        tol = n_sigma * math.hypot(a.pos_err_arcsec, b.pos_err_arcsec)
        if sep_arcsec(a.ra, a.dec, b.ra, b.dec) <= tol:
            parent[find(i)] = find(j)

    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)

    tracks: list[Track] = []
    singles: list[int] = []
    for idx in groups.values():
        if len(idx) >= 2:
            mem = [items[i] for i in idx]
            seps = [
                sep_arcsec(x.ra, x.dec, y.ra, y.dec) / math.hypot(x.pos_err_arcsec, y.pos_err_arcsec)
                for x, y in itertools.combinations(mem, 2)
            ]
            ra_m = sum(m.ra for m in mem) / len(mem)
            dec_m = sum(m.dec for m in mem) / len(mem)
            tracks.append(
                Track(
                    "stationary_repeated",
                    [m.candidate_id for m in mem],
                    {
                        "n_detections": len(mem),
                        "max_separation_sigma": max(seps),
                        "mean_ra": ra_m,
                        "mean_dec": dec_m,
                        "epochs_mjd": sorted({m.t_mjd for m in mem}),
                        "signs": [m.sign for m in mem],
                        "diff_flux_ujy": [m.diff_flux_ujy for m in mem],
                    },
                )
            )
        else:
            singles.append(idx[0])

    # Constant-velocity linking among single detections (needs >= 3 distinct epochs).
    used: set[int] = set()
    cand = [i for i in singles if items[i].sign > 0]
    for i, j, k in itertools.combinations(sorted(cand, key=lambda q: items[q].t_mjd), 3):
        if {i, j, k} & used:
            continue
        p, q, r = items[i], items[j], items[k]
        if len({round(p.t_mjd, 3), round(q.t_mjd, 3), round(r.t_mjd, 3)}) < 3:
            continue
        x1, y1 = 0.0, 0.0
        x2, y2 = _tangent_offsets(p.ra, p.dec, q.ra, q.dec)
        x3, y3 = _tangent_offsets(p.ra, p.dec, r.ra, r.dec)
        dt12 = (q.t_mjd - p.t_mjd) * 24.0
        dt13 = (r.t_mjd - p.t_mjd) * 24.0
        vx, vy = (x2 - x1) / dt12, (y2 - y1) / dt12
        rate = math.hypot(vx, vy)
        if rate == 0 or rate > max_rate_arcsec_per_hr:
            continue
        px, py = vx * dt13, vy * dt13
        resid = math.hypot(px - x3, py - y3)
        tol = n_sigma * math.sqrt(p.pos_err_arcsec**2 + q.pos_err_arcsec**2 + r.pos_err_arcsec**2)
        moved = math.hypot(x2, y2) > n_sigma * math.hypot(p.pos_err_arcsec, q.pos_err_arcsec)
        if moved and resid <= tol:
            used |= {i, j, k}
            tracks.append(
                Track(
                    "potential_moving_object",
                    [p.candidate_id, q.candidate_id, r.candidate_id],
                    {
                        "rate_arcsec_per_hr": rate,
                        "pa_deg": (math.degrees(math.atan2(vx, vy)) + 360) % 360,
                        "prediction_residual_arcsec": resid,
                        "tolerance_arcsec": tol,
                        "epochs_mjd": [p.t_mjd, q.t_mjd, r.t_mjd],
                    },
                )
            )
    for i in singles:
        if i in used:
            continue
        m = items[i]
        tracks.append(Track("single_detection", [m.candidate_id], {"epochs_mjd": [m.t_mjd]}))
    return tracks
