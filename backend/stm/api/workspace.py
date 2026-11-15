"""Investigation workspace, watchlists and scientific reports (persistent, shareable by id)."""

from __future__ import annotations

import html
import json
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Response
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from stm import PIPELINE_VERSION
from stm.adapters.base import ArchiveError
from stm.api.observations import adapter
from stm.db import (
    Candidate,
    Comparison,
    CounterpartAssessment,
    Investigation,
    InvestigationItem,
    PhotometryRun,
    WatchCheck,
    WatchlistEntry,
    audit,
    iso,
    session,
)
from stm.science import crossmatch
from stm.science.ranking import CLASS_DESCRIPTIONS

router = APIRouter(prefix="/api", tags=["workspace"])
ITEM_KINDS = ("candidate", "comparison", "region", "spectrum", "observation")


def _new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10].upper()}"


# ------------------------------------------------------------------------------------------ investigations
class InvestigationIn(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    description: str = Field("", max_length=10000)
    owner: str = Field("", max_length=64)
    ra: float | None = Field(None, ge=0, lt=360)
    dec: float | None = Field(None, ge=-90, le=90)
    radius_deg: float | None = Field(None, gt=0, le=10)
    notes: str = Field("", max_length=100000)
    references: list[dict[str, Any]] = Field(default_factory=list, max_length=200)


class InvestigationPatch(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=200)
    description: str | None = Field(None, max_length=10000)
    owner: str | None = Field(None, max_length=64)
    ra: float | None = Field(None, ge=0, lt=360)
    dec: float | None = Field(None, ge=-90, le=90)
    radius_deg: float | None = Field(None, gt=0, le=10)
    notes: str | None = Field(None, max_length=100000)
    references: list[dict[str, Any]] | None = Field(None, max_length=200)


class ItemIn(BaseModel):
    kind: str
    ref_id: str = Field(..., min_length=1, max_length=128)
    label: str = Field("", max_length=200)
    note: str = Field("", max_length=10000)
    payload: dict[str, Any] = Field(default_factory=dict)


def _resolve_item(kind: str, ref_id: str) -> dict[str, Any]:
    """Snapshot of the referenced record, so the investigation stays readable even if data changes."""
    with session() as s:
        if kind == "candidate":
            c = s.scalar(select(Candidate).where(Candidate.id == ref_id))
            if c is None:
                raise HTTPException(404, f"candidate {ref_id} not found")
            return {
                "ra": c.ra,
                "dec": c.dec,
                "machine_class": c.machine_class,
                "quality_tier": c.quality_tier,
                "peak_significance": c.peak_significance,
                "comparison_id": c.comparison_id,
                "pipeline_version": c.pipeline_version,
                "verification_status": c.verification_status,
            }
        if kind == "comparison":
            comp = s.get(Comparison, ref_id)
            if comp is None:
                raise HTTPException(404, f"comparison {ref_id} not found")
            return {
                "ra": comp.ra,
                "dec": comp.dec,
                "detector": comp.detector,
                "product_a": comp.product_a,
                "product_b": comp.product_b,
                "t_a_mjd": comp.t_a_mjd,
                "t_b_mjd": comp.t_b_mjd,
                "status": comp.status,
                "pipeline_version": comp.pipeline_version,
            }
        if kind == "spectrum":
            r = s.get(PhotometryRun, ref_id)
            if r is None:
                raise HTTPException(404, f"spectrophotometry run {ref_id} not found")
            return {"ra": r.ra, "dec": r.dec, "n_points": r.n_points, "status": r.status}
    return {}


def inv_dict(i: Investigation, with_items: bool = True) -> dict[str, Any]:
    d: dict[str, Any] = {
        "id": i.id,
        "title": i.title,
        "description": i.description,
        "owner": i.owner,
        "ra": i.ra,
        "dec": i.dec,
        "radius_deg": i.radius_deg,
        "notes": i.notes,
        "references": i.references,
        "created_at": iso(i.created_at),
        "updated_at": iso(i.updated_at),
        "n_items": len(i.items),
    }
    if with_items:
        d["items"] = [
            {
                "id": it.pk,
                "kind": it.kind,
                "ref_id": it.ref_id,
                "label": it.label,
                "note": it.note,
                "payload": it.payload,
                "added_at": iso(it.added_at),
            }
            for it in sorted(i.items, key=lambda x: x.added_at)
        ]
    return d


@router.get("/investigations")
def list_investigations() -> list[dict[str, Any]]:
    with session() as s:
        return [
            inv_dict(i, with_items=False)
            for i in s.scalars(select(Investigation).order_by(Investigation.updated_at.desc()))
        ]


@router.post("/investigations")
def create_investigation(body: InvestigationIn) -> dict[str, Any]:
    with session() as s:
        i = Investigation(id=_new_id("INV"), **body.model_dump())
        s.add(i)
        s.flush()
        audit(s, "investigation", i.id, "create", body.owner or "anonymous", title=body.title)
        return inv_dict(i)


@router.get("/investigations/{iid}")
def get_investigation(iid: str) -> dict[str, Any]:
    with session() as s:
        i = s.get(Investigation, iid)
        if i is None:
            raise HTTPException(404, "investigation not found")
        return inv_dict(i)


@router.patch("/investigations/{iid}")
def update_investigation(iid: str, body: InvestigationPatch) -> dict[str, Any]:
    with session() as s:
        i = s.get(Investigation, iid)
        if i is None:
            raise HTTPException(404, "investigation not found")
        for k, v in body.model_dump(exclude_unset=True).items():
            setattr(i, k, v)
        i.updated_at = datetime.now(UTC)
        return inv_dict(i)


@router.delete("/investigations/{iid}")
def delete_investigation(iid: str) -> dict[str, Any]:
    with session() as s:
        i = s.get(Investigation, iid)
        if i is None:
            raise HTTPException(404, "investigation not found")
        audit(s, "investigation", iid, "delete", i.owner or "anonymous", title=i.title)
        s.delete(i)
    return {"deleted": iid}


@router.post("/investigations/{iid}/items")
def add_item(iid: str, item: ItemIn) -> dict[str, Any]:
    if item.kind not in ITEM_KINDS:
        raise HTTPException(400, f"kind must be one of {ITEM_KINDS}")
    snapshot = _resolve_item(item.kind, item.ref_id)
    with session() as s:
        i = s.get(Investigation, iid)
        if i is None:
            raise HTTPException(404, "investigation not found")
        if any(it.kind == item.kind and it.ref_id == item.ref_id for it in i.items):
            return inv_dict(i)
        s.add(
            InvestigationItem(
                investigation_id=iid,
                kind=item.kind,
                ref_id=item.ref_id,
                label=item.label,
                note=item.note,
                payload=snapshot | item.payload,
            )
        )
        i.updated_at = datetime.now(UTC)
        s.flush()
        s.refresh(i)
        return inv_dict(i)


@router.delete("/investigations/{iid}/items/{item_id}")
def remove_item(iid: str, item_id: int) -> dict[str, Any]:
    with session() as s:
        it = s.get(InvestigationItem, item_id)
        if it is None or it.investigation_id != iid:
            raise HTTPException(404, "item not found")
        s.delete(it)
        i = s.get(Investigation, iid)
        assert i is not None
        i.updated_at = datetime.now(UTC)
    return get_investigation(iid)


def _collect(iid: str) -> dict[str, Any]:
    inv = get_investigation(iid)
    with session() as s:
        cand_ids = [it["ref_id"] for it in inv["items"] if it["kind"] == "candidate"]
        cands = {c.id: c for c in s.scalars(select(Candidate).where(Candidate.id.in_(cand_ids)))}
        comp_ids = {c.comparison_id for c in cands.values()} | {
            it["ref_id"] for it in inv["items"] if it["kind"] == "comparison"
        }
        comps = {c.id: c for c in s.scalars(select(Comparison).where(Comparison.id.in_(comp_ids)))}
        assess = {}
        for a in s.scalars(
            select(CounterpartAssessment)
            .where(CounterpartAssessment.candidate_id.in_(cand_ids))
            .order_by(CounterpartAssessment.created_at)
        ):
            assess[a.candidate_id] = a
        cand_rows = []
        for cid in cand_ids:
            c = cands.get(cid)
            if c is None:
                continue
            m = c.measurements
            cand_rows.append(
                {
                    "id": c.id,
                    "ra": c.ra,
                    "dec": c.dec,
                    "pos_err_arcsec": m.get("pos_err_arcsec"),
                    "machine_class": c.machine_class,
                    "quality_tier": c.quality_tier,
                    "verification_status": c.verification_status,
                    "peak_significance": c.peak_significance,
                    "diff_flux_ujy": m.get("diff_flux_ujy"),
                    "diff_flux_err_ujy": m.get("diff_flux_err_ujy"),
                    "failed_checks": [q["name"] for q in c.quality_checks if not q["passed"]],
                    "comparison_id": c.comparison_id,
                    "pipeline_version": c.pipeline_version,
                    "counterparts": assess[cid].association if cid in assess else "not assessed",
                }
            )
        comp_rows = [
            {
                "id": c.id,
                "status": c.status,
                "detector": c.detector,
                "product_a": c.product_a,
                "product_b": c.product_b,
                "t_a_mjd": c.t_a_mjd,
                "t_b_mjd": c.t_b_mjd,
                "pipeline_version": c.pipeline_version,
                "psf_method": c.provenance.get("metrics", {}).get("psf_method", "pre-0.2 (header-FWHM Gaussian)"),
                "inputs": [
                    {k: x.get(k) for k in ("product_id", "date_iso", "access_url", "synthetic")}
                    for x in c.provenance.get("inputs", [])
                ],
            }
            for c in comps.values()
        ]
    versions = sorted({str(r["pipeline_version"]) for r in cand_rows} | {str(r["pipeline_version"]) for r in comp_rows})
    return {
        "investigation": inv,
        "candidates": cand_rows,
        "comparisons": comp_rows,
        "pipeline_versions": versions,
        "generated_at": datetime.now(UTC).isoformat(),
        "current_pipeline_version": PIPELINE_VERSION,
    }


@router.get("/investigations/{iid}/export.json")
def export_json(iid: str) -> Response:
    data = _collect(iid)
    return Response(
        json.dumps(data, indent=2, default=str),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{iid}.json"'},
    )


@router.get("/investigations/{iid}/export.md")
def export_md(iid: str) -> Response:
    d = _collect(iid)
    inv = d["investigation"]
    lines = [
        f"# {inv['title']}",
        "",
        f"*Investigation {inv['id']} · generated {d['generated_at']}*",
        "",
        inv["description"] or "",
        "",
    ]
    if inv["ra"] is not None:
        lines += [f"**Region:** RA {inv['ra']:.5f}°, Dec {inv['dec']:.5f}°, radius {inv['radius_deg'] or 0:.3f}°", ""]
    lines += [
        "## Candidates",
        "",
        "| ID | Class (machine) | Tier | Peak | ΔF (µJy) | Verification | Counterparts |",
        "|---|---|---|---|---|---|---|",
    ]
    for c in d["candidates"]:
        lines.append(
            f"| {c['id']} | {c['machine_class']} | {c['quality_tier']} | {c['peak_significance']:+.1f}σ | "
            f"{(c['diff_flux_ujy'] or 0):.0f} ± {(c['diff_flux_err_ujy'] or 0):.0f} | "
            f"{c['verification_status']} | {c['counterparts']} |"
        )
    lines += ["", "## Comparisons", ""]
    for c in d["comparisons"]:
        lines.append(
            f"- {c['id']}: {c['product_a']} → {c['product_b']} (detector {c['detector']}, "
            f"{c['pipeline_version']}, PSF: {c['psf_method']})"
        )
    lines += ["", "## Notes", "", inv["notes"] or "_none_", "", "## References", ""]
    lines += [
        f"- {r.get('title') or r.get('bibcode') or r.get('url')}" + (f" — {r['url']}" if r.get("url") else "")
        for r in inv["references"]
    ] or ["_none_"]
    lines += [
        "",
        "---",
        "All candidates are machine detections from SPHEREx DR1 images (NASA/IPAC IRSA). None is a "
        "confirmed discovery unless its verification status says so.",
    ]
    return Response(
        "\n".join(lines),
        media_type="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="{iid}.md"'},
    )


@router.get("/investigations/{iid}/report.html", response_class=HTMLResponse)
def report_html(iid: str) -> HTMLResponse:
    d = _collect(iid)
    inv = d["investigation"]
    e = html.escape

    def tr(cells: list[Any]) -> str:
        return "<tr>" + "".join(f"<td>{e(str(x))}</td>" for x in cells) + "</tr>"

    cand_rows = "".join(
        tr(
            [
                c["id"],
                c["machine_class"],
                c["quality_tier"],
                f"{c['peak_significance']:+.1f}σ",
                f"{(c['diff_flux_ujy'] or 0):.1f} ± {(c['diff_flux_err_ujy'] or 0):.1f}",
                f"{c['pos_err_arcsec'] or 0:.1f}″",
                ", ".join(c["failed_checks"]) or "none",
                c["counterparts"],
                c["verification_status"],
            ]
        )
        for c in d["candidates"]
    )
    obs_rows = "".join(
        tr([x["product_id"], x["date_iso"], x["access_url"], "SYNTHETIC" if x.get("synthetic") else "archive"])
        for c in d["comparisons"]
        for x in c["inputs"]
    )
    comp_rows = "".join(
        tr([c["id"], c["detector"], c["product_a"], c["product_b"], c["pipeline_version"], c["psf_method"]])
        for c in d["comparisons"]
    )
    refs = (
        "".join(
            f"<li>{e(r.get('title') or r.get('bibcode') or '')} {e(r.get('url') or '')}</li>" for r in inv["references"]
        )
        or "<li>None recorded.</li>"
    )
    classes = "".join(f"<li><b>{e(k)}</b>: {e(v)}</li>" for k, v in CLASS_DESCRIPTIONS.items())
    assoc = "".join(f"<li><b>{e(k)}</b>: {e(v)}</li>" for k, v in crossmatch.CLASS_TEXT.items())
    body = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{e(inv["title"])} — Sky Time Machine report</title>
<style>body{{font:14px/1.5 system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#111}}
h1{{font-size:1.6rem}}h2{{font-size:1.15rem;border-bottom:1px solid #ccc;padding-bottom:.2rem;margin-top:2rem}}
table{{border-collapse:collapse;width:100%;font-size:12px}}td,th{{border:1px solid #ddd;padding:4px 6px;text-align:left;vertical-align:top}}
th{{background:#f4f4f4}}.note{{background:#fff8e1;border:1px solid #f0d58c;padding:.6rem .8rem}}code{{font-size:12px}}</style></head><body>
<h1>{e(inv["title"])}</h1>
<p>Investigation <code>{e(inv["id"])}</code> · owner {e(inv["owner"] or "—")} · report generated {e(d["generated_at"])}</p>
<p class="note"><b>Status of findings:</b> preliminary. Every candidate below is a machine detection in archival
SPHEREx images. None is a confirmed discovery unless its verification status says so.</p>
<h2>1. Overview</h2><p>{e(inv["description"] or "No description.")}</p>
<p>Region: {e(f"RA {inv['ra']:.5f}°, Dec {inv['dec']:.5f}°, radius {inv['radius_deg'] or 0:.3f}°" if inv["ra"] is not None else "not set")}</p>
<h2>2. Observation provenance</h2><table><tr><th>Product</th><th>Mid-exposure (UTC)</th><th>Archive URL</th><th>Kind</th></tr>{obs_rows or tr(["—", "—", "—", "—"])}</table>
<p>Data: NASA/IPAC Infrared Science Archive (IRSA), SPHEREx DR1 Level 2 spectral images.</p>
<h2>3. Processing methodology</h2><table><tr><th>Comparison</th><th>Detector</th><th>Epoch A</th><th>Epoch B</th><th>Pipeline</th><th>PSF matching</th></tr>{comp_rows or tr(["—"] * 6)}</table>
<p>Images were resampled to a common grid, compared only where both epochs observed the same wavelength (within half a
bandwidth), background-corrected (archive ZODI model plus a fitted plane), PSF-matched (EPSF cross-convolution from
pipeline 0.2.0) and differenced. Detections are 5σ excursions of the significance map. Pipeline versions in this
report: {e(", ".join(d["pipeline_versions"]) or "—")} (current: {e(d["current_pipeline_version"])}).</p>
<h2>4. Measurements and uncertainty</h2><table><tr><th>Candidate</th><th>Machine class</th><th>Tier</th><th>Peak</th><th>ΔF (µJy)</th><th>σ pos</th><th>Failed checks</th><th>Counterparts</th><th>Verification</th></tr>{cand_rows or tr(["—"] * 9)}</table>
<p>Uncertainties are 1σ, propagated from archive VARIANCE and rescaled to the observed noise. Aperture errors ignore
pixel covariance introduced by resampling and PSF matching.</p>
<h2>5. Classification</h2><p>Machine classes are rule-based labels, not identifications:</p><ul>{classes}</ul>
<p>Counterpart associations are positional only:</p><ul>{assoc}</ul>
<h2>6. Research notes</h2><pre style="white-space:pre-wrap">{e(inv["notes"] or "None.")}</pre>
<h2>7. Limitations</h2><ul><li>Detection completeness and purity for SPHEREx have not been measured.</li>
<li>PSF matching is evaluated once per field; bright sources can leave residuals.</li>
<li>Epoch fluxes inside extended emission use a biased local background.</li>
<li>No candidate has independent confirmation unless stated.</li></ul>
<h2>8. References</h2><ul>{refs}<li>SPHEREx archive documentation: https://caltech-ipac.github.io/spherex-archive-documentation/</li>
<li>Sky Time Machine methodology: docs/SCIENTIFIC_METHODOLOGY.md</li></ul>
</body></html>"""
    return HTMLResponse(body)


# ------------------------------------------------------------------------------------------ watchlists
class WatchIn(BaseModel):
    kind: str = Field(..., pattern="^(region|candidate|investigation)$")
    label: str = Field("", max_length=200)
    ref_id: str | None = Field(None, max_length=64)
    ra: float | None = Field(None, ge=0, lt=360)
    dec: float | None = Field(None, ge=-90, le=90)
    radius_deg: float = Field(0.01, gt=0, le=0.5)


def watch_dict(w: WatchlistEntry) -> dict[str, Any]:
    return {
        "id": w.id,
        "kind": w.kind,
        "label": w.label,
        "ref_id": w.ref_id,
        "ra": w.ra,
        "dec": w.dec,
        "radius_deg": w.radius_deg,
        "n_known_products": len(w.known_products),
        "created_at": iso(w.created_at),
        "last_checked_at": iso(w.last_checked_at),
        "last_new_count": w.last_new_count,
        "checks": [
            {
                "checked_at": iso(c.checked_at),
                "status": c.status,
                "n_products": c.n_products,
                "new_products": c.new_products,
                "message": c.message,
            }
            for c in sorted(w.checks, key=lambda c: c.checked_at, reverse=True)[:10]
        ],
    }


@router.get("/watchlists")
def list_watchlists() -> list[dict[str, Any]]:
    with session() as s:
        return [watch_dict(w) for w in s.scalars(select(WatchlistEntry).order_by(WatchlistEntry.created_at.desc()))]


@router.post("/watchlists")
def create_watch(body: WatchIn) -> dict[str, Any]:
    ra, dec = body.ra, body.dec
    with session() as s:
        if body.kind == "candidate":
            c = s.scalar(select(Candidate).where(Candidate.id == body.ref_id))
            if c is None:
                raise HTTPException(404, "candidate not found")
            ra, dec = c.ra, c.dec
        elif body.kind == "investigation":
            i = s.get(Investigation, body.ref_id or "")
            if i is None or i.ra is None:
                raise HTTPException(400, "investigation not found or has no region")
            ra, dec = i.ra, i.dec
    if ra is None or dec is None:
        raise HTTPException(400, "ra and dec are required for region watches")
    with session() as s:
        w = WatchlistEntry(
            id=_new_id("WL"),
            kind=body.kind,
            label=body.label or body.ref_id or f"{ra:.4f},{dec:.4f}",
            ref_id=body.ref_id,
            ra=ra,
            dec=dec,
            radius_deg=body.radius_deg,
            known_products=[],
        )
        s.add(w)
    return check_watch(w.id, baseline=True)


@router.delete("/watchlists/{wid}")
def delete_watch(wid: str) -> dict[str, Any]:
    with session() as s:
        w = s.get(WatchlistEntry, wid)
        if w is None:
            raise HTTPException(404, "watch not found")
        s.delete(w)
    return {"deleted": wid}


@router.post("/watchlists/{wid}/check")
def check_watch(wid: str, baseline: bool = Query(False)) -> dict[str, Any]:
    """Re-query the archive and report products not seen at the previous check.

    SPHEREx data are released in batches (weekly quick releases, periodic data releases),
    so a "new" product means newly *released*, not newly observed in real time.
    """
    with session() as s:
        w = s.get(WatchlistEntry, wid)
        if w is None:
            raise HTTPException(404, "watch not found")
        ra, dec, rad, known = w.ra, w.dec, w.radius_deg, set(w.known_products)
    try:
        recs = adapter().query_position(ra, dec, rad, fresh=True)
        ids = sorted(r.product_id for r in recs)
        new = [] if baseline else [i for i in ids if i not in known]
        status, msg = "ok", ("baseline recorded" if baseline else f"{len(new)} newly released product(s)")
    except ArchiveError as e:
        ids, new, status, msg = sorted(known), [], "failed", str(e)
    with session() as s:
        w = s.get(WatchlistEntry, wid)
        assert w is not None
        if status == "ok":
            w.known_products = ids
            w.last_new_count = len(new)
        w.last_checked_at = datetime.now(UTC)
        s.add(WatchCheck(entry_id=wid, status=status, n_products=len(ids), new_products=new, message=msg))
        s.flush()
        s.refresh(w)
        return watch_dict(w)


@router.get("/saved/candidates")
def saved_candidates() -> list[dict[str, Any]]:
    """Candidates referenced by any investigation or watchlist (for the explorer's saved-candidates layer)."""
    with session() as s:
        refs: dict[str, list[str]] = {}
        for it in s.scalars(select(InvestigationItem).where(InvestigationItem.kind == "candidate")):
            refs.setdefault(it.ref_id, []).append(it.investigation_id)
        for w in s.scalars(select(WatchlistEntry).where(WatchlistEntry.kind == "candidate")):
            if w.ref_id:
                refs.setdefault(w.ref_id, []).append(w.id)
        rows = s.scalars(select(Candidate).where(Candidate.id.in_(list(refs)))).all()
        return [
            {"id": c.id, "ra": c.ra, "dec": c.dec, "machine_class": c.machine_class, "saved_in": refs[c.id]}
            for c in rows
        ]
