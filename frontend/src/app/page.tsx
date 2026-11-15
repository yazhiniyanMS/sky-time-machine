"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { SearchBox } from "@/components/SearchBox";
import { CoverageHeatmap, seqColor } from "@/components/CoverageHeatmap";
import { type Footprint, SkyMap, type SkyMarker, SURVEYS, type VectorLayer } from "@/components/SkyMap";
import { Button, ErrorNote, f, inputCls, MetaList, Panel, primaryLinkCls, Progress } from "@/components/ui";
import { type CandidateBrief, type CoverageMap, get, type Job, type ObservationsResponse, pollJob, post } from "@/lib/api";
import { BANDS, CLASS_LABEL, DETECTOR_COLORS, decDms, fmtDate, MAP_COLORS, raHms } from "@/lib/astro";

const toRa = (lon: number) => ((lon % 360) + 360) % 360;
function geoLines(fc: any): [number, number][][] {
  const out: [number, number][][] = [];
  for (const ft of fc?.features ?? []) {
    const g = ft.geometry;
    const rings = g.type === "MultiLineString" || g.type === "Polygon" ? g.coordinates : g.type === "MultiPolygon" ? g.coordinates.flat() : g.type === "LineString" ? [g.coordinates] : [];
    for (const r of rings) out.push(r.map(([lon, lat]: number[]) => [toRa(lon), lat] as [number, number]));
  }
  return out;
}
import { href, readViewState, toQuery } from "@/lib/viewstate";

const DEFAULT = { ra: 10.6847, dec: 41.269, fov: 1.5 };

function parseRegion(s: string): [number, number][] {
  const nums = s.replace(/^POLYGON\s+(ICRS\s+)?/i, "").trim().split(/\s+/).map(Number);
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) if (isFinite(nums[i]) && isFinite(nums[i + 1])) pts.push([nums[i], nums[i + 1]]);
  return pts;
}

