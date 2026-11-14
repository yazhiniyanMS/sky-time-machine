"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { SearchBox } from "@/components/SearchBox";
import { type Footprint, SkyMap, type SkyMarker, SURVEYS } from "@/components/SkyMap";
import { ErrorNote, f } from "@/components/ui";
import { type CandidateBrief, get, type ObservationsResponse } from "@/lib/api";
import { BANDS, CLASS_LABEL, DETECTOR_COLORS, decDms, fmtDate, raHms } from "@/lib/astro";
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

  const range = obs?.exposures.length ? [obs.exposures[0].t_mid_mjd, obs.exposures[obs.exposures.length - 1].t_mid_mjd] : null;
  const stale = obsAt && (Math.abs(obsAt.ra - ra) > 0.05 || Math.abs(obsAt.dec - dec) > 0.05);

  return (
    <div className="relative flex-1 min-h-[calc(100dvh-3rem)]">
      <SkyMap
        ra={ra} dec={dec} fov={fov} survey={survey} cubeSlice={slice} footprints={footprints} markers={markers}
        showSimbad={showSimbad} showGrid={showGrid}
        onMove={(r, d, fv) => setView({ ra: r, dec: d, fov: fv })}
        onMarkerClick={(id) => router.push(href(`/discovery/${id}`, { ra, dec }))}
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
              [`SPHEREx footprints (detector ${v.det ?? 1})`, showFp, setShowFp],
              ["SIMBAD objects (CDS)", showSimbad, setShowSimbad],
              ["Coordinate grid", showGrid, setShowGrid],
            ].map(([label, val, set]: any) => (
              <label key={label} className="flex items-center gap-2 text-[12px]">
                <input type="checkbox" checked={val} onChange={(e) => set(e.target.checked)} /> {label}
              </label>
            ))}
            <p className="text-[11px] text-faint">Constellation shown is the IAU constellation containing the map centre; figure lines are not drawn.</p>
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
