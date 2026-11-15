"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { type Assessment, type CounterpartResult, get, type Job, pollJob, post, type SpectroRun } from "@/lib/api";
import { ASSOCIATION_LABEL, fmtDate } from "@/lib/astro";
import { LightCurvePanel } from "./LightCurvePanel";
import { PsfKernel } from "./PsfKernel";
import { Button, Checks, ErrorNote, f, inputCls, KindBadge, Panel, Progress, Stat, Tag } from "./ui";

export function DataKindLegend() {
  const items: [string, string, "original" | "muted" | "derived" | "good" | "text"][] = [
    ["Raw observation", "Archive Level 2 pixels (shown resampled)", "original"],
    ["Processed data", "Resampled, background-subtracted, PSF-matched images", "muted"],
    ["Derived measurement", "Computed by Sky Time Machine from those pixels", "derived"],
    ["Rule-based assessment", "Deterministic checks on stored measurements", "good"],
    ["AI explanation", "Assistant text — never a measurement", "text"],
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-muted" aria-label="Data kinds">
      <span>Key</span>
      {items.map(([l, d, t]) => <span key={l} title={d} className="flex items-center gap-1.5"><Tag tone={t}>{l}</Tag></span>)}
    </div>
  );
}

export function AssessmentPanel({ id }: { id: string }) {
  const [a, setA] = useState<Assessment | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { get<Assessment>(`/api/candidates/${id}/assessment`).then(setA).catch((e) => setErr(e.message)); }, [id]);
  if (err) return <Panel title="Explainable assessment"><ErrorNote error={err} /></Panel>;
  if (!a) return <Panel title="Explainable assessment"><Progress value={0.4} /></Panel>;
  return (
    <Panel title="Explainable assessment" right={<Tag tone="good">Rule-based</Tag>}>
      <div className="flex flex-col gap-4 text-[13px]">
        <section>
          <h3 className="text-[12px] font-semibold text-text mb-1">Why was it detected?</h3>
          <p>{a.why_detected.text}</p>
        </section>
        <section>
          <h3 className="text-[12px] font-semibold text-text mb-1">Which measurements support it?</h3>
          <ul className="grid sm:grid-cols-2 gap-x-6 gap-y-1 text-[12px] num">
            {a.supporting_measurements.map((m) => (
              <li key={m.name} className="flex gap-2 border-b border-line/60 py-0.5"><span className="font-sans text-faint w-40 shrink-0">{m.name}</span>
                <span>{Array.isArray(m.value) ? m.value.map((v: number | null) => f(v, 4)).join(" / ") : f(m.value, 2)}{m.error != null ? ` ± ${f(m.error, 2)}` : ""} {m.unit}</span></li>
            ))}
          </ul>
        </section>
        <section className="grid md:grid-cols-2 gap-4">
          <div><h3 className="text-[12px] font-semibold text-text mb-1">Artifact checks passed ({a.checks_passed.length})</h3><Checks checks={a.checks_passed} /></div>
          <div><h3 className="text-[12px] font-semibold text-text mb-1">Artifact checks failed ({a.checks_failed.length})</h3>
            {a.checks_failed.length ? <Checks checks={a.checks_failed} /> : <p className="text-[12px] text-muted">None.</p>}
            {a.comparison_checks_failed.length > 0 && <><h4 className="text-[11px] text-faint mt-2">Comparison-level</h4><Checks checks={a.comparison_checks_failed} /></>}
          </div>
        </section>
        <section>
          <h3 className="text-[12px] font-semibold text-text mb-1">What remains uncertain?</h3>
          <ul className="list-disc pl-5 text-[12px] text-muted flex flex-col gap-1">{a.remaining_uncertainties.map((u) => <li key={u}>{u}</li>)}</ul>
        </section>
        <p className="text-[11px] text-faint">Classification rule — {a.classification.rule}</p>
      </div>
    </Panel>
  );
}