function Explore() {
  const sp = useSearchParams();
  const router = useRouter();
  const v = readViewState(sp);
  const ra = v.ra ?? DEFAULT.ra;
  const dec = v.dec ?? DEFAULT.dec;
  const fov = v.fov ?? DEFAULT.fov;

  const [survey, setSurvey] = useState<string>("dss2");
  const [slice, setSlice] = useState(50);
  const [showSimbad, setShowSimbad] = useState(false);
  const [showGrid, setShowGrid] = useState(false);
  const [showFp, setShowFp] = useState(true);
  const [obs, setObs] = useState<ObservationsResponse | null>(null);
  const [obsAt, setObsAt] = useState<{ ra: number; dec: number } | null>(null);
  const [loadingObs, setLoadingObs] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cands, setCands] = useState<CandidateBrief[]>([]);
  const [constellation, setConstellation] = useState<string>("");
  const [lay, setLay] = useState({ bounds: false, lines: false, galaxies: false, nebulae: false, saved: true, coverage: false });
  const [constData, setConstData] = useState<any>(null);
  const [objs, setObjs] = useState<{ galaxy: any[]; nebula: any[] }>({ galaxy: [], nebula: [] });
  const [layerErr, setLayerErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ id: string; ra: number; dec: number; machine_class: string }[]>([]);
  const [cov, setCov] = useState<CoverageMap | null>(null);
  const [covJob, setCovJob] = useState<Job | null>(null);
  const [covMetric, setCovMetric] = useState("visits");

  const setView = useCallback(
    (nv: Partial<typeof v>) => router.replace(`/${toQuery({ ...v, ...nv })}`, { scroll: false }),
    [router, v],
  );

  const queryObs = useCallback(async (qra: number, qdec: number) => {
    setLoadingObs(true);
    setErr(null);
    try {
      setObs(await get<ObservationsResponse>(`/api/observations?ra=${qra}&dec=${qdec}`));
      setObsAt({ ra: qra, dec: qdec });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoadingObs(false);
    }
  }, []);

  // Observation coverage for the URL position on first load
  useEffect(() => {
    queryObs(ra, dec);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      get<{ name: string }>(`/api/constellation?ra=${ra}&dec=${dec}`).then((r) => setConstellation(r.name)).catch(() => {});
      get<{ candidates: CandidateBrief[] }>(`/api/candidates?ra=${ra}&dec=${dec}&radius=${Math.min(5, fov)}`)
        .then((r) => setCands(r.candidates))
        .catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [ra, dec, fov]);

  const footprints = useMemo<Footprint[]>(() => {
    if (!obs || !showFp) return [];
    const out: Footprint[] = [];
    for (const e of obs.exposures)
      for (const p of e.products) {
        if (p.detector !== (v.det ?? 1)) continue;
        const poly = parseRegion(p.s_region);
        if (poly.length >= 3) out.push({ id: p.product_id, polygon: poly, color: MAP_COLORS.footprint, label: p.product_id });
      }
    return out;
  }, [obs, showFp, v.det]);

  const markers = useMemo<SkyMarker[]>(
    () => cands.map((c) => ({ id: c.id, ra: c.ra, dec: c.dec, label: c.id, color: c.sign > 0 ? MAP_COLORS.brighten : MAP_COLORS.fade, selected: c.id === v.cand })),
    [cands, v.cand],
  );

  useEffect(() => {
    if ((lay.bounds || lay.lines) && !constData)
      get<any>("/api/catalog/constellations").then(setConstData).catch((e) => setLayerErr(`Constellations: ${e.message}`));
  }, [lay.bounds, lay.lines, constData]);
  useEffect(() => {
    if (!lay.saved) return;
    get<typeof saved>("/api/saved/candidates").then(setSaved).catch(() => {});
  }, [lay.saved]);
  useEffect(() => {
    const kinds = (["galaxy", "nebula"] as const).filter((k) => (k === "galaxy" ? lay.galaxies : lay.nebulae));
    if (!kinds.length) return;
    const t = setTimeout(() => {
      for (const k of kinds)
        get<{ objects: any[]; status: string; message: string }>(`/api/catalog/objects?ra=${ra}&dec=${dec}&radius=${Math.min(3, Math.max(0.1, fov / 2))}&kind=${k}`)
          .then((r) => { setObjs((o) => ({ ...o, [k]: r.objects })); if (r.status !== "ok") setLayerErr(`SIMBAD unavailable: ${r.message}`); })
          .catch((e) => setLayerErr(e.message));
    }, 500);
    return () => clearTimeout(t);
  }, [lay.galaxies, lay.nebulae, ra, dec, fov]);

  async function computeCoverage() {
    setCovJob(null);
    try {
      const r = await post<{ status: string; job_id: string | null; result?: CoverageMap }>("/api/coverage", { ra, dec, size_deg: 0.5, cells: 12 });
      if (r.result) return setCov(r.result);
      const j = await pollJob(r.job_id!, setCovJob, 2000);
      if (j.status === "failed") throw new Error(j.message);
      setCov(await get<CoverageMap>(`/api/coverage?ra=${ra}&dec=${dec}&size_deg=0.5&cells=12`));
      setLay((l) => ({ ...l, coverage: true }));
    } catch (e: any) { setLayerErr(`Coverage: ${e.message}`); }
  }

  const layers = useMemo<VectorLayer[]>(() => {
    const out: VectorLayer[] = [];
    if (lay.bounds && constData) out.push({ id: "bounds", color: MAP_COLORS.bounds, lineWidth: 1, opacity: 0.8, polylines: geoLines(constData.bounds) });
    if (lay.lines && constData) out.push({ id: "lines", color: MAP_COLORS.figures, lineWidth: 1, opacity: 0.7, polylines: geoLines(constData.lines) });
    if (lay.galaxies) out.push({ id: "galaxies", color: MAP_COLORS.galaxies, shape: "square", size: 9, sources: objs.galaxy.map((o) => ({ ra: o.ra, dec: o.dec, id: o.main_id, label: `${o.main_id} (${o.otype})` })) });
    if (lay.nebulae) out.push({ id: "nebulae", color: MAP_COLORS.nebulae, shape: "triangle", size: 9, sources: objs.nebula.map((o) => ({ ra: o.ra, dec: o.dec, id: o.main_id, label: `${o.main_id} (${o.otype})` })) });
    if (lay.saved) out.push({ id: "saved", color: MAP_COLORS.saved, shape: "rhomb", size: 14, sources: saved.map((c) => ({ ra: c.ra, dec: c.dec, id: c.id, label: `${c.id} (saved)` })) });
    if (lay.coverage && cov) {
      const grid = cov.layers[covMetric];
      const mx = Math.max(1, ...grid.flat());
      const h = cov.size_deg / cov.cells / 2;
      const polys = grid.flatMap((row, j) => row.map((v, i) => ({ v, i, j }))).filter((c) => c.v > 0).map(({ v, i, j }) => {
        const cr = cov.cell_ra[j][i], cd = cov.cell_dec[j][i], hr = h / Math.cos((cd * Math.PI) / 180);
        return { pts: [[cr - hr, cd - h], [cr + hr, cd - h], [cr + hr, cd + h], [cr - hr, cd + h]] as [number, number][], fill: seqColor(v / mx) };
      });
      out.push({ id: `coverage-${covMetric}`, color: MAP_COLORS.coverage, lineWidth: 0, opacity: 0.3, polygons: polys });
    }
    return out;
  }, [lay, constData, objs, saved, cov, covMetric]);

  const range = obs?.exposures.length ? [obs.exposures[0].t_mid_mjd, obs.exposures[obs.exposures.length - 1].t_mid_mjd] : null;
  const stale = obsAt && (Math.abs(obsAt.ra - ra) > 0.05 || Math.abs(obsAt.dec - dec) > 0.05);
  const det = v.det ?? 1;
  const surveyLabel = SURVEYS.find((s) => s.id === survey)?.label ?? survey;
  const layerRows: [string, boolean, (b: boolean) => void, string, boolean?][] = [
    [`SPHEREx footprints, D${det}`, showFp, setShowFp, MAP_COLORS.footprint],
    ["Saved candidates", lay.saved, (b) => setLay({ ...lay, saved: b }), MAP_COLORS.saved],
    ["Coverage cells", lay.coverage, (b) => setLay({ ...lay, coverage: b }), MAP_COLORS.coverage, !cov],
    ["Constellation boundaries (IAU)", lay.bounds, (b) => setLay({ ...lay, bounds: b }), MAP_COLORS.bounds],
    ["Constellation figures", lay.lines, (b) => setLay({ ...lay, lines: b }), MAP_COLORS.figures],
    ["Galaxies (SIMBAD)", lay.galaxies, (b) => setLay({ ...lay, galaxies: b }), MAP_COLORS.galaxies],
    ["Nebulae and ISM (SIMBAD)", lay.nebulae, (b) => setLay({ ...lay, nebulae: b }), MAP_COLORS.nebulae],
    ["All SIMBAD objects (CDS, in viewer)", showSimbad, setShowSimbad, MAP_COLORS.simbad],
    ["Coordinate grid", showGrid, setShowGrid, MAP_COLORS.grid],
  ];

  return (
    <div className="theme-graphite flex-1 lg:flex-none flex flex-col lg:flex-row min-h-0 lg:h-[calc(100dvh-2.75rem)] bg-bg">
      {/* Workspace: context bar, map, status bar */}
      <section className="flex-1 flex flex-col min-w-0 min-h-0">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-3 py-2 border-b border-line">
          <SearchBox className="w-full sm:w-[340px]" onGo={(r, d) => { setView({ ra: r, dec: d, fov: Math.min(fov, 1.5), cand: undefined }); queryObs(r, d); }} />
          <dl className="flex flex-wrap gap-x-5 gap-y-1 text-[12px]" aria-label="Map centre">
            {[["RA", raHms(ra)], ["Dec", decDms(dec)], ["ICRS", `${ra.toFixed(4)}° ${dec >= 0 ? "+" : ""}${dec.toFixed(4)}°`], ["FoV", `${f(fov, 2)}°`], ["Constellation", constellation || "—"]].map(([k, val]) => (
              <div key={k} className="flex items-baseline gap-1.5">
                <dt className="text-faint">{k}</dt>
                <dd className={k === "Constellation" ? "text-text" : "num text-text"}>{val}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="relative flex-1 min-h-[56dvh] lg:min-h-0 bg-plate">
          <SkyMap
            ra={ra} dec={dec} fov={fov} survey={survey} cubeSlice={slice} footprints={footprints} markers={markers}
            showSimbad={showSimbad} showGrid={showGrid} layers={layers}
            onMove={(r, d, fv) => setView({ ra: r, dec: d, fov: fv })}
            onMarkerClick={(id) => { if (id.startsWith("ST-")) router.push(href(`/discovery/${id}`, { ra, dec })); }}
          />
        </div>
        <div className="min-h-7 px-3 py-1 flex flex-wrap items-center gap-x-5 gap-y-0.5 border-t border-line text-[11px] text-faint">
          <span>Background <span className="text-muted">{surveyLabel}</span></span>
          <span>Footprints <span className="num text-muted">D{det} · {footprints.length}</span></span>
          <span>Candidates <span className="num text-muted">{cands.length}</span></span>
          <span className="sm:ml-auto">Data NASA/IPAC IRSA · SPHEREx DR1 · viewer Aladin Lite (CDS)</span>
        </div>
      </section>

      {/* Inspector */}
      <aside className="w-full lg:w-[360px] shrink-0 border-t lg:border-t-0 lg:border-l border-line flex flex-col min-h-0 lg:overflow-y-auto bg-bg">
        <div className="px-4 pb-6 flex flex-col gap-5 text-[13px]">
          <Panel title="Observations at this position" right={
            <button onClick={() => queryObs(ra, dec)} disabled={loadingObs} className="text-[12px] text-muted hover:text-text underline decoration-line-strong disabled:opacity-50">
              {loadingObs ? "Querying IRSA…" : stale ? "Query map centre" : "Refresh"}
            </button>}>
            <div className="flex flex-col gap-3">
              <ErrorNote error={err} />
              {loadingObs && !obs && <Progress value={0.3} label="Querying IRSA SIA for SPHEREx DR1 images…" />}
              {obs && (
                <>
                  {stale && <p className="text-[12px] text-warn">Counts below are for {obsAt!.ra.toFixed(3)}, {obsAt!.dec.toFixed(3)}, not the map centre.</p>}
                  <MetaList labelWidth="6.5rem" rows={[
                    ["Images", `${obs.n_products} Level 2`],
                    ["Exposures", obs.n_exposures],
                    ["First", range ? fmtDate(range[0]) : "—"],
                    ["Last", range ? fmtDate(range[1]) : "—"],
                  ]} />
                  {obs.n_products === 0 ? (
                    <p className="text-[12px] text-muted">No public SPHEREx DR1 image covers this position. Try another target.</p>
                  ) : (
                    <table className="w-full text-[12px]" aria-label="Images per detector">
                      <thead><tr className="text-faint text-left"><th className="font-normal py-1">Detector</th><th className="font-normal">Band</th><th className="font-normal text-right">Images</th></tr></thead>
                      <tbody>
                        {Object.entries(obs.detectors).map(([d, n]) => (
                          <tr key={d} onClick={() => setView({ det: +d })} aria-selected={det === +d}
                            className={`border-t border-line cursor-pointer ${det === +d ? "bg-panel-2" : "hover:bg-panel"}`}>
                            <td className="py-1.5 pl-1">
                              <label className="flex items-center gap-2 cursor-pointer">
                                <input type="radio" name="det" checked={det === +d} onChange={() => setView({ det: +d })} aria-label={`Show detector ${d} footprints`} />
                                <span className="w-2.5 h-2.5" style={{ background: DETECTOR_COLORS[+d] }} aria-hidden /> <span className="num">D{d}</span>
                              </label>
                            </td>
                            <td className="num text-muted">{BANDS[+d]}</td>
                            <td className="num text-right pr-1">{n}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <Link href={href("/timeline", { ra: obsAt?.ra ?? ra, dec: obsAt?.dec ?? dec, det })} className={primaryLinkCls}>
                    Open observation timeline, D{det}
                  </Link>
                </>
              )}
            </div>
          </Panel>

          <Panel title="Map layers">
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-[12px] text-muted">
                <span className="w-20 shrink-0">Background</span>
                <select value={survey} onChange={(e) => setSurvey(e.target.value)} className={`${inputCls} flex-1 min-w-0`}>
                  {SURVEYS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </label>
              {survey === "spherex" && (
                <label className="flex flex-col gap-1 text-[12px] text-muted">
                  <span>Cube channel <span className="num text-text">{slice + 1} / 102</span> <span className="text-faint">(0.75–5 µm, IRSA DR1 all-sky cube)</span></span>
                  <input type="range" min={0} max={101} value={slice} onChange={(e) => setSlice(+e.target.value)} />
                </label>
              )}
              <ul className="flex flex-col">
                {layerRows.map(([label, val, set, color, disabled]) => (
                  <li key={label}>
                    <label className={`flex items-center gap-2 py-1 text-[12px] ${disabled ? "text-faint" : ""}`}>
                      <input type="checkbox" checked={val} disabled={disabled} onChange={(e) => set(e.target.checked)} />
                      <span className="w-3 h-[3px]" style={{ background: color }} aria-hidden />
                      {label}
                      {label === "Coverage cells" && disabled && <span className="text-faint">— compute below</span>}
                    </label>
                  </li>
                ))}
              </ul>
              {layerErr && <p className="text-[12px] text-warn" role="status">{layerErr}</p>}
            </div>
          </Panel>

          <Panel title="Coverage map" right={<span className="num text-faint">0.5° × 0.5°</span>}>
            <div className="flex flex-col gap-2">
              {!cov && !covJob && (
                <>
                  <p className="text-[12px] text-muted">Counts images, exposures, independent visits and spectrally matched pairs on a 12 × 12 grid, from every image header in the field.</p>
                  <Button onClick={computeCoverage} className="self-start">Compute coverage</Button>
                </>
              )}
              {covJob && covJob.status !== "done" && !cov && <Progress value={covJob.progress} label={covJob.message} />}
              {cov && (Math.abs(cov.ra - ra) > 0.3 || Math.abs(cov.dec - dec) > 0.3) && <Button variant="ghost" className="self-start px-0" onClick={computeCoverage}>Recompute for the map centre</Button>}
              {cov && <CoverageHeatmap map={cov} metric={covMetric} onMetric={setCovMetric} onCell={(r, d) => setView({ ra: r, dec: d })} />}
            </div>
          </Panel>

          <Panel title={`Candidates in view (${cands.length})`}>
            {cands.length === 0 ? (
              <p className="text-[12px] text-muted">No processed candidates here yet. Pick two epochs on the timeline and run a comparison.</p>
            ) : (
              <table className="w-full text-[12px]">
                <tbody>
                  {cands.slice(0, 12).map((c) => (
                    <tr key={c.id} className="border-t border-line">
                      <td className="py-1.5"><Link href={href(`/discovery/${c.id}`, { ra, dec })} className="num hover:text-accent">{c.id}</Link></td>
                      <td className="text-muted truncate max-w-[9rem]">{CLASS_LABEL[c.machine_class]}</td>
                      <td className={`num text-right ${c.sign > 0 ? "text-pos" : "text-neg"}`}>{c.peak_significance >= 0 ? "+" : ""}{c.peak_significance.toFixed(1)}σ</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <p className="text-[11px] text-faint leading-relaxed border-t border-line pt-3">
            All layers in ICRS. Constellations: d3-celestial v0.7.32 (IAU boundaries; figures are cultural). Object types: SIMBAD (CDS, Harvard mirror fallback). Sky Time Machine, by Snack Seekers.
          </p>
        </div>
      </aside>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Explore />
    </Suspense>
  );
}
