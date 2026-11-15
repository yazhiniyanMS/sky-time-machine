"""Replaceable assistant providers.

* AnthropicProvider: Claude via the official Anthropic SDK (server-side key).
* RuleBasedProvider: deterministic, no network; summarises the grounded
  context. Used when no API key is configured so the app keeps working.
"""

from __future__ import annotations

import json
import logging
import os
from abc import ABC, abstractmethod
from typing import Any

from stm.config import get_settings

log = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are Sky Intelligence, the astronomy assistant inside Sky Time Machine, a tool for comparing \
NASA/IPAC SPHEREx Level 2 spectral images taken at different times.

You answer only from the JSON context supplied with each question (pipeline measurements, quality checks, \
provenance and excerpts of the project's methodology documents) plus general astronomy knowledge.

Rules:
- Separate clearly what is MEASURED (numbers present in the context, quote them with units and uncertainties) from \
what is INTERPRETATION or HYPOTHESIS. Use the headings "Measured" and "Interpretation" when both apply.
- Every candidate is unverified unless its verification_status says otherwise. Never call a candidate a confirmed \
supernova, asteroid, variable star or discovery. Machine classes are rule-based labels, not identifications.
- State uncertainty explicitly: significance in sigma, flux errors, positional error, failed quality checks, and the \
known limitations (approximate Gaussian PSF matching, undersampled PSF, resampling-correlated noise, SPHEREx \
wavelength varying across the detector).
- If the context does not contain what is needed, say so and suggest what the user can run in the app (choose a \
spectrally matched pair, run a comparison, run forced photometry, build tracks).
- Every factual statement about a measurement, observation or catalogue object must cite the supporting record by
  its reference in square brackets, using only refs from the context's "citations" list (e.g. [ST-2026-000002],
  [2025W28_2A_0263_3D1]). If no record supports a statement, say so instead of answering from memory.
- Angular proximity to a catalogue object is not physical association; "confirmed_positional" only means the
  positions agree.
