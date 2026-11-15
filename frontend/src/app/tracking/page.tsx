"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Button, ErrorNote, Field, f, inputCls, Panel } from "@/components/ui";
import { post } from "@/lib/api";
import { fmtDate, TRACK_LABEL } from "@/lib/astro";
import { readViewState } from "@/lib/viewstate";

interface Track { id: string; kind: string; members: string[]; metrics: Record<string, any>; ra: number; dec: number }
interface Resp { run_id: string; n_candidates: number; tracks: Track[]; method: string; params: Record<string, any> }

function SkyPlot({ tracks, ra0, dec0, radius }: { tracks: Track[]; ra0: number; dec0: number; radius: number }) {
  const S = 320, c = S / 2;
  const sc = (S / 2 - 16) / (radius * 3600);
  const pt = (ra: number, dec: number) => {
    const dx = ((((ra - ra0 + 540) % 360) - 180) * Math.cos((dec0 * Math.PI) / 180)) * 3600;
    const dy = (dec - dec0) * 3600;
    return [c - dx * sc, c - dy * sc];
  };
  const col: Record<string, string> = { stationary_repeated: "var(--good)", potential_moving_object: "var(--accent)", single_detection: "var(--muted)" };
  return (
    <svg viewBox={`0 0 ${S} ${S}`} className="w-full max-w-[360px] h-auto" role="img" aria-label="Track positions relative to the search centre">
      <circle cx={c} cy={c} r={S / 2 - 16} fill="none" stroke="var(--line-strong)" />
      <line x1={c} x2={c} y1={8} y2={S - 8} stroke="var(--line)" /><line y1={c} y2={c} x1={8} x2={S - 8} stroke="var(--line)" />
      <text x={c + 4} y={14} fontSize="10" fill="var(--muted)">N</text><text x={10} y={c - 4} fontSize="10" fill="var(--muted)">E</text>
      {tracks.map((t) => {
        const [x, y] = pt(t.ra, t.dec);
        return <circle key={t.id} cx={x} cy={y} r={t.kind === "single_detection" ? 2.5 : 4.5} fill={col[t.kind]}><title>{`${t.id} · ${TRACK_LABEL[t.kind]}`}</title></circle>;
      })}
    </svg>
  );
}

function Tracking() {
  const v = readViewState(useSearchParams());
  const [ra, setRa] = useState(v.ra ?? 10.6847);
  const [dec, setDec] = useState(v.dec ?? 41.269);
  const [radius, setRadius] = useState(0.25);
  const [nsig, setNsig] = useState(3);
  const [rej, setRej] = useState(false);
  const [res, setRes] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      setRes(await post<Resp>("/api/tracks", { ra, dec, radius_deg: radius, n_sigma: nsig, include_rejected: rej }));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }
  const groups = res ? ["potential_moving_object", "stationary_repeated", "single_detection"].map((k) => ({ k, items: res.tracks.filter((t) => t.kind === k) })) : [];

  return (
    <div className="px-4 sm:px-6 py-6 max-w-[1300px] w-full mx-auto flex flex-col gap-4">
      <div>
        <h1 className="serif text-[26px] leading-tight font-semibold tracking-[-0.01em]">Candidate tracking</h1>
        <p className="text-[12px] text-muted">Associates candidates from different comparisons by position, uncertainty and time. An association means the measurements are consistent, not that the detections are the same physical object.</p>
      </div>
      <form onSubmit={run} className="flex flex-wrap items-end gap-3">
        <Field label="RA (deg)"><input className={`${inputCls} w-32 num`} type="number" step="any" value={ra} onChange={(e) => setRa(+e.target.value)} /></Field>
        <Field label="Dec (deg)"><input className={`${inputCls} w-32 num`} type="number" step="any" value={dec} onChange={(e) => setDec(+e.target.value)} /></Field>
        <Field label="Radius (deg)"><input className={`${inputCls} w-24 num`} type="number" step="any" min={0.01} max={5} value={radius} onChange={(e) => setRadius(+e.target.value)} /></Field>
        <Field label="Match (n σ)"><input className={`${inputCls} w-20 num`} type="number" step="0.5" min={1} max={10} value={nsig} onChange={(e) => setNsig(+e.target.value)} /></Field>
        <label className="flex items-center gap-1 text-[12px] text-muted h-8"><input type="checkbox" checked={rej} onChange={(e) => setRej(e.target.checked)} />include rejected</label>
        <Button variant="primary" type="submit" disabled={busy}>{busy ? "Associating…" : "Build tracks"}</Button>
      </form>
      <ErrorNote error={err} />
      {res && (
        <div className="grid lg:grid-cols-[1fr_380px] gap-4 min-w-0 [&>*]:min-w-0">
          <div className="flex flex-col gap-4">
            {groups.map(({ k, items }) => (
              <Panel key={k} title={`${TRACK_LABEL[k]} (${items.length})`}>
                {items.length === 0 ? <p className="text-[12px] text-muted">None.</p> : (
                  <ul className="divide-y divide-line text-[12px]">
                    {items.map((t) => (
                      <li key={t.id} className="py-1.5 flex flex-wrap gap-x-4 gap-y-1">
                        <span className="num text-muted">{t.id}</span>
                        <span className="num">{t.ra.toFixed(5)}, {t.dec.toFixed(5)}</span>
                        {k === "stationary_repeated" && <span className="num text-muted">max sep {f(t.metrics.max_separation_sigma, 2)}σ · ΔF {t.metrics.diff_flux_ujy?.map((x: number) => x.toFixed(0)).join(", ")} µJy</span>}
                        {k === "potential_moving_object" && <span className="num text-warn">{f(t.metrics.rate_arcsec_per_hr, 2)}″/h · PA {f(t.metrics.pa_deg, 0)}° · residual {f(t.metrics.prediction_residual_arcsec, 1)}″ (tol {f(t.metrics.tolerance_arcsec, 1)}″)</span>}
                        <span className="text-faint num">{(t.metrics.epochs_mjd ?? []).map((m: number) => fmtDate(m, false)).join(" · ")}</span>
                        <span className="w-full">{t.members.map((mid) => <Link key={mid} href={`/discovery/${mid}`} className="num mr-3 underline decoration-line-strong hover:text-accent">{mid}</Link>)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            ))}
          </div>
          <Panel title={`Positions (${res.n_candidates} candidates)`}>
            <SkyPlot tracks={res.tracks} ra0={ra} dec0={dec} radius={radius} />
            <p className="text-[11px] text-faint mt-2">{res.method}</p>
            <p className="text-[11px] text-faint num mt-1">Run {res.run_id}</p>
          </Panel>
        </div>
      )}
    </div>
  );
}

export default function Page() {
  return <Suspense><Tracking /></Suspense>;
}
