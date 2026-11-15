"use client";

import { useEffect, useState } from "react";
import { API, get, type LightCurve } from "@/lib/api";
import { fmtDate, VERDICT_LABEL } from "@/lib/astro";
import { Plot } from "./Plot";
import { ErrorNote, f, inputCls, KindBadge, Panel, Stat } from "./ui";

export function LightCurvePanel({ runId, channel, onChannel, highlight }: {
  runId: string; channel: number | null; onChannel: (c: number) => void; highlight?: { x: number; label: string }[];
}) {
  const [lc, setLc] = useState<LightCurve | null>(null);
  const [quality, setQuality] = useState("warning");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const q = channel != null ? `?channel=${channel}&quality=${quality}` : `?quality=${quality}`;
    get<LightCurve>(`/api/lightcurves/${runId}${q}`).then((d) => { setLc(d); setErr(null); }).catch((e) => setErr(e.message));
  }, [runId, channel, quality]);

  useEffect(() => {
    if (lc && channel == null && lc.channels.length) {
      const best = [...lc.channels].sort((a, b) => b.n_measurements - a.n_measurements)[0];
      onChannel(best.index);
    }
  }, [lc, channel, onChannel]);

  const st = lc?.stats;
  const pts = (lc?.points ?? []).map((p) => ({
    x: p.t_mid_mjd, y: p.flux_ujy!, yErr: p.flux_err_ujy, series: "m",
    label: `${p.product_id} · ${fmtDate(p.t_mid_mjd)} · ${p.flux_ujy!.toFixed(1)} ± ${(p.flux_err_ujy ?? 0).toFixed(1)} µJy · ${p.quality}`,
  }));
  const verdictCls = st?.verdict === "significant_variability" ? "text-warn border-warn/40" : st?.verdict === "no_significant_variability" ? "text-good border-good/40" : "text-muted border-line-strong";

  return (
    <Panel title="Multi-epoch light curve" right={<KindBadge kind="derived" />}>
      <ErrorNote error={err} />
      <div className="flex flex-wrap items-center gap-3 text-[12px] text-muted mb-2">
        <label className="flex items-center gap-1">Channel
          <select className={inputCls} value={channel ?? ""} onChange={(e) => onChannel(Number(e.target.value))}>
            {(lc?.channels ?? []).map((c) => <option key={c.index} value={c.index}>#{c.index} D{c.detector}:{String(c.subchannel).padStart(2, "0")} · {c.wave_um.toFixed(3)} µm · {c.n_measurements} pts</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1">Quality
          <select className={inputCls} value={quality} onChange={(e) => setQuality(e.target.value)}>
            <option value="good">good only</option><option value="warning">good + warning</option><option value="any">any (incl. bad)</option>
          </select>
        </label>
        {channel != null && <a className="ml-auto underline decoration-line-strong hover:text-accent" href={`${API}/api/lightcurves/${runId}/csv?channel=${channel}&quality=${quality}`}>Export CSV</a>}
      </div>
      {lc?.channels.length === 0 && <p className="text-[12px] text-muted">No usable measurements were assigned to an official channel.</p>}
      {st && (
        <>
          <Plot ariaLabel="Flux density versus time in one channel" points={pts} series={[{ key: "m", label: "measurements", color: "var(--text)" }]}
            xLabel="Exposure midpoint (MJD)" yLabel="Flux density (µJy)" height={240} xFormat={(v) => fmtDate(v, false)}
            shadeX={(st.coverage_gaps ?? []).map((g) => ({ from: g.from_mjd, to: g.to_mjd, label: `No observation in this channel for ${g.days.toFixed(0)} days` }))}
            hLine={st.weighted_mean_ujy != null ? { y: st.weighted_mean_ujy, label: "weighted mean" } : undefined} markersX={highlight} />
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Points / visits" value={`${st.n_points} / ${st.n_visits ?? "—"}`} />
            <Stat label="Weighted mean" value={`${f(st.weighted_mean_ujy, 1)} ± ${f(st.weighted_mean_err_ujy, 1)}`} unit="µJy" />
            <Stat label="Median / mean" value={`${f(st.median_ujy, 1)} / ${f(st.mean_ujy, 1)}`} unit="µJy" />
            <Stat label="Std. dev. (measured scatter)" value={f(st.std_ujy ?? null, 1)} unit="µJy" sub={st.relative_scatter != null ? `${(st.relative_scatter * 100).toFixed(1)}% of mean` : undefined} />
            <Stat label="χ² / dof" value={st.chi2 != null ? `${st.chi2.toFixed(1)} / ${st.dof}` : "—"} sub={st.reduced_chi2 != null ? `reduced ${st.reduced_chi2.toFixed(2)}` : undefined} />
            <Stat label="p (constant flux)" value={st.p_value_constant != null ? st.p_value_constant.toExponential(2) : "—"} />
            <Stat label="Excess variance" value={st.fractional_excess_variance != null ? `${(st.fractional_excess_variance * 100).toFixed(1)}%` : "none"} />
            <Stat label="Time span" value={f(st.time_span_days ?? null, 0)} unit="days" />
          </div>
          <div className={`mt-3 border rounded px-3 py-2 text-[12px] ${verdictCls}`} role="status">
            <b>{st.verdict === "significant_variability" && st.systematics_possible ? "Statistically significant scatter — systematics likely" : VERDICT_LABEL[st.verdict] ?? st.verdict}.</b>{" "}
            <span className="text-text/80">{st.explanation}</span>
          </div>
          {(st.systematics?.length ?? 0) > 0 && (
            <ul className="mt-2 text-[12px] text-warn list-disc pl-5 flex flex-col gap-1" aria-label="Possible systematics">
              {st.systematics!.map((x) => <li key={x}>{x}</li>)}
            </ul>
          )}
          <p className="text-[11px] text-faint mt-2">Only measurements in the same official channel are compared, so spectral slope is not mistaken for variability. A {((st.config?.systematic_frac ?? 0.02) * 100).toFixed(0)}% systematic floor is added to each error before the χ² test (α = {st.config?.alpha ?? 0.001}). Shaded spans are cadence gaps longer than {st.config?.missing_gap_days ?? 30} days; SPHEREx revisits a position roughly every six months.</p>
          {(lc?.excluded?.length ?? 0) > 0 && (
            <details className="mt-1 text-[11px] text-faint"><summary className="cursor-pointer">Excluded in this channel ({lc!.excluded!.length})</summary>
              <ul className="num">{lc!.excluded!.map((p) => <li key={p.product_id}>{p.product_id} · {fmtDate(p.t_mid_mjd, false)} · {p.status} {p.quality ?? ""} {p.message ?? ""}</li>)}</ul>
            </details>
          )}
        </>
      )}
    </Panel>
  );
}
