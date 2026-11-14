"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Button, ErrorNote, f, Panel, Progress } from "@/components/ui";
import { get, type ObservationsResponse, type SpectralObs, type SpectralResponse } from "@/lib/api";
import { BANDS, DETECTOR_COLORS, decDms, fmtDate, raHms } from "@/lib/astro";
import { href, readViewState, toQuery } from "@/lib/viewstate";

function TimelineStrip({ obs, det, selected, onSelect }: { obs: ObservationsResponse; det: number; selected: string[]; onSelect: (pid: string) => void }) {
  const W = 1000, rowH = 22, padL = 44, padT = 18;
  const ts = obs.exposures.map((e) => e.t_mid_mjd);
  if (!ts.length) return <p className="text-muted text-sm">No observations.</p>;
  const t0 = Math.min(...ts) - 3, t1 = Math.max(...ts) + 3;
  const x = (t: number) => padL + ((t - t0) / (t1 - t0)) * (W - padL - 10);
  const H = padT + rowH * 6 + 24;
  // month ticks
  const ticks: { t: number; label: string }[] = [];
  const d0 = new Date((t0 - 40587) * 864e5);
  for (let d = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 1)); ; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const t = d.getTime() / 864e5 + 40587;
    if (t > t1) break;
    ticks.push({ t, label: d.toISOString().slice(0, 7) });
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Observation timeline by detector">
      {obs.coverage_gaps.map((g, i) => (
        <rect key={i} x={x(g.from_mjd) + 2} y={padT - 6} width={Math.max(0, x(g.to_mjd) - x(g.from_mjd) - 4)} height={rowH * 6 + 4} fill="url(#hatch)" opacity={0.5}>
          <title>{`No coverage for ${g.days.toFixed(1)} days`}</title>
        </rect>
      ))}
      <defs>
        <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke="#1e2633" strokeWidth="2" />
        </pattern>
      </defs>
      {ticks.map((t) => (
        <g key={t.t}>
          <line x1={x(t.t)} x2={x(t.t)} y1={padT - 6} y2={H - 18} stroke="#1e2633" />
          <text x={x(t.t) + 3} y={H - 6} fill="#566275" fontSize="10" className="num">{t.label}</text>
        </g>
      ))}
      {[1, 2, 3, 4, 5, 6].map((d, i) => (
        <g key={d} opacity={d === det ? 1 : 0.35}>
          <text x={4} y={padT + i * rowH + 4} fill={DETECTOR_COLORS[d]} fontSize="11" className="num">D{d}</text>
          <line x1={padL} x2={W - 10} y1={padT + i * rowH} y2={padT + i * rowH} stroke="#121821" />
          {obs.exposures.flatMap((e) =>
            e.products.filter((p) => p.detector === d).map((p) => {
              const sel = selected.includes(p.product_id);
              return (
                <rect key={p.product_id} x={x(e.t_mid_mjd) - (sel ? 2 : 1)} y={padT + i * rowH - (sel ? 9 : 7)} width={sel ? 4 : 2} height={sel ? 18 : 14}
                  fill={sel ? "#ffffff" : DETECTOR_COLORS[d]} className="cursor-pointer" onClick={() => d === det && onSelect(p.product_id)}>
                  <title>{`${p.product_id}\n${fmtDate(e.t_mid_mjd)}`}</title>
                </rect>
              );
            }),
          )}
        </g>
      ))}
    </svg>
  );
}

