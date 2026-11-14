"""Machine classification and explainable ranking of change candidates.

Classes are *candidate* labels derived from explicit measurement rules; none
of them is a confirmed astrophysical identification.

Ranking is lexicographic and fully explainable:
  1. quality tier (A: all checks pass, B: warnings only, R: rejected)
  2. |peak significance| of the difference, descending
No probability or "confidence score" is invented.
"""

from __future__ import annotations

from typing import Any

from stm.science.detection import Detection
from stm.science.fitsio import CheckResult

CLASS_DESCRIPTIONS = {
    "variable_candidate": "Brightness change at a position with significant (≥ 5σ) aperture flux in both "
    "epochs. In extended emission (galaxies, nebulae) this flux may be diffuse light, "
    "not a point source.",
    "new_source_candidate": "Brightening where epoch A shows no significant flux (< 3σ) and epoch B does (≥ 5σ). "
    "Could be a transient, a moving object, or an artifact.",
    "disappeared_source_candidate": "Fading where epoch A shows significant flux (≥ 5σ) and epoch B does not (< 3σ). "
    "Could be a moving object's earlier position, a fading transient, or an artifact.",
    "possible_moving_object_pair": "A new-source and a disappeared-source candidate in the same comparison, "
    "separated by more than 2 FWHM; consistent with (not proof of) motion.",
    "subtraction_residual": "Change accompanied by an opposite-sign residual or on a bright source with a small "
    "fractional change; most likely PSF/registration residual.",
    "uncertain_change": "Significant change that does not fit the rules above.",
}


def classify(det: Detection, checks: list[CheckResult]) -> str:
    failed_warn = {c.name for c in checks if not c.passed}
    if {"dipole", "bright_source_residual"} & failed_warn:
        return "subtraction_residual"
    if det.sign > 0 and det.snr_a < 3 and det.snr_b >= 5:
        return "new_source_candidate"
    if det.sign < 0 and det.snr_b < 3 and det.snr_a >= 5:
        return "disappeared_source_candidate"
    if det.snr_a >= 5 and det.snr_b >= 5:
        return "variable_candidate"
    return "uncertain_change"


def mark_moving_pairs(items: list[dict[str, Any]], min_sep_fwhm: float = 2.0) -> None:
    """Annotate new/disappeared pairs within one comparison (in place)."""
    news = [i for i in items if i["machine_class"] == "new_source_candidate"]
    gones = [i for i in items if i["machine_class"] == "disappeared_source_candidate"]
    for n in news:
        for g in gones:
            dn, dg = n["detection"], g["detection"]
            fwhm_pix = dn.extra["fwhm_arcsec"] / (dn.extra.get("pixscale_arcsec") or 6.15)
            sep_pix = ((dn.x - dg.x) ** 2 + (dn.y - dg.y) ** 2) ** 0.5
            if sep_pix > min_sep_fwhm * fwhm_pix:
                n.setdefault("pair_with", []).append(g["key"])
                g.setdefault("pair_with", []).append(n["key"])
    for i in items:
        if i.get("pair_with"):
            i["machine_class"] = "possible_moving_object_pair"


def quality_tier(checks: list[CheckResult]) -> str:
    if any((not c.passed) and c.severity == "error" for c in checks):
        return "R"
    if any((not c.passed) and c.severity == "warning" for c in checks):
        return "B"
    return "A"


TIER_ORDER = {"A": 0, "B": 1, "R": 2}


def rank_key(tier: str, peak_significance: float) -> tuple[int, float]:
    return TIER_ORDER[tier], -abs(peak_significance)


def explain(det: Detection, tier: str, checks: list[CheckResult], machine_class: str) -> str:
    failed = [c for c in checks if not c.passed]
    parts = [
        f"Peak difference significance {det.peak_significance:+.1f}σ; aperture difference flux "
        f"{det.diff_flux_ujy:+.1f} ± {det.diff_flux_err_ujy:.1f} µJy (S/N {det.snr:.1f}).",
        f"Epoch A flux {det.flux_a_ujy:.1f} ± {det.flux_a_err_ujy:.1f} µJy, "
        f"epoch B {det.flux_b_ujy:.1f} ± {det.flux_b_err_ujy:.1f} µJy.",
        f"Quality tier {tier}: "
        + (
            "all quality checks passed."
            if not failed
            else "failed " + ", ".join(f"{c.name} ({c.severity})" for c in failed) + "."
        ),
        f"Machine class '{machine_class}' by rule: {CLASS_DESCRIPTIONS[machine_class]}",
        "Ranked by quality tier, then by |peak significance|.",
    ]
    return " ".join(parts)
