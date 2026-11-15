"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { SearchBox } from "@/components/SearchBox";
import { CoverageHeatmap, seqColor } from "@/components/CoverageHeatmap";
import { type Footprint, SkyMap, type SkyMarker, SURVEYS, type VectorLayer } from "@/components/SkyMap";
import { Button, ErrorNote, f, Progress } from "@/components/ui";
import { type CandidateBrief, type CoverageMap, get, type Job, type ObservationsResponse, pollJob, post } from "@/lib/api";
import { BANDS, CLASS_LABEL, DETECTOR_COLORS, decDms, fmtDate, raHms, SERIES } from "@/lib/astro";

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
        if (poly.length >= 3) out.push({ id: p.product_id, polygon: poly, color: DETECTOR_COLORS[p.detector ?? 1], label: p.product_id });
      }
    return out;
  }, [obs, showFp, v.det]);

  const markers = useMemo<SkyMarker[]>(
    () => cands.map((c) => ({ id: c.id, ra: c.ra, dec: c.dec, label: c.id, color: c.sign > 0 ? "#ff8a5c" : "#5cc8ff", selected: c.id === v.cand })),
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
    if (lay.bounds && constData) out.push({ id: "bounds", color: "#a07a2c", lineWidth: 1, opacity: 0.8, polylines: geoLines(constData.bounds) });
    if (lay.lines && constData) out.push({ id: "lines", color: "#8592a5", lineWidth: 1, opacity: 0.7, polylines: geoLines(constData.lines) });
    if (lay.galaxies) out.push({ id: "galaxies", color: SERIES[6], shape: "square", size: 9, sources: objs.galaxy.map((o) => ({ ra: o.ra, dec: o.dec, id: o.main_id, label: `${o.main_id} (${o.otype})` })) });
    if (lay.nebulae) out.push({ id: "nebulae", color: SERIES[2], shape: "triangle", size: 9, sources: objs.nebula.map((o) => ({ ra: o.ra, dec: o.dec, id: o.main_id, label: `${o.main_id} (${o.otype})` })) });
    if (lay.saved) out.push({ id: "saved", color: SERIES[3], shape: "rhomb", size: 14, sources: saved.map((c) => ({ ra: c.ra, dec: c.dec, id: c.id, label: `${c.id} (saved)` })) });
    if (lay.coverage && cov) {
      const grid = cov.layers[covMetric];
      const mx = Math.max(1, ...grid.flat());
      const h = cov.size_deg / cov.cells / 2;
      const polys = grid.flatMap((row, j) => row.map((v, i) => ({ v, i, j }))).filter((c) => c.v > 0).map(({ v, i, j }) => {
        const cr = cov.cell_ra[j][i], cd = cov.cell_dec[j][i], hr = h / Math.cos((cd * Math.PI) / 180);
        return { pts: [[cr - hr, cd - h], [cr + hr, cd - h], [cr + hr, cd + h], [cr - hr, cd + h]] as [number, number][], fill: seqColor(v / mx) };
      });
      out.push({ id: `coverage-${covMetric}`, color: "#3987e5", lineWidth: 0, opacity: 0.3, polygons: polys });
    }
    return out;
  }, [lay, constData, objs, saved, cov, covMetric]);

  const range = obs?.exposures.length ? [obs.exposures[0].t_mid_mjd, obs.exposures[obs.exposures.length - 1].t_mid_mjd] : null;
  const stale = obsAt && (Math.abs(obsAt.ra - ra) > 0.05 || Math.abs(obsAt.dec - dec) > 0.05);

  return (
    <div className="relative flex-1 min-h-[calc(100dvh-3rem)]">
      <SkyMap
        ra={ra} dec={dec} fov={fov} survey={survey} cubeSlice={slice} footprints={footprints} markers={markers}
        showSimbad={showSimbad} showGrid={showGrid} layers={layers}
        onMove={(r, d, fv) => setView({ ra: r, dec: d, fov: fv })}
        onMarkerClick={(id) => { if (id.startsWith("ST-")) router.push(href(`/discovery/${id}`, { ra, dec })); }}
      />

      <div className="absolute top-3 left-3 w-[min(420px,calc(100%-24px))] z-10 flex flex-col gap-2">
        <SearchBox onGo={(r, d) => { setView({ ra: r, dec: d, fov: Math.min(fov, 1.5), cand: undefined }); queryObs(r, d); }} />
        <div className="text-[11px] num text-muted bg-panel/80 backdrop-blur border border-line rounded px-2 py-1 w-fit">
          {raHms(ra)} {decDms(dec)} · {ra.toFixed(4)}° {dec >= 0 ? "+" : ""}{dec.toFixed(4)}° · FoV {f(fov, 2)}°{constellation && ` · ${constellation}`}
        </div>
      </div>

      <aside className="absolute z-10 bottom-3 left-3 right-3 md:left-auto md:top-3 md:bottom-3 md:w-[340px] bg-panel/95 backdrop-blur border border-line rounded-md flex flex-col max-h-[55dvh] md:max-h-none overflow-hidden">
        <div className="px-3 h-9 flex items-center border-b border-line text-[12px] uppercase tracking-wider text-muted">
          SPHEREx coverage
          <button onClick={() => queryObs(ra, dec)} disabled={loadingObs} className="ml-auto normal-case tracking-normal text-accent hover:underline disabled:opacity-50">
            {loadingObs ? "Querying IRSA…" : stale ? "Query this position" : "Refresh"}
          </button>
        </div>
        <div className="overflow-y-auto p-3 flex flex-col gap-4 text-[13px]">
          <ErrorNote error={err} />
          {obs && (
            <section className="flex flex-col gap-2">
              <p className="text-muted text-[12px]">
                {obs.n_products} Level 2 images in {obs.n_exposures} exposures cover{" "}
                <span className="num">{obsAt && `${obsAt.ra.toFixed(4)}, ${obsAt.dec.toFixed(4)}`}</span>
                {range && <> between <span className="num text-text">{fmtDate(range[0], false)}</span> and <span className="num text-text">{fmtDate(range[1], false)}</span></>}.
              </p>
              {obs.n_products === 0 && <p className="text-warn text-[12px]">No public SPHEREx DR1 images cover this position.</p>}
              <div className="grid grid-cols-3 gap-1">
                {Object.entries(obs.detectors).map(([d, n]) => (
                  <button key={d} onClick={() => setView({ det: v.det === +d ? undefined : +d })}
                    aria-pressed={v.det === +d}
                    className={`flex flex-col items-start px-2 py-1 rounded border text-left ${v.det === +d ? "border-accent bg-accent/5" : "border-line hover:border-line-strong"}`}>
                    <span className="flex items-center gap-1 text-[11px]"><span className="w-2 h-2 rounded-full" style={{ background: DETECTOR_COLORS[+d] }} />D{d}</span>
                    <span className="num text-[11px] text-muted">{n} img · {BANDS[+d].split("–")[0]}–</span>
                  </button>
                ))}
              </div>
              <Link href={href("/timeline", { ra: obsAt?.ra ?? ra, dec: obsAt?.dec ?? dec, det: v.det ?? 1 })}
                className="h-8 grid place-items-center rounded bg-accent text-[#04121f] text-[13px] font-medium hover:brightness-110">
                Open observation timeline
              </Link>
            </section>
          )}

          <section className="flex flex-col gap-2">
            <h3 className="text-[11px] uppercase tracking-wider text-faint">Layers</h3>
            <label className="flex flex-col gap-1 text-[12px] text-muted">
              Background
              <select value={survey} onChange={(e) => setSurvey(e.target.value)} className="h-8 bg-bg border border-line-strong rounded px-2 text-text">
                {SURVEYS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </label>
            {survey === "spherex" && (
              <label className="flex flex-col gap-1 text-[12px] text-muted">
                SPHEREx cube channel <span className="num text-text">{slice + 1} / 102</span>
                <input type="range" min={0} max={101} value={slice} onChange={(e) => setSlice(+e.target.value)} />
                <span className="text-[11px] text-faint">IRSA DR1 all-sky spectral cube; channels run from 0.75 to 5 µm.</span>
              </label>
            )}
            {[
              [`SPHEREx footprints (detector ${v.det ?? 1})`, showFp, setShowFp, DETECTOR_COLORS[v.det ?? 1]],
              ["Constellation boundaries (IAU)", lay.bounds, (b: boolean) => setLay({ ...lay, bounds: b }), "#a07a2c"],
              ["Constellation figures (traditional)", lay.lines, (b: boolean) => setLay({ ...lay, lines: b }), "#8592a5"],
              ["Known objects — SIMBAD (CDS, in Aladin)", showSimbad, setShowSimbad, "#c9a7ff"],
              ["Galaxies (SIMBAD)", lay.galaxies, (b: boolean) => setLay({ ...lay, galaxies: b }), SERIES[6]],
              ["Nebulae & ISM (SIMBAD)", lay.nebulae, (b: boolean) => setLay({ ...lay, nebulae: b }), SERIES[2]],
              ["Saved candidates", lay.saved, (b: boolean) => setLay({ ...lay, saved: b }), SERIES[3]],
              ["Coverage cells", lay.coverage, (b: boolean) => setLay({ ...lay, coverage: b }), "#3987e5"],
              ["Coordinate grid", showGrid, setShowGrid, "#2b3646"],
            ].map(([label, val, set, color]: any) => (
              <label key={label} className="flex items-center gap-2 text-[12px]">
                <input type="checkbox" checked={val} disabled={label === "Coverage cells" && !cov} onChange={(e) => set(e.target.checked)} />
                <span className="w-2.5 h-2.5 rounded-sm" style={{ background: color }} aria-hidden /> {label}
              </label>
            ))}
            {layerErr && <p className="text-[11px] text-warn" role="status">{layerErr}</p>}
            <p className="text-[11px] text-faint">All layers use ICRS coordinates. Boundaries and figures: d3-celestial v0.7.32 (IAU boundaries; figures are cultural). Object types from SIMBAD (CDS, Harvard mirror fallback).</p>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-[11px] uppercase tracking-wider text-faint">Coverage heatmap (0.5° field)</h3>
            {!cov && !covJob && <><p className="text-[12px] text-muted">Counts images, exposures, independent visits and spectrally matched pairs on a 12×12 grid from every image header in the field.</p><Button onClick={computeCoverage}>Compute coverage</Button></>}
            {covJob && covJob.status !== "done" && !cov && <Progress value={covJob.progress} label={covJob.message} />}
            {cov && (Math.abs(cov.ra - ra) > 0.3 || Math.abs(cov.dec - dec) > 0.3) && <Button variant="ghost" onClick={computeCoverage}>Recompute for this position</Button>}
            {cov && <CoverageHeatmap map={cov} metric={covMetric} onMetric={setCovMetric} onCell={(r, d) => setView({ ra: r, dec: d })} />}
          </section>

          <section className="flex flex-col gap-1">
            <h3 className="text-[11px] uppercase tracking-wider text-faint">Processed candidates in view ({cands.length})</h3>
            {cands.length === 0 && <p className="text-[12px] text-muted">None yet. Run a comparison from the Timeline.</p>}
            {cands.slice(0, 12).map((c) => (
              <Link key={c.id} href={href(`/discovery/${c.id}`, { ra, dec })} className="flex items-center gap-2 py-1 border-b border-line text-[12px] hover:text-accent">
                <span className={`w-1.5 h-1.5 rounded-full ${c.sign > 0 ? "bg-pos" : "bg-neg"}`} />
                <span className="num">{c.id}</span>
                <span className="text-muted truncate">{CLASS_LABEL[c.machine_class]}</span>
                <span className="ml-auto num text-muted">{c.peak_significance.toFixed(1)}σ</span>
              </Link>
            ))}
          </section>
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