function TimelinePage() {
  const sp = useSearchParams();
  const router = useRouter();
  const v = readViewState(sp);
  const ra = v.ra, dec = v.dec, det = v.det ?? 1;
  const [obs, setObs] = useState<ObservationsResponse | null>(null);
  const [spec, setSpec] = useState<SpectralResponse | null>(null);
  const [loadingSpec, setLoadingSpec] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [a, setA] = useState<string | undefined>(v.a);
  const [b, setB] = useState<string | undefined>(v.b);
  const [cursor, setCursor] = useState<string | undefined>(v.a);

  useEffect(() => {
    if (ra == null || dec == null) return;
    setErr(null);
    get<ObservationsResponse>(`/api/observations?ra=${ra}&dec=${dec}`).then(setObs).catch((e) => setErr(e.message));
  }, [ra, dec]);

  useEffect(() => {
    if (ra == null || dec == null) return;
    setSpec(null);
    setLoadingSpec(true);
    get<SpectralResponse>(`/api/observations/spectral?ra=${ra}&dec=${dec}&detector=${det}`)
      .then(setSpec)
      .catch((e) => setErr(e.message))
      .finally(() => setLoadingSpec(false));
  }, [ra, dec, det]);

  const rows = useMemo(() => (spec?.observations ?? []).slice().sort((x, y) => x.t_mid_mjd - y.t_mid_mjd), [spec]);
  const byId = useMemo(() => Object.fromEntries(rows.map((r) => [r.product_id, r])), [rows]);
  const oa = a ? byId[a] : undefined, ob = b ? byId[b] : undefined;
  const dl = oa?.wave_um != null && ob?.wave_um != null ? Math.abs(oa.wave_um - ob.wave_um) / (0.5 * ((oa.bandwidth_um ?? 0) + (ob.bandwidth_um ?? 0))) : null;

  if (ra == null || dec == null)
    return (
      <div className="p-6 max-w-xl">
        <Panel title="Timeline">
          <p className="text-sm text-muted">Choose a position first in <Link className="text-accent" href="/">Explore</Link>.</p>
        </Panel>
      </div>
    );

  const select = (pid: string) => {
    setCursor(pid);
    if (!a || (a && b)) { setA(pid); setB(undefined); }
    else if (pid !== a) setB(pid);
  };
  const step = (dir: number) => {
    const i = rows.findIndex((r) => r.product_id === cursor);
    const n = rows[Math.min(rows.length - 1, Math.max(0, (i < 0 ? 0 : i) + dir))];
    if (n) setCursor(n.product_id);
  };
  const ordered = oa && ob ? (oa.t_mid_mjd <= ob.t_mid_mjd ? [a!, b!] : [b!, a!]) : null;
  const cur = cursor ? byId[cursor] : undefined;

  return (
    <div className="p-4 flex flex-col gap-4 max-w-[1400px] w-full mx-auto">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="text-lg font-semibold">Observation timeline</h1>
          <p className="text-[12px] text-muted num">{raHms(ra)} {decDms(dec)} · actual SPHEREx exposure midpoints; nothing is interpolated</p>
        </div>
        <div className="ml-auto flex items-center gap-1" role="radiogroup" aria-label="Detector">
          {[1, 2, 3, 4, 5, 6].map((d) => (
            <button key={d} role="radio" aria-checked={d === det} onClick={() => router.replace(`/timeline${toQuery({ ...v, det: d, a: undefined, b: undefined })}`)}
              className={`h-8 px-2 rounded border text-[12px] num ${d === det ? "border-accent text-text" : "border-line text-muted hover:text-text"}`} title={BANDS[d]}>
              <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: DETECTOR_COLORS[d] }} />D{d}
            </button>
          ))}
        </div>
      </div>
      <ErrorNote error={err} />

      <Panel title="Coverage by detector" right={obs && <span className="text-[11px] text-faint num">{obs.n_exposures} exposures · hatched = gaps &gt; 5 d</span>}>
        {obs ? <TimelineStrip obs={obs} det={det} selected={[a, b].filter(Boolean) as string[]} onSelect={select} /> : <Progress value={0.3} label="Querying IRSA SIA…" />}
      </Panel>

      <div className="grid lg:grid-cols-[1fr_380px] gap-4 min-w-0 [&>*]:min-w-0">
        <Panel title={`Detector ${det} · ${BANDS[det]} · wavelength at target`} right={
          <div className="flex gap-1">
            <Button variant="ghost" onClick={() => step(-1)} aria-label="Previous observation">◀ Prev</Button>
            <Button variant="ghost" onClick={() => step(1)} aria-label="Next observation">Next ▶</Button>
          </div>}>
          {loadingSpec && <Progress value={0.5} label="Reading exposure headers (HTTP Range) to compute the wavelength observed at this position…" />}
          {spec && (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead className="text-faint text-left">
                  <tr className="border-b border-line">
                    <th className="py-1 font-normal">Epoch</th><th className="font-normal">Product</th>
                    <th className="font-normal text-right">λ (µm)</th><th className="font-normal text-right">Δλ (µm)</th>
                    <th className="font-normal text-right">Edge (px)</th><th className="font-normal text-center">A</th><th className="font-normal text-center">B</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r: SpectralObs) => (
                    <tr key={r.product_id} onClick={() => setCursor(r.product_id)}
                      className={`border-b border-line/60 ${r.product_id === cursor ? "bg-panel-2" : ""} ${r.in_footprint === false ? "opacity-40" : ""}`}>
                      <td className="py-1 num">{fmtDate(r.t_mid_mjd)}</td>
                      <td className="num text-muted">{r.product_id}</td>
                      <td className="num text-right">{f(r.wave_um, 4)}</td>
                      <td className="num text-right text-muted">{f(r.bandwidth_um, 4)}</td>
                      <td className="num text-right text-muted">{r.error ? "—" : f(r.edge_distance_pix, 0)}</td>
                      <td className="text-center"><input type="radio" name="a" aria-label={`Epoch A ${r.product_id}`} checked={a === r.product_id} disabled={!r.in_footprint} onChange={() => setA(r.product_id)} /></td>
                      <td className="text-center"><input type="radio" name="b" aria-label={`Epoch B ${r.product_id}`} checked={b === r.product_id} disabled={!r.in_footprint} onChange={() => setB(r.product_id)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[11px] text-faint mt-2">{spec.method} Lookup: {spec.wavelength_lookup?.calibration_source} ({spec.wavelength_lookup?.pipeline_version}).</p>
            </div>
          )}
        </Panel>

        <div className="flex flex-col gap-4">
          <Panel title="Selected observation">
            {cur ? (
              <dl className="grid grid-cols-[110px_1fr] gap-y-1 text-[12px]">
                <dt className="text-faint">Product</dt><dd className="num">{cur.product_id}</dd>
                <dt className="text-faint">Mid-exposure</dt><dd className="num">{fmtDate(cur.t_mid_mjd)} (MJD {cur.t_mid_mjd.toFixed(5)})</dd>
                <dt className="text-faint">λ at target</dt><dd className="num">{f(cur.wave_um, 4)} ± {f((cur.bandwidth_um ?? 0) / 2, 4)} µm</dd>
                <dt className="text-faint">PSF FWHM</dt><dd className="num">{f(cur.psf_fwhm_arcsec, 2)}″</dd>
                <dt className="text-faint">In footprint</dt><dd>{cur.in_footprint ? "yes" : "no"}</dd>
              </dl>
            ) : <p className="text-[12px] text-muted">Click an observation in the table or timeline.</p>}
          </Panel>

          <Panel title="Compare two epochs">
            <div className="flex flex-col gap-2 text-[12px]">
              <p className="num">A: {a ?? "—"}<br />B: {b ?? "—"}</p>
              {dl != null && (
                <p className={dl <= 0.5 ? "text-good" : "text-bad"}>
                  |Δλ| = {f(Math.abs((oa!.wave_um ?? 0) - (ob!.wave_um ?? 0)) * 1000, 1)} nm = {f(dl, 2)} bandwidth.{" "}
                  {dl <= 0.5 ? "Spectrally compatible." : "Different wavelengths: the pipeline will mask or reject this comparison."}
                </p>
              )}
              <Link aria-disabled={!ordered} href={ordered ? href("/compare", { ra, dec, det, a: ordered[0], b: ordered[1], size: v.size ?? 0.1, mode: "blink" }) : "#"}
                className={`h-8 grid place-items-center rounded text-[13px] font-medium ${ordered ? "bg-accent text-[#04121f] hover:brightness-110" : "bg-panel-2 text-faint pointer-events-none"}`}>
                Compare A → B
              </Link>
            </div>
          </Panel>

          <Panel title={`Spectrally matched pairs (${spec?.pairs.length ?? 0})`}>
            {spec && spec.pairs.length === 0 && <p className="text-[12px] text-warn">No pair of epochs observed this position at the same wavelength (within half a bandwidth) in this detector. Try another detector.</p>}
            <ul className="flex flex-col text-[12px] max-h-72 overflow-y-auto">
              {spec?.pairs.slice(0, 25).map((p) => (
                <li key={p.a + p.b} className="flex items-center gap-2 py-1 border-b border-line">
                  <span className="num text-muted flex-1 truncate" title={`${p.a} → ${p.b}`}>{fmtDate(byId[p.a]?.t_mid_mjd, false)} → {fmtDate(byId[p.b]?.t_mid_mjd, false)}</span>
                  <span className="num">{p.baseline_days.toFixed(1)} d</span>
                  <span className="num text-muted w-14 text-right">{p.dlambda_nm.toFixed(1)} nm</span>
                  <button className="text-accent hover:underline" onClick={() => { setA(p.a); setB(p.b); setCursor(p.a); }}>Select</button>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <TimelinePage />
    </Suspense>
  );
}