export function PsfPanel({ id }: { id: string }) {
  const [a, setA] = useState<Assessment | null>(null);
  useEffect(() => { get<Assessment>(`/api/candidates/${id}/assessment`).then(setA).catch(() => {}); }, [id]);
  const p = a?.psf;
  return (
    <Panel title="PSF matching" right={<KindBadge kind="derived" />}>
      {!p ? <Progress value={0.3} /> : (
        <div className="flex flex-col gap-3 text-[12px]">
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Method" value={p.psf_method === "epsf_cross" ? "EPSF cross-convolution" : (p.psf_method ?? "pre-0.2: none")} />
            <Stat label="Effective FWHM" value={f(p.psf_fwhm_effective_arcsec, 2)} unit="″" />
            <Stat label="Header FWHM A / B" value={`${f(p.psf_fwhm_a_arcsec, 2)} / ${f(p.psf_fwhm_b_arcsec, 2)}`} unit="″" />
            <Stat label="Noise rescaling" value={`×${f(p.noise_rescale_factor, 2)}`} />
            {p.psf_mismatch_tv != null && <Stat label="PSF difference (TV)" value={f(p.psf_mismatch_tv, 3)} />}
            {p.rotation_a_deg != null && <Stat label="Detector PA A / B" value={`${f(p.rotation_a_deg, 1)}° / ${f(p.rotation_b_deg, 1)}°`} />}
          </div>
          {p.kernel_a && p.kernel_b ? (
            <div className="flex gap-4 items-end"><PsfKernel k={p.kernel_a} label="PSF A" /><PsfKernel k={p.kernel_b} label="PSF B" />
              <p className="text-[11px] text-faint flex-1">Archive EPSFs at the field centre on the comparison grid. Each epoch was convolved with the other&apos;s PSF.</p></div>
          ) : <p className="text-[11px] text-faint">No PSF kernels stored: this comparison predates EPSF matching (pipeline {a?.processing_history.pipeline_version}).</p>}
        </div>
      )}
    </Panel>
  );
}

export function CounterpartsPanel({ id }: { id: string }) {
  const [r, setR] = useState<CounterpartResult | null>(null);
  const [radius, setRadius] = useState(15);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    // Show a stored cross-match without querying external catalogues.
    get<CounterpartResult>(`/api/candidates/${id}/counterparts?radius_arcsec=15&cached_only=true`).then(setR).catch(() => {});
  }, [id]);
  async function run(refresh = false) {
    setBusy(true); setErr(null);
    try { setR(await get<CounterpartResult>(`/api/candidates/${id}/counterparts?radius_arcsec=${radius}${refresh ? "&refresh=true" : ""}`)); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <Panel title="Known counterparts" right={<KindBadge kind="derived" />}>
      <div className="flex flex-wrap items-center gap-2 text-[12px] mb-2">
        <label className="flex items-center gap-1 text-muted">Search radius <input type="number" min={1} max={120} value={radius} onChange={(e) => setRadius(Number(e.target.value))} className={`${inputCls} w-16 num`} />″</label>
        <Button onClick={() => run(false)} disabled={busy}>{busy ? "Querying SIMBAD & Gaia…" : r ? "Re-load" : "Cross-match"}</Button>
        {r && <Button variant="ghost" onClick={() => run(true)} disabled={busy}>Refresh from catalogues</Button>}
      </div>
      <ErrorNote error={err} />
      {!r && !busy && <p className="text-[12px] text-muted">Queries SIMBAD and Gaia DR3 around the candidate and compares separations with the combined positional uncertainty. Results are stored with their provenance.</p>}
      {r && (
        <div className="flex flex-col gap-3 text-[12px]">
          <div className="border-l-2 border-text pl-3 py-1"><b>{ASSOCIATION_LABEL[r.association]}</b> — <span className="text-muted">{r.explanation}</span></div>
          {Object.entries(r.catalogs).map(([name, c]) => (
            <section key={name}>
              <h3 className="flex flex-wrap gap-2 items-baseline text-[12px]"><span className="font-medium">{name}</span>
                <span className={c.status === "ok" ? "text-muted" : "text-warn"}>{c.status === "ok" ? ASSOCIATION_LABEL[c.association] : `service unavailable — ${c.message}`}</span>
                <span className="text-faint num ml-auto">chance-alignment expectation {c.expected_chance.toFixed(3)} · {c.density_per_arcmin2.toFixed(1)}/arcmin² · {c.service?.split("/")[2] ?? "—"}{c.cached ? " (cached)" : ""}</span></h3>
              {c.counterparts.length > 0 ? (
                <div className="overflow-x-auto"><table className="w-full text-[11px] num mt-1 [&_td]:px-1.5 [&_th]:px-1.5 [&_td:first-child]:pl-0 [&_th:first-child]:pl-0">
                  <thead className="text-muted text-left"><tr><th className="font-normal">Identifier</th><th className="font-normal">Type</th><th className="font-normal text-right">Sep</th><th className="font-normal text-right">σ_pos (cat)</th><th className="font-normal text-right">n σ</th><th className="font-normal">Reference</th></tr></thead>
                  <tbody>{c.counterparts.slice(0, 10).map((x) => (
                    <tr key={x.id} className={`border-t border-line/60 ${x.within_3sigma ? "" : "text-faint"}`}>
                      <td>{x.url ? <a className="text-text underline decoration-line-strong hover:text-accent" href={x.url} target="_blank" rel="noreferrer">{x.id}</a> : x.id}</td><td>{x.type ?? "—"}</td>
                      <td className="text-right">{x.sep_arcsec.toFixed(2)}″</td><td className="text-right">{x.pos_err_arcsec != null ? `${x.pos_err_arcsec.toFixed(3)}″` : "—"}</td>
                      <td className="text-right">{x.n_sigma.toFixed(1)}</td><td className="max-w-[9rem] truncate" title={x.reference ?? ""}>{x.reference ?? "—"}</td>
                    </tr>))}</tbody>
                </table></div>
              ) : c.status === "ok" && <p className="text-muted">No source within {r.radius_arcsec}″.</p>}
            </section>
          ))}
          <p className="text-[11px] text-faint">{r.method} Candidate positional σ = {r.candidate_err_arcsec.toFixed(1)}″. Assessed {r.assessed_at.slice(0, 16).replace("T", " ")}.</p>
        </div>
      )}
    </Panel>
  );
}

