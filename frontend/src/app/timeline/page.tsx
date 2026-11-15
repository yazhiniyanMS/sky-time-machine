"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Empty, ErrorNote, f, MetaList, PageHeader, Panel, primaryLinkCls, Progress, Segmented, textLinkCls } from "@/components/ui";
import { get, type ObservationsResponse, type SpectralObs, type SpectralResponse } from "@/lib/api";
import { BANDS, DETECTOR_COLORS, decDms, fmtDate, raHms } from "@/lib/astro";
import { href, readViewState, toQuery } from "@/lib/viewstate";

function TimelineStrip({ obs, det, a, b, onSelect }: { obs: ObservationsResponse; det: number; a?: string; b?: string; onSelect: (pid: string) => void }) {
  const W = 1000, rowH = 24, padL = 40, padT = 24;
  const ts = obs.exposures.map((e) => e.t_mid_mjd);
  if (!ts.length) return <p className="text-muted text-[13px]">No observations at this position.</p>;
  const t0 = Math.min(...ts) - 3, t1 = Math.max(...ts) + 3;
  const x = (t: number) => padL + ((t - t0) / (t1 - t0)) * (W - padL - 10);
  const H = padT + rowH * 6 + 22;
  const ticks: { t: number; label: string }[] = [];
  const d0 = new Date((t0 - 40587) * 864e5);
  for (let d = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 1)); ; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const t = d.getTime() / 864e5 + 40587;
    if (t > t1) break;
    ticks.push({ t, label: d.toISOString().slice(0, 7) });
  }
  const yRow = (i: number) => padT + i * rowH;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Observation timeline by detector">
      <defs>
        <pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="5" stroke="var(--line)" strokeWidth="1.5" />
        </pattern>
      </defs>
      {obs.coverage_gaps.map((g, i) => (
        <rect key={i} x={x(g.from_mjd) + 2} y={padT - 10} width={Math.max(0, x(g.to_mjd) - x(g.from_mjd) - 4)} height={rowH * 5 + 20} fill="url(#hatch)">
          <title>{`No coverage for ${g.days.toFixed(1)} days`}</title>
        </rect>
      ))}
      {ticks.map((t) => (
        <g key={t.t}>
          <line x1={x(t.t)} x2={x(t.t)} y1={padT - 10} y2={H - 16} stroke="var(--line-strong)" strokeWidth="0.75" />
          <text x={x(t.t) + 3} y={H - 4} fill="var(--muted)" fontSize="10" className="num">{t.label}</text>
        </g>
      ))}
      {[1, 2, 3, 4, 5, 6].map((d, i) => (
        <g key={d} opacity={d === det ? 1 : 0.4}>
          <text x={2} y={yRow(i) + 4} fill="var(--text)" fontSize="11" fontWeight={d === det ? 600 : 400} className="num">D{d}</text>
          <line x1={padL} x2={W - 10} y1={yRow(i)} y2={yRow(i)} stroke="var(--line)" strokeWidth="0.75" />
          {obs.exposures.flatMap((e) =>
            e.products.filter((p) => p.detector === d).map((p) => {
              const tag = p.product_id === a ? "A" : p.product_id === b ? "B" : null;
              return (
                <g key={p.product_id} className={d === det ? "cursor-pointer" : ""} onClick={() => d === det && onSelect(p.product_id)}>
                  <rect x={x(e.t_mid_mjd) - (tag ? 1.5 : 1)} y={yRow(i) - (tag ? 9 : 7)} width={tag ? 3 : 2} height={tag ? 18 : 14} fill={tag ? "var(--text)" : DETECTOR_COLORS[d]} />
                  {tag && <text x={x(e.t_mid_mjd)} y={yRow(i) - 12} textAnchor="middle" fontSize="10" fontWeight={600} fill="var(--text)" className="num">{tag}</text>}
                  <title>{`${p.product_id}\n${fmtDate(e.t_mid_mjd)}`}</title>
                </g>
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
      <div className="px-6 py-8 max-w-3xl w-full mx-auto">
        <PageHeader title="Observation timeline" />
        <Empty>No position selected. Choose a target in <Link className={textLinkCls} href="/">Explore</Link> first.</Empty>
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
  const epochCol = (o: SpectralObs | undefined) => o ? [o.product_id, fmtDate(o.t_mid_mjd), `${f(o.wave_um, 4)} µm`, `${f(o.psf_fwhm_arcsec, 2)}″`] : ["—", "—", "—", "—"];
  const ea = epochCol(oa), eb = epochCol(ob);

  return (
    <div className="px-4 sm:px-6 py-6 flex flex-col gap-6 max-w-[1400px] w-full mx-auto">
      <PageHeader eyebrow="Observation timeline" title={<span className="num font-normal text-[24px]">{raHms(ra)} {decDms(dec)}</span>}
        meta={<>{ra.toFixed(4)}° {dec >= 0 ? "+" : ""}{dec.toFixed(4)}° · actual SPHEREx exposure midpoints; nothing is interpolated</>}
        right={<Segmented label="Detector" value={det} onChange={(d) => router.replace(`/timeline${toQuery({ ...v, det: d, a: undefined, b: undefined })}`)}
          options={[1, 2, 3, 4, 5, 6].map((d) => ({ value: d, title: BANDS[d], label: <span className="num">D{d}</span> }))} />} />
      <ErrorNote error={err} />

      <figure className="flex flex-col gap-2">
        {obs ? <div className="overflow-x-auto"><div className="min-w-[720px]"><TimelineStrip obs={obs} det={det} a={a} b={b} onSelect={select} /></div></div> : <Progress value={0.3} label="Querying IRSA SIA for SPHEREx DR1 exposures…" />}
        <figcaption className="text-[12px] text-muted border-t border-line pt-2">
          <span className="font-semibold text-text">Exposures by detector.</span>{" "}
          {obs ? <>{obs.n_exposures} exposures, {obs.n_products} images. Hatched spans are gaps longer than 5 days. Click an exposure of D{det} ({BANDS[det]}) to choose epochs A and B.</> : "Loading."}
        </figcaption>
      </figure>

      <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_380px] gap-x-10 gap-y-6">
        <Panel title={<>Detector {det} exposures <span className="font-normal text-muted">· wavelength observed at this position</span></>} right={
          <div className="flex gap-3">
            <button className="text-muted hover:text-text" onClick={() => step(-1)} aria-label="Previous observation">← Previous</button>
            <button className="text-muted hover:text-text" onClick={() => step(1)} aria-label="Next observation">Next →</button>
          </div>}>
          {loadingSpec && <Progress value={0.5} label="Reading exposure headers over HTTP Range to compute the wavelength observed at this position…" />}
          {spec && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-[12px]">
                <thead className="text-muted text-left">
                  <tr className="border-b border-text/70">
                    <th className="py-1.5 font-medium">Mid-exposure (UTC)</th><th className="font-medium">Product</th>
                    <th className="font-medium text-right">λ (µm)</th><th className="font-medium text-right">Δλ (µm)</th>
                    <th className="font-medium text-right">Edge (px)</th><th className="font-medium text-center w-10">A</th><th className="font-medium text-center w-10">B</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r: SpectralObs) => (
                    <tr key={r.product_id} onClick={() => setCursor(r.product_id)}
                      className={`border-b border-line cursor-pointer ${r.product_id === cursor ? "bg-panel-2" : "hover:bg-panel"} ${r.in_footprint === false ? "text-faint" : ""}`}>
                      <td className="py-1.5 num whitespace-nowrap">{fmtDate(r.t_mid_mjd).replace(" UTC", "")}</td>
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

        <div className="flex flex-col gap-6 lg:sticky lg:top-4 self-start w-full">
          <Panel title="Epochs to compare">
            <table className="w-full text-[12px] table-fixed">
              <thead><tr className="text-muted text-left"><th className="w-[5.5rem] font-normal" /><th className="font-semibold text-text py-1">A</th><th className="font-semibold text-text">B</th></tr></thead>
              <tbody className="num">
                {["Product", "Mid-exposure", "λ at target", "PSF FWHM"].map((k, i) => (
                  <tr key={k} className="border-t border-line align-top">
                    <td className="py-1 font-sans text-muted">{k}</td><td className="py-1 pr-2 break-words">{ea[i]}</td><td className="py-1 break-words">{eb[i]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3 flex flex-col gap-3 text-[12px]">
              {dl != null ? (
                <p className={dl <= 0.5 ? "text-good" : "text-bad"}>
                  <span className="num">|Δλ| = {f(Math.abs((oa!.wave_um ?? 0) - (ob!.wave_um ?? 0)) * 1000, 1)} nm = {f(dl, 2)} bandwidth.</span>{" "}
                  {dl <= 0.5 ? "Same wavelength within half a bandwidth: comparable." : "Different wavelengths: the pipeline will mask or reject this comparison."}
                </p>
              ) : <p className="text-muted">Choose A and B in the table, on the figure, or from a matched pair below.</p>}
              <Link aria-disabled={!ordered} href={ordered ? href("/compare", { ra, dec, det, a: ordered[0], b: ordered[1], size: v.size ?? 0.1, mode: "blink" }) : "#"}
                className={ordered ? primaryLinkCls : "h-9 inline-flex items-center justify-center rounded-sm border border-line text-faint text-[13px] pointer-events-none"}>
                Compare A → B
              </Link>
            </div>
          </Panel>

          <Panel title="Cursor">
            {cur ? (
              <MetaList labelWidth="6.5rem" rows={[
                ["Product", cur.product_id],
                ["Mid-exposure", `${fmtDate(cur.t_mid_mjd)}`],
                ["MJD", cur.t_mid_mjd.toFixed(5)],
                ["λ at target", `${f(cur.wave_um, 4)} ± ${f((cur.bandwidth_um ?? 0) / 2, 4)} µm`],
                ["PSF FWHM", `${f(cur.psf_fwhm_arcsec, 2)}″`],
                ["In footprint", cur.in_footprint ? "yes" : "no"],
              ]} />
            ) : <Empty>Click a row to see its details.</Empty>}
          </Panel>

          <Panel title={`Spectrally matched pairs (${spec?.pairs.length ?? 0})`}>
            {spec && spec.pairs.length === 0 && <p className="text-[12px] text-warn">No two epochs observed this position at the same wavelength (within half a bandwidth) on this detector. Try another detector.</p>}
            {spec && spec.pairs.length > 0 && (
              <div className="max-h-72 overflow-y-auto">
                <table className="w-full text-[12px]">
                  <thead className="text-muted text-left"><tr><th className="font-normal py-1">A → B</th><th className="font-normal text-right">Baseline</th><th className="font-normal text-right">|Δλ|</th><th /></tr></thead>
                  <tbody>
                    {spec.pairs.slice(0, 25).map((p) => (
                      <tr key={p.a + p.b} className="border-t border-line">
                        <td className="py-1 num text-muted" title={`${p.a} → ${p.b}`}>{fmtDate(byId[p.a]?.t_mid_mjd, false)} → {fmtDate(byId[p.b]?.t_mid_mjd, false)}</td>
                        <td className="num text-right">{p.baseline_days.toFixed(1)} d</td>
                        <td className="num text-right text-muted">{p.dlambda_nm.toFixed(1)} nm</td>
                        <td className="text-right"><button className="text-text underline decoration-line-strong hover:text-accent" onClick={() => { setA(p.a); setB(p.b); setCursor(p.a); }}>Use</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
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
