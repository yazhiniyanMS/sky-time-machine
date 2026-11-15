"""Light-curve statistics for repeated SPHEREx measurements of one source in one channel.

Only measurements in the same official channel (same detector, same wavelength
range) are combined, so spectral slope is not mistaken for variability.

Two different questions are answered separately:

* *Measured variability* — the scatter of the measurements (standard
  deviation, relative scatter), which always exists because of noise.
* *Statistically significant variability* — a chi-square test of the
  constant-flux hypothesis using each point's uncertainty, inflated by a
  fractional systematic floor (default 2 %, covering residual calibration
  differences between exposures). Significant only if p < alpha (default 1e-3).

With fewer than three good measurements no variability statement is made.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
from scipy.stats import chi2 as chi2_dist


@dataclass
class LightCurveConfig:
    systematic_frac: float = 0.02
    alpha: float = 1e-3
    min_points: int = 3
    epoch_gap_days: float = 0.5  # exposures closer than this belong to one visit
    missing_gap_days: float = 30.0  # gaps longer than this are reported as missing coverage

    def to_dict(self) -> dict[str, Any]:
        return dict(self.__dict__)


def visits(times: np.ndarray, gap: float) -> np.ndarray:
    """Visit index for each time: consecutive exposures separated by < gap days share a visit."""
    order = np.argsort(times)
    vis = np.zeros(len(times), int)
    k = 0
    for i in range(1, len(order)):
        if times[order[i]] - times[order[i - 1]] >= gap:
            k += 1
        vis[order[i]] = k
    return vis


def light_curve_stats(t: Any, f: Any, e: Any, cfg: LightCurveConfig | None = None) -> dict[str, Any]:
    cfg = cfg or LightCurveConfig()
    t, f, e = (np.asarray(x, float) for x in (t, f, e))
    good = np.isfinite(t) & np.isfinite(f) & np.isfinite(e) & (e > 0)
    t, f, e = t[good], f[good], e[good]
    n = len(f)
    out: dict[str, Any] = {"n_points": n, "config": cfg.to_dict()}
    if n == 0:
        out["verdict"] = "no_data"
        return out
    vis = visits(t, cfg.epoch_gap_days)
    out["n_visits"] = int(vis.max() + 1)
    out["time_span_days"] = float(t.max() - t.min())
    srt = np.sort(t)
    gaps = np.diff(srt)
    out["coverage_gaps"] = [
        {"from_mjd": float(srt[i]), "to_mjd": float(srt[i + 1]), "days": float(gaps[i])}
        for i in np.where(gaps > cfg.missing_gap_days)[0]
    ]
    w = 1.0 / e**2
    wmean = float(np.sum(w * f) / np.sum(w))
    out.update(
        {
            "mean_ujy": float(np.mean(f)),
            "weighted_mean_ujy": wmean,
            "weighted_mean_err_ujy": float(1.0 / np.sqrt(np.sum(w))),
            "median_ujy": float(np.median(f)),
            "std_ujy": float(np.std(f, ddof=1)) if n > 1 else None,
            "median_error_ujy": float(np.median(e)),
        }
    )
    out["relative_scatter"] = (
        float(out["std_ujy"] / abs(out["mean_ujy"])) if out["std_ujy"] is not None and out["mean_ujy"] else None
    )
    if n < cfg.min_points:
        out["verdict"] = "insufficient_data"
        out["explanation"] = f"{n} good measurement(s); at least {cfg.min_points} are needed for a variability test."
        return out
    e_tot = np.sqrt(e**2 + (cfg.systematic_frac * abs(wmean)) ** 2)
    wt = 1.0 / e_tot**2
    wmean_t = float(np.sum(wt * f) / np.sum(wt))
    chi2 = float(np.sum(((f - wmean_t) / e_tot) ** 2))
    dof = n - 1
    p = float(chi2_dist.sf(chi2, dof))
    out.update({"chi2": chi2, "dof": dof, "reduced_chi2": chi2 / dof, "p_value_constant": p})
    # Fractional excess variance (Vaughan et al. 2003) — only meaningful when positive
    s2 = float(np.var(f, ddof=1))
    mse = float(np.mean(e_tot**2))
    excess = s2 - mse
    out["fractional_excess_variance"] = float(np.sqrt(excess) / abs(wmean_t)) if excess > 0 and wmean_t else None
    out["max_deviation_sigma"] = float(np.max(np.abs(f - wmean_t) / e_tot))
    if p < cfg.alpha:
        out["verdict"] = "significant_variability"
        out["explanation"] = (
            f"Constant flux rejected: χ²={chi2:.1f} for {dof} dof (p={p:.2g} < {cfg.alpha}), with a "
            f"{cfg.systematic_frac:.0%} systematic floor added to each error. This is a statistical statement about "
            "these measurements, not an astrophysical classification."
        )
    else:
        out["verdict"] = "no_significant_variability"
        out["explanation"] = (
            f"Scatter is consistent with the uncertainties: χ²={chi2:.1f} for {dof} dof (p={p:.2g}). Measured "
            "scatter alone is not evidence of variability."
        )
    return out
