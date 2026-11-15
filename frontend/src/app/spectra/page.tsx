"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { LightCurvePanel } from "@/components/LightCurvePanel";
import { Plot, type PlotPoint, type Series } from "@/components/Plot";
import { SearchBox } from "@/components/SearchBox";
import { Button, ErrorNote, inputCls, KindBadge, Panel, Progress } from "@/components/ui";
import { API, type CandidateDetail, type CubeSpectrum, get, type Job, type PhotPoint, pollJob, post, type SpectroRun } from "@/lib/api";
import { BANDS, decDms, DETECTOR_COLORS, fmtDate, raHms, SERIES } from "@/lib/astro";

function visitsOf(points: PhotPoint[], gap = 0.5): Map<string, number> {
  const t = [...new Set(points.map((p) => p.t_mid_mjd))].sort((a, b) => a - b);
  const out = new Map<string, number>();
  let k = 0;
  t.forEach((v, i) => { if (i > 0 && v - t[i - 1] >= gap) k++; out.set(String(v), k); });
  return out;
}

function SpectraPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const [pos, setPos] = useState<{ ra: number; dec: number } | null>(null);
  const [cand, setCand] = useState<CandidateDetail | null>(null);
  const [cube, setCube] = useState<CubeSpectrum | null>(null);
  const [cubeErr, setCubeErr] = useState<string | null>(null);
  const [runs, setRuns] = useState<SpectroRun[]>([]);
  const [run, setRun] = useState<SpectroRun | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dets, setDets] = useState<number[]>([1, 2, 3, 4, 5, 6]);
  const [maxExp, setMaxExp] = useState<string>("");
  const [logY, setLogY] = useState(false);
  const [quantity, setQuantity] = useState<"aperture" | "pointsource">("aperture");
  const [colorBy, setColorBy] = useState<"detector" | "visit">("detector");
  const [hiddenVisits, setHiddenVisits] = useState<Set<number>>(new Set());
  const [channel, setChannel] = useState<number | null>(sp.get("channel") ? Number(sp.get("channel")) : null);
  const [showTable, setShowTable] = useState(false);

  // position from ?cand, ?ra/dec or ?run
  useEffect(() => {
    const c = sp.get("cand"), runId = sp.get("run");
    const ra = sp.get("ra"), dec = sp.get("dec");
    if (runId) {
      get<SpectroRun>(`/api/spectra/runs/${runId}`).then((r) => { setRun(r); setPos({ ra: r.ra, dec: r.dec }); }).catch((e) => setErr(e.message));
    } else if (c) {
      get<CandidateDetail>(`/api/candidates/${c}`).then((d) => { setCand(d); setPos({ ra: d.ra, dec: d.dec }); if (d.comparison.detector) setDets([d.comparison.detector]); }).catch((e) => setErr(e.message));
    } else if (ra && dec) setPos({ ra: Number(ra), dec: Number(dec) });
  }, [sp]);

  useEffect(() => {
    if (!pos) return;
    setCube(null); setCubeErr(null);
    get<CubeSpectrum>(`/api/spectra/cube?ra=${pos.ra}&dec=${pos.dec}`).then(setCube).catch((e) => setCubeErr(e.message));
    get<SpectroRun[]>(`/api/spectra/runs?ra=${pos.ra}&dec=${pos.dec}&radius_arcsec=3`).then((rs) => {
      setRuns(rs);
      if (!sp.get("run") && rs.length && rs[0].status === "done") get<SpectroRun>(`/api/spectra/runs/${rs[0].id}`).then(setRun);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos?.ra, pos?.dec]);

  async function measure() {
    if (!pos) return;
    setErr(null); setJob(null);
    try {
      const r = await post<{ run_id: string; job_id: string | null; status: string }>("/api/spectra/runs", {
        ra: pos.ra, dec: pos.dec, detectors: dets.length === 6 ? null : dets, max_exposures: maxExp ? Number(maxExp) : null,
        candidate_id: cand?.id ?? null, label: cand ? `Candidate ${cand.id}` : null,
      });
      if (r.job_id) {
        const j = await pollJob(r.job_id, setJob, 1500);
        if (j.status === "failed") throw new Error(j.message);
      }
      const full = await get<SpectroRun>(`/api/spectra/runs/${r.run_id}`);
      setRun(full);
      router.replace(`/spectra?run=${r.run_id}${cand ? `&cand=${cand.id}` : ""}`, { scroll: false });
    } catch (e: any) { setErr(e.message); }
  }

  const ok = useMemo(() => (run?.points ?? []).filter((p) => p.status === "ok" && p.wave_um != null), [run]);
  const missing = useMemo(() => (run?.points ?? []).filter((p) => p.status !== "ok" || p.quality === "bad"), [run]);
  const vis = useMemo(() => visitsOf(run?.points ?? []), [run]);
  const nVisits = vis.size ? Math.max(...vis.values()) + 1 : 0;

  const cubeSeries: Series[] = [1, 2, 3, 4, 5, 6].map((d) => ({ key: `D${d}`, label: `D${d} ${BANDS[d]}`, color: DETECTOR_COLORS[d], line: true }));
  const cubePts: PlotPoint[] = (cube?.channels ?? []).filter((c) => !c.missing && c.surface_brightness_mjy_sr != null).map((c) => ({
    x: c.wave_um, y: c.surface_brightness_mjy_sr!, xErr: c.bandwidth_um / 2, series: `D${c.detector}`,
    label: `D${c.detector}:${String(c.subchannel).padStart(2, "0")}  ${c.wave_um.toFixed(3)} µm  ${c.surface_brightness_mjy_sr!.toPrecision(4)} MJy/sr  NHITS ${c.nhits}`,
  }));

  const visitSeries: Series[] = Array.from({ length: Math.min(nVisits, 7) }, (_, i) => ({ key: `V${i}`, label: `Visit ${i + 1}`, color: SERIES[i] }));
  if (nVisits > 7) visitSeries.push({ key: "Vother", label: `Visits 8–${nVisits}`, color: "#8592a5" });
  const runSeriesAll = colorBy === "detector" ? cubeSeries.map((s) => ({ ...s, line: false })) : visitSeries;
  const runPts: PlotPoint[] = ok.flatMap((p) => {
    const v = vis.get(String(p.t_mid_mjd)) ?? 0;
    if (hiddenVisits.has(v)) return [];
    const ps = quantity === "pointsource";
    const y = ps ? p.flux_pointsource_ujy : p.flux_ujy;
    const e = ps ? p.flux_pointsource_err_ujy : p.flux_err_ujy;
    if (y == null) return [];
    return [{ x: p.wave_um!, y, yErr: e, series: colorBy === "detector" ? `D${p.detector}` : v < 7 ? `V${v}` : "Vother", dim: p.quality === "bad",
      id: String(p.channel), label: `${p.product_id} · ${fmtDate(p.t_mid_mjd)} · ${p.wave_um!.toFixed(4)} µm · ${y.toFixed(1)} ± ${(e ?? 0).toFixed(1)} µJy · ${p.quality}` }];
  });

  const present = new Set(runPts.map((p) => p.series));
  const runSeries = runSeriesAll.filter((x) => present.has(x.key));
  const visitList = Array.from({ length: nVisits }, (_, i) => {
    const ts = [...vis.entries()].filter(([, k]) => k === i).map(([t]) => Number(t));
    return { i, t0: Math.min(...ts), n: ok.filter((p) => vis.get(String(p.t_mid_mjd)) === i).length };
  });

  if (!pos && !err)
    return (
      <div className="p-6 max-w-2xl flex flex-col gap-3">
        <h1 className="text-lg font-semibold">Spectral explorer</h1>
        <p className="text-[13px] text-muted">Choose a position, or open this page from a candidate.</p>
        <SearchBox onGo={(ra, dec) => router.push(`/spectra?ra=${ra}&dec=${dec}`)} />
      </div>
    );

  return (
    <div className="p-4 max-w-[1500px] w-full mx-auto flex flex-col gap-4 min-w-0">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="text-lg font-semibold">Spectral explorer</h1>
          {pos && <p className="text-[12px] text-muted num">{raHms(pos.ra)} {decDms(pos.dec)} · {pos.ra.toFixed(5)}°, {pos.dec.toFixed(5)}°{cand && <> · <Link className="text-accent" href={`/discovery/${cand.id}`}>{cand.id}</Link></>}</p>}
        </div>
        <SearchBox className="ml-auto w-[min(380px,100%)]" onGo={(ra, dec) => router.push(`/spectra?ra=${ra}&dec=${dec}`)} />
      </div>
      <ErrorNote error={err} />

      <div className="grid xl:grid-cols-[1fr_340px] gap-4 [&>*]:min-w-0">
        <div className="flex flex-col gap-4 min-w-0">
          <Panel title="Archive coadded spectrum" right={<><KindBadge kind="original" /><label className="text-[12px] text-muted flex items-center gap-1"><input type="checkbox" checked={logY} onChange={(e) => setLogY(e.target.checked)} />log y</label></>}>
            {!cube && !cubeErr && <Progress value={0.4} label="Reading 102 channels of the IRSA DR1 spectral cube at this pixel (HTTP Range)…" />}
            {cubeErr && <p className="text-[12px] text-warn">Cube spectrum unavailable: {cubeErr}</p>}
            {cube && (
              <>
                <Plot ariaLabel="Coadded surface brightness versus wavelength" points={cubePts} series={cubeSeries} logY={logY}
                  xLabel="Wavelength (µm)" yLabel={`Surface brightness (${cube.unit})`} height={260} />
                <p className="text-[11px] text-faint mt-2">{cube.quantity} Tile {cube.tile_id}, pixel {cube.pixel.join(", ")} ({cube.pixel_scale_arcsec.toFixed(1)}″ pixels), inputs MJD {cube.mjd_range.map((m) => m?.toFixed(1)).join("–")}. Horizontal bars: channel bandwidth.</p>
                <p className="text-[11px] text-muted mt-1">Missing channels ({cube.channels.filter((c) => c.missing).length}): {cube.channels.filter((c) => c.missing).map((c) => `D${c.detector}:${String(c.subchannel).padStart(2, "0")}${c.missing_reason?.startsWith("BLANKCH") ? " (archive blank)" : ""}`).join(", ") || "none"}</p>
                <button className="text-[11px] text-accent mt-1" onClick={() => setShowTable((s) => !s)}>{showTable ? "Hide" : "Show"} channel table</button>
                {showTable && (
                  <div className="max-h-64 overflow-auto mt-2">
                    <table className="w-full text-[11px] num"><thead className="text-faint text-left"><tr><th>Ch</th><th>Det:sub</th><th>λ (µm)</th><th>Δλ</th><th>R</th><th>MJy/sr</th><th>NHITS</th></tr></thead>
                      <tbody>{cube.channels.map((c) => <tr key={c.index} className={c.missing ? "text-faint" : ""}><td>{c.index}</td><td>D{c.detector}:{c.subchannel}</td><td>{c.wave_um.toFixed(3)}</td><td>{c.bandwidth_um.toFixed(3)}</td><td>{c.R.toFixed(0)}</td><td>{c.missing ? "missing" : c.surface_brightness_mjy_sr?.toPrecision(4)}</td><td>{c.nhits}</td></tr>)}</tbody></table>
                  </div>
                )}
              </>
            )}
          </Panel>

          <Panel title="Per-exposure spectrophotometry" right={<KindBadge kind="derived" />}>
            <div className="flex flex-wrap items-end gap-3 mb-3 text-[12px]">
              <fieldset className="flex items-center gap-2"><legend className="sr-only">Detectors</legend>
                {[1, 2, 3, 4, 5, 6].map((d) => (
                  <label key={d} className="flex items-center gap-1"><input type="checkbox" checked={dets.includes(d)} onChange={() => setDets((s) => (s.includes(d) ? s.filter((x) => x !== d) : [...s, d].sort()))} />D{d}</label>
                ))}
              </fieldset>
              <label className="flex items-center gap-1 text-muted">max exposures <input value={maxExp} onChange={(e) => setMaxExp(e.target.value.replace(/\D/g, ""))} placeholder="all" className={`${inputCls} w-16 num`} /></label>
              <Button variant="primary" disabled={!pos || !dets.length || (job != null && job.status !== "done" && job.status !== "failed")} onClick={measure}>Measure exposures</Button>
              {runs.length > 0 && (
                <label className="flex items-center gap-1 text-muted ml-auto">Stored runs
                  <select className={inputCls} value={run?.id ?? ""} onChange={(e) => get<SpectroRun>(`/api/spectra/runs/${e.target.value}`).then(setRun)}>
                    {runs.map((r) => <option key={r.id} value={r.id}>{r.id} · {r.n_points} pts · {r.status}</option>)}
                  </select>
                </label>
              )}
            </div>
            {job && job.status !== "done" && <Progress value={job.progress} label={job.message} />}
            {!run && !job && <p className="text-[12px] text-muted">Each SPHEREx exposure covering this position samples it at one wavelength. Measuring reads a small pixel stamp from every exposure (~0.4 MB each, HTTP Range) and runs forced aperture photometry. Nothing is measured until you start it.</p>}
            {run && run.status === "done" && (
              <>
                <div className="flex flex-wrap gap-3 text-[12px] text-muted mb-2">
                  <label className="flex items-center gap-1">Quantity
                    <select className={inputCls} value={quantity} onChange={(e) => setQuantity(e.target.value as any)}>
                      <option value="aperture">Aperture flux density (measured)</option>
                      <option value="pointsource">Point-source flux density (EPSF aperture-corrected, derived)</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-1">Colour by
                    <select className={inputCls} value={colorBy} onChange={(e) => setColorBy(e.target.value as any)}>
                      <option value="detector">Detector</option><option value="visit">Visit (epoch)</option>
                    </select>
                  </label>
                </div>
                <Plot ariaLabel="Per-exposure flux density versus wavelength" points={runPts} series={runSeries} xLabel="Wavelength (µm)"
                  yLabel="Flux density (µJy)" height={280} selectedId={channel != null ? String(channel) : undefined}
                  onPoint={(p) => p.id && setChannel(Number(p.id))} />
                <p className="text-[11px] text-faint mt-1">{ok.length} measurements from {run.provenance?.n_exposures ?? "?"} exposures in {nVisits} visits. Vertical bars: 1σ from archive VARIANCE. Faded: &gt;30% of aperture flagged. Click a point to open that channel&apos;s light curve.</p>
                <details className="mt-2 text-[12px]">
                  <summary className="cursor-pointer text-muted">Observation selector ({nVisits} visits)</summary>
                  <div className="flex flex-wrap gap-2 mt-2">
                    {visitList.map((v) => (
                      <label key={v.i} className="flex items-center gap-1 border border-line rounded px-2 py-0.5 num">
                        <input type="checkbox" checked={!hiddenVisits.has(v.i)} onChange={() => setHiddenVisits((s) => { const n = new Set(s); if (n.has(v.i)) n.delete(v.i); else n.add(v.i); return n; })} />
                        <span className="w-2 h-2 rounded-full" style={{ background: v.i < 7 ? SERIES[v.i] : "#8592a5" }} />
                        {fmtDate(v.t0, false)} · {v.n}
                      </label>
                    ))}
                  </div>
                </details>
                <details className="mt-2 text-[12px]">
                  <summary className="cursor-pointer text-muted">Missing or invalid measurements ({missing.length})</summary>
                  <ul className="mt-1 max-h-48 overflow-auto num text-[11px] text-faint">
                    {missing.map((p) => <li key={p.product_id}>{p.product_id} · {fmtDate(p.t_mid_mjd, false)} · {p.status}{p.quality === "bad" ? " (quality bad)" : ""} — {p.message ?? (p.extra?.quality_reasons ?? []).join("; ")}</li>)}
                  </ul>
                </details>
              </>
            )}
            {run && run.status === "failed" && <p className="text-[12px] text-bad">Run failed: {run.error}</p>}
          </Panel>

          {run && run.status === "done" && <LightCurvePanel runId={run.id} channel={channel} onChannel={setChannel} />}
        </div>

        <div className="flex flex-col gap-4">
          <Panel title="Source & provenance">
            <dl className="grid grid-cols-[110px_1fr] gap-y-1 text-[12px]">
              <dt className="text-faint">Position</dt><dd className="num">{pos ? `${pos.ra.toFixed(6)}, ${pos.dec.toFixed(6)}` : "—"}</dd>
              {cand && <><dt className="text-faint">Candidate</dt><dd><Link className="text-accent num" href={`/discovery/${cand.id}`}>{cand.id}</Link> · {cand.machine_class}</dd></>}
              <dt className="text-faint">Cube tile</dt><dd className="num break-all">{cube ? <a className="text-accent" href={cube.tile}>{cube.tile_id}</a> : "—"}</dd>
              <dt className="text-faint">Run</dt><dd className="num">{run ? run.id : "none yet"}</dd>
              {run && <><dt className="text-faint">Processed</dt><dd className="num">{String(run.provenance?.processed_at ?? "").slice(0, 19)}</dd>
                <dt className="text-faint">Pipeline</dt><dd className="num">{run.provenance?.pipeline_version}</dd>
                <dt className="text-faint">Exposures</dt><dd className="num">{run.provenance?.n_exposures} ({run.n_points} usable)</dd></>}
            </dl>
            {run?.provenance?.calibration && (
              <ul className="mt-2 text-[11px] text-faint flex flex-col gap-1">
                {Object.entries(run.provenance.calibration as Record<string, any>).map(([d, c]) => (
                  <li key={d}>D{d}: wavelength {c.wavelength_lookup?.calibration_source || "—"} ({c.wavelength_lookup?.pipeline_version}); EPSF {c.epsf ? `${c.epsf.zone_grid?.join("×")} zones` : "not available"}</li>
                ))}
              </ul>
            )}
            {run && <a className="text-[12px] text-accent mt-2 inline-block" href={`${API}/api/spectra/runs/${run.id}/csv`}>Download measurements (CSV)</a>}
          </Panel>
          <Panel title="What is plotted">
            <ul className="text-[12px] text-muted flex flex-col gap-2">
              <li><KindBadge kind="original" /> <b className="text-text">Archive coadd:</b> IRSA&apos;s time-averaged DR1 spectral cube, surface brightness at the nearest cube pixel. The archive gives no uncertainty, so no error bars are drawn.</li>
              <li><KindBadge kind="derived" /> <b className="text-text">Per-exposure flux:</b> forced aperture photometry by Sky Time Machine on archive pixels, with 1σ errors from VARIANCE. The point-source option divides by the EPSF enclosed fraction and is wrong for extended sources.</li>
              <li>The two quantities have different units (MJy/sr vs µJy) and are deliberately not overplotted.</li>
            </ul>
            {pos && <Link className="text-[12px] text-accent mt-2 inline-block" href={`/intelligence?ra=${pos.ra}&dec=${pos.dec}${cand ? `&cand=${cand.id}` : ""}`}>Ask Sky Intelligence about these measurements →</Link>}
          </Panel>
        </div>
      </div>
    </div>
  );
}

export default function Page() {
  return <Suspense><SpectraPage /></Suspense>;
}