- Light-curve scatter is not variability unless the stored chi-square test says it is significant.
- Never declare a discovery. You explain evidence; you do not produce measurements.
- Be concise: short paragraphs or bullet lists, no more than about 250 words unless asked for detail."""


class AssistantProvider(ABC):
    name: str

    @abstractmethod
    def answer(self, question: str, history: list[dict[str, str]], context: dict[str, Any]) -> dict[str, Any]: ...


class AnthropicProvider(AssistantProvider):
    name = "anthropic"

    def __init__(self, model: str, api_key: str | None = None):
        import anthropic

        self.model = model
        # api_key=None lets the SDK resolve credentials from the environment.
        self.client = anthropic.Anthropic(api_key=api_key or None)

    def answer(self, question: str, history: list[dict[str, str]], context: dict[str, Any]) -> dict[str, Any]:
        import anthropic

        msgs: list[dict[str, Any]] = [
            {"role": m["role"], "content": m["content"]}
            for m in history[-10:]
            if m.get("role") in ("user", "assistant") and m.get("content")
        ]
        while msgs and msgs[0]["role"] != "user":
            msgs.pop(0)
        msgs.append(
            {
                "role": "user",
                "content": "Context (JSON, from the Sky Time Machine database and docs):\n"
                + json.dumps(context, default=str)[:60000]
                + "\n\nQuestion: "
                + question,
            }
        )
        try:
            request: dict[str, Any] = {
                "model": self.model,
                "max_tokens": 4000,
                "system": [{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
                "messages": msgs,
                "output_config": {"effort": "medium"},
                # Server-side refusal fallback, routed by refusal category.
                "betas": ["server-side-fallback-2026-07-01"],
                "fallbacks": "default",
            }
            resp = self.client.beta.messages.create(**request)
        except anthropic.AuthenticationError as e:
            raise AssistantUnavailable("LLM provider rejected the API key") from e
        except anthropic.RateLimitError as e:
            raise AssistantUnavailable("LLM provider rate limit reached; try again shortly") from e
        except anthropic.APIStatusError as e:
            raise AssistantUnavailable(f"LLM provider error ({e.status_code})") from e
        except anthropic.APIConnectionError as e:
            raise AssistantUnavailable("Could not reach the LLM provider") from e
        if resp.stop_reason == "refusal":
            return {"answer": "The model declined to answer this request.", "mode": "llm", "model": resp.model}
        text = "".join(b.text for b in resp.content if b.type == "text")
        return {"answer": text, "mode": "llm", "model": resp.model, "stop_reason": resp.stop_reason}


class AssistantUnavailable(RuntimeError):
    pass


class RuleBasedProvider(AssistantProvider):
    """Deterministic fallback. It does not interpret; it reports stored measurements."""

    name = "rule-based"

    def answer(self, question: str, history: list[dict[str, str]], context: dict[str, Any]) -> dict[str, Any]:
        q = question.lower()
        lines: list[str] = []
        cand = context.get("selected_candidate")
        comp = context.get("comparison")
        cands = (comp or {}).get("candidates") or context.get("region_candidates") or []

        def describe(c: dict[str, Any]) -> list[str]:
            m = c["measurements"]
            out = [
                f"**{c['id']}** — machine class `{c['machine_class']}`, quality tier {c['quality_tier']}, "
                f"verification: {c['verification_status']}.",
                f"- Peak difference significance: {c['peak_significance']:+.1f}σ",
            ]
            if m.get("diff_flux_ujy") is not None:
                out.append(
                    f"- Difference flux: {m['diff_flux_ujy']:+.1f} ± {m.get('diff_flux_err_ujy', float('nan')):.1f} µJy"
                )
            if m.get("flux_a_ujy") is not None and m.get("flux_b_ujy") is not None:
                out.append(
                    f"- Epoch A flux {m['flux_a_ujy']:.1f} ± {m.get('flux_a_err_ujy', 0):.1f} µJy; "
                    f"epoch B {m['flux_b_ujy']:.1f} ± {m.get('flux_b_err_ujy', 0):.1f} µJy"
                )
            if m.get("wave_a_um"):
                out.append(f"- Wavelength A/B: {m['wave_a_um']:.4f} / {m.get('wave_b_um') or float('nan'):.4f} µm")
            if m.get("pos_err_arcsec"):
                out.append(f"- Positional uncertainty: {m['pos_err_arcsec']:.1f}″")
            if c["failed_checks"]:
                out.append("- Failed quality checks: " + "; ".join(c["failed_checks"]))
            else:
                out.append("- All quality checks passed.")
            return out

        if cand:
            lines.append("### Measured (selected candidate)")
            lines += describe(cand)
            lines.append("")
            lines.append("### Why it was flagged / ranked")
            lines.append(cand["rank_explanation"])
            if any(k in q for k in ("artifact", "real", "fake", "spurious")):
                failed = cand["failed_checks"]
                lines.append("")
                lines.append("### Artifact assessment (rule-based)")
                lines.append(
                    "Failed checks point to possible artifacts: " + "; ".join(failed)
                    if failed
                    else "No quality check failed, which lowers but does not remove the chance of an artifact. "
                    "Independent confirmation (another epoch at the same wavelength) is required."
                )
        elif comp:
            s = comp.get("summary") or {}
            lines.append("### Measured (current comparison)")
            lines.append(
                f"Comparison {comp['id']} ({comp['status']}): {comp['epoch_a']['product']} → "
                f"{comp['epoch_b']['product']}, baseline {s.get('baseline_days', 0):.2f} days."
            )
            lines.append(
                f"{s.get('n_candidates', 0)} candidates ({s.get('n_tier_a', 0)} tier A, "
                f"{s.get('n_rejected', 0)} rejected)."
            )
            for c in cands[:5]:
                lines.append("")
                lines += describe(c)
            if comp.get("failed_quality_checks"):
                lines.append("")
                lines.append(
                    "Comparison-level checks that failed: "
                    + "; ".join(q["detail"] for q in comp["failed_quality_checks"])
                )
        elif cands:
            lines.append(f"### Measured ({len(cands)} non-rejected candidates in this region)")
            for c in cands[:5]:
                lines.append("")
                lines += describe(c)
        else:
            lines.append(
                "No processed comparisons or candidates are available for the current view. Open the "
                "Timeline, pick a spectrally matched pair of observations, and run a comparison first."
            )
        lines += self._research_sections(q, context)
        docs = context.get("documentation") or []
        if docs:
            lines.append("")
            lines.append("### Relevant methodology")
            for d in docs[:2]:
                snippet = " ".join(d["text"].split()[:70])
                lines.append(f"- *{d['source']}*: {snippet}…")
        cites = context.get("citations") or []
        if cites:
            lines.append("")
            lines.append("### Sources")
            for c in cites[:12]:
                lines.append(f"- [{c['ref']}] {c['kind']}" + (f" — {c['url']}" if c.get("url") else ""))
        lines.append("")
        lines.append(
            "_Rule-based summary: no LLM is configured (set ANTHROPIC_API_KEY on the server for "
            "natural-language answers). Only stored measurements are reported; no interpretation is added._"
        )
        return {"answer": "\n".join(lines), "mode": "rule-based", "model": None}

    @staticmethod
    def _research_sections(q: str, ctx: dict[str, Any]) -> list[str]:
        out: list[str] = []
        comp = ctx.get("comparison") or {}
        met = comp.get("metrics") or {}
        if "psf" in q and met:
            out += ["", "### PSF matching (stored comparison metrics)"]
            if met.get("psf_method") == "epsf_cross":
                rot_a = (met.get("psf_a") or {}).get("rotation_deg", 0)
                rot_b = (met.get("psf_b") or {}).get("rotation_deg", 0)
                out.append(
                    "EPSF cross-convolution: each epoch was convolved with the other epoch's archive EPSF, resampled "
                    f"to the comparison grid. PSF difference (total variation) {met.get('psf_mismatch_tv', 0):.3f}; "
                    f"effective FWHM {met.get('psf_fwhm_effective_arcsec', 0):.2f}″; detector position angles "
                    f"{rot_a:.1f}° / {rot_b:.1f}°; noise rescale ×{met.get('noise_rescale_factor', 1):.2f} "
                    f"[{comp.get('id')}]."
                )
            else:
                out.append(
                    f"Method: {met.get('psf_method', 'pre-0.2 header-FWHM Gaussian or none')} [{comp.get('id')}]."
                )
        cp = ctx.get("counterparts")
        if any(w in q for w in ("counterpart", "catalog", "catalogue", "known", "simbad", "gaia")):
            out += ["", "### Known counterparts (positional)"]
            if not cp:
                out.append("Cross-matching has not been run for this candidate (Known Counterparts panel on its page).")
            else:
                out.append(
                    f"Overall: **{cp['association']}** within {cp['radius_arcsec']}″ (positions only; not a physical "
                    "association)."
                )
                for name, c in cp["catalogs"].items():
                    near = c.get("nearest") or []
                    first = (
                        (
                            f"nearest {near[0].get('id')} at {near[0].get('sep_arcsec', 0):.1f}″ "
                            f"({near[0].get('n_sigma', 0):.1f}σ) [{near[0].get('id')}]"
                        )
                        if near
                        else "no sources"
                    )
                    out.append(f"- {name}: {c.get('association')} (service {c.get('status')}); {first}")
        sp = ctx.get("spectrophotometry")
        if any(w in q for w in ("brightness", "light curve", "lightcurve", "epoch", "variab", "spectr", "flux")):
            out += ["", "### Repeated measurements"]
            if not sp:
                out.append("No spectrophotometry run exists for this position yet (Spectra page → Measure).")
            else:
                out.append(
                    f"Run [{sp['run_id']}]: {sp['n_ok_measurements']} measurements in {sp['n_channels_measured']} "
                    f"official channels from {sp.get('n_exposures')} exposures."
                )
                lc = sp.get("light_curve_candidate_channel")
                if lc:
                    out.append(
                        f"- Candidate channel {lc['channel']}: {lc.get('n_points')} points, {lc.get('n_visits')} "
                        f"visits; weighted mean {lc.get('weighted_mean_ujy') or 0:.1f} ± "
                        f"{lc.get('weighted_mean_err_ujy') or 0:.1f} µJy; verdict **{lc.get('verdict')}**. "
                        f"{lc.get('explanation', '')}"
                    )
        sim = ctx.get("similar_candidates")
        if sim:
            out += ["", "### Candidates with similar measured properties", f"Metric: {sim['metric']}"]
            out += [
                f"- [{c['id']}] {c['machine_class']}, {c['peak_significance']:+.1f}σ, tier {c['quality_tier']} "
                f"(distance {c['distance']})"
                for c in sim["items"]
            ] or ["- none stored"]
        inv = ctx.get("investigation")
        if inv and any(w in q for w in ("investigation", "summar")):
            out += [
                "",
                f"### Investigation [{inv['id']}] — {inv['title']}",
                inv["description"] or "(no description)",
                f"{len(inv['items'])} saved item(s): "
                + ", ".join(f"{i['kind']} {i['ref_id']}" for i in inv["items"][:15]),
            ]
            if inv["notes"]:
                out.append("Notes (excerpt): " + inv["notes"][:400])
        if any(w in q for w in ("most significant", "find", "unusual", "strongest")) and ctx.get("region_candidates"):
            out += ["", "### Most significant non-rejected candidates in view (tier, then |σ|)"]
            out += [
                f"- [{c['id']}] {c['peak_significance']:+.1f}σ, tier {c['quality_tier']}, {c['machine_class']}"
                for c in ctx["region_candidates"][:8]
            ]
        return out


def get_provider() -> AssistantProvider:
    s = get_settings()
    want = s.assistant_provider.lower()
    if want == "none":
        return RuleBasedProvider()
    has_key = bool(s.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
    if want == "anthropic" or (want == "auto" and has_key):
        try:
            return AnthropicProvider(s.assistant_model, s.anthropic_api_key or None)
        except Exception as e:  # noqa: BLE001 - SDK missing or misconfigured
            log.warning("Anthropic provider unavailable (%s); using rule-based assistant", e)
    return RuleBasedProvider()