export function HistoryPanel({ id, ra, dec, detector, epochs }: { id: string; ra: number; dec: number; detector: number | null; epochs: { x: number; label: string }[] }) {
  const [run, setRun] = useState<SpectroRun | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [channel, setChannel] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    get<SpectroRun[]>(`/api/spectra/runs?candidate_id=${id}`).then(async (rs) => {
      const done = rs.find((r) => r.status === "done");
      if (done) return setRun(await get<SpectroRun>(`/api/spectra/runs/${done.id}`));
      const active = rs.find((r) => r.status === "queued" || r.status === "running");
      if (active?.params?.job_id) {
        const j = await pollJob(active.params.job_id, setJob, 1500);
        if (j.status === "done") setRun(await get<SpectroRun>(`/api/spectra/runs/${active.id}`));
      }
    }).catch(() => {});
  }, [id]);
  async function measure() {
    setErr(null);
    try {
      const r = await post<{ run_id: string; job_id: string | null }>("/api/spectra/runs", { ra, dec, detectors: detector ? [detector] : null, candidate_id: id, label: `Candidate ${id}` });
      if (r.job_id) { const j = await pollJob(r.job_id, setJob, 1500); if (j.status === "failed") throw new Error(j.message); }
      setRun(await get<SpectroRun>(`/api/spectra/runs/${r.run_id}`));
    } catch (e: any) { setErr(e.message); }
  }
  const ok = (run?.points ?? []).filter((p) => p.status === "ok");
  return (
    <div className="flex flex-col gap-4">
      <Panel title="Spectral & historical measurements" right={<KindBadge kind="derived" />}>
        <ErrorNote error={err} />
        {!run && !job && (
          <div className="flex flex-wrap items-center gap-3 text-[12px]">
            <p className="text-muted flex-1 min-w-[240px]">Measure this position in every archive exposure of detector {detector ?? "—"} (~0.4 MB of pixels per exposure). The results feed the light curve below and the Spectra page.</p>
            <Button variant="primary" onClick={measure}>Measure all epochs</Button>
          </div>
        )}
        {job && job.status !== "done" && <Progress value={job.progress} label={job.message} />}
        {run && (
          <div className="flex flex-wrap gap-4 text-[12px]">
            <Stat label="Exposures measured" value={run.provenance?.n_exposures ?? "—"} />
            <Stat label="Usable measurements" value={ok.length} />
            <Stat label="Channels" value={new Set(ok.map((p) => p.channel).filter((c) => c != null)).size} sub={ok.some((p) => p.channel == null) ? `${ok.filter((p) => p.channel == null).length} outside channel ranges` : undefined} />
            <Stat label="First / last" value={ok.length ? `${fmtDate(Math.min(...ok.map((p) => p.t_mid_mjd)), false)} / ${fmtDate(Math.max(...ok.map((p) => p.t_mid_mjd)), false)}` : "—"} />
            <Link className="self-end text-text underline decoration-line-strong hover:text-accent" href={`/spectra?run=${run.id}&cand=${id}`}>Open in Spectra</Link>
          </div>
        )}
      </Panel>
      {run && <LightCurvePanel runId={run.id} channel={channel} onChannel={setChannel} highlight={epochs} />}
    </div>
  );
}
