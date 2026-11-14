"use client";

// Aladin Lite v3 (CDS, GPL-3) loaded at runtime as an ES module from jsDelivr
// at a pinned version. All overlay data comes from the archive or our API.

import { useEffect, useRef, useState } from "react";

const ALADIN_URL = "https://cdn.jsdelivr.net/npm/aladin-lite@3.8.2/dist/aladin.js";

export interface Footprint {
  id: string;
  polygon: [number, number][];
  color: string;
  label: string;
}
export interface SkyMarker {
  id: string;
  ra: number;
  dec: number;
  color: string;
  label: string;
  selected?: boolean;
}

export const SPHEREX_HIPS = "https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube";
// HiPS served from the IRSA mirrors (same host as the SPHEREx data).
export const SURVEYS = [
  { id: "dss2", label: "DSS2 colour (optical)", url: "https://irsa.ipac.caltech.edu/data/hips/CDS/DSS2/color" },
  { id: "2mass", label: "2MASS colour (near-IR)", url: "https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/Color" },
  { id: "spherex", label: "SPHEREx DR1 all-sky cube (IRSA HiPS)", url: SPHEREX_HIPS },
] as const;

interface Props {
  ra: number;
  dec: number;
  fov: number;
  survey: string;
  cubeSlice: number;
  footprints: Footprint[];
  markers: SkyMarker[];
  showSimbad: boolean;
  showGrid: boolean;
  onMove: (ra: number, dec: number, fov: number) => void;
  onMarkerClick?: (id: string) => void;
}

let aladinModule: Promise<any> | null = null;
function loadAladin(): Promise<any> {
  if (!aladinModule) {
    aladinModule = import(/* webpackIgnore: true */ ALADIN_URL).then(async (m) => {
      const A = m.default ?? m.A ?? m;
      await A.init;
      return A;
    });
    aladinModule.catch(() => (aladinModule = null));
  }
  return aladinModule;
}

export function SkyMap(p: Props) {
  const div = useRef<HTMLDivElement>(null);
  const al = useRef<{ A: any; aladin: any; fp: any; cat: any; simbad: any; hips: any } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const onMove = useRef(p.onMove);
  onMove.current = p.onMove;
  const onClick = useRef(p.onMarkerClick);
  onClick.current = p.onMarkerClick;
  const suppress = useRef(false);

  useEffect(() => {
    let cancelled = false;
    loadAladin()
      .then((A) => {
        if (cancelled || !div.current) return;
        const initial = SURVEYS.find((x) => x.id === p.survey) ?? SURVEYS[0];
        const aladin = A.aladin(div.current, {
          survey: initial.url,
          log: false,
          fov: p.fov,
          target: `${p.ra} ${p.dec}`,
          cooFrame: "ICRS",
          showReticle: true,
          showCooGrid: p.showGrid,
          showCooGridControl: false,
          showLayersControl: false,
          showGotoControl: false,
          showFullscreenControl: false,
          showSimbadPointerControl: false,
          showProjectionControl: false,
          showFrame: false,
          showZoomControl: true,
          showContextMenu: false,
        });
        const fp = A.graphicOverlay({ lineWidth: 1.5 });
        aladin.addOverlay(fp);
        const cat = A.catalog({ name: "Candidates", sourceSize: 14, shape: "circle" });
        aladin.addCatalog(cat);
        al.current = { A, aladin, fp, cat, simbad: null, hips: null };
        let t: ReturnType<typeof setTimeout> | undefined;
        const emit = () => {
          if (suppress.current) return;
          clearTimeout(t);
          t = setTimeout(() => {
            const [ra, dec] = aladin.getRaDec();
            const fov = aladin.getFov()[0];
            onMove.current(((ra % 360) + 360) % 360, dec, fov);
          }, 350);
        };
        aladin.on("positionChanged", emit);
        aladin.on("zoomChanged", emit);
        aladin.on("objectClicked", (o: any) => {
          const id = o?.data?.id;
          if (id) onClick.current?.(id);
        });
        setReady(true);
      })
      .catch((e) => setErr(`Sky viewer could not load (${String(e?.message || e)}). Check network access to cdn.jsdelivr.net.`));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External position changes (search, URL)
  useEffect(() => {
    const a = al.current?.aladin;
    if (!a) return;
    const [ra, dec] = a.getRaDec();
    const fov = a.getFov()[0];
    const moved = Math.abs(ra - p.ra) * Math.cos((p.dec * Math.PI) / 180) > fov * 0.01 || Math.abs(dec - p.dec) > fov * 0.01;
    const zoomed = Math.abs(fov - p.fov) / p.fov > 0.02;
    if (moved || zoomed) {
      suppress.current = true;
      if (moved) a.gotoRaDec(p.ra, p.dec);
      if (zoomed) a.setFoV(p.fov);
      setTimeout(() => (suppress.current = false), 500);
    }
  }, [p.ra, p.dec, p.fov, ready]);

  // Background survey
  useEffect(() => {
    const c = al.current;
    if (!c) return;
    try {
      const sv = SURVEYS.find((x) => x.id === p.survey) ?? SURVEYS[0];
      const h = c.A.imageHiPS(sv.url, { name: sv.label, ...(sv.id === "spherex" ? { imgFormat: "png" } : {}) });
      c.hips = sv.id === "spherex" ? h : null;
      c.aladin.setBaseImageLayer(h);
    } catch (e) {
      setErr(`Could not switch background survey: ${String(e)}`);
    }
  }, [p.survey, ready]);

  useEffect(() => {
    const h = al.current?.hips;
    if (h && typeof h.setSliceNumber === "function") {
      try {
        h.setSliceNumber(p.cubeSlice);
      } catch {}
    }
  }, [p.cubeSlice, p.survey, ready]);

  useEffect(() => {
    const a = al.current?.aladin;
    if (!a) return;
    try {
      if (a.setCooGrid) a.setCooGrid({ enabled: p.showGrid });
      else if (p.showGrid) a.showCooGrid();
      else a.hideCooGrid();
    } catch {}
  }, [p.showGrid, ready]);

  // Footprints
  useEffect(() => {
    const c = al.current;
    if (!c) return;
    // Replace the overlay wholesale: clearing an overlay in place is unreliable in Aladin 3.8.
    try {
      c.fp.hide?.();
      c.aladin.removeLayer?.(c.fp);
    } catch {}
    c.fp = c.A.graphicOverlay({ lineWidth: 1.2 });
    c.aladin.addOverlay(c.fp);
    for (const f of p.footprints) c.fp.add(c.A.polygon(f.polygon, { color: f.color, lineWidth: 1 }));
  }, [p.footprints, ready]);

  // Candidate markers
  useEffect(() => {
    const c = al.current;
    if (!c) return;
    c.cat.removeAll();
    c.cat.addSources(
      p.markers.map((m) =>
        c.A.source(m.ra, m.dec, { id: m.id, label: m.label }, { color: m.selected ? "#ffffff" : m.color }),
      ),
    );
    c.cat.updateShape?.({ color: (s: any) => p.markers.find((m) => m.id === s.data.id)?.color ?? "#fff" });
  }, [p.markers, ready]);

  // SIMBAD catalogue (CDS) around the current position
  useEffect(() => {
    const c = al.current;
    if (!c) return;
    if (c.simbad) {
      c.aladin.removeLayer?.(c.simbad);
      c.simbad = null;
    }
    if (p.showSimbad) {
      const rad = Math.min(1, p.fov / 2);
      c.simbad = c.A.catalogFromSimbad({ ra: p.ra, dec: p.dec }, rad, { name: "SIMBAD", color: "#c9a7ff", sourceSize: 8, onClick: "showPopup" });
      c.aladin.addCatalog(c.simbad);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.showSimbad, ready, p.showSimbad ? `${p.ra.toFixed(2)},${p.dec.toFixed(2)},${p.fov.toFixed(2)}` : ""]);

  return (
    <div className="absolute inset-0">
      {/* Aladin restyles its container (position: relative), so it gets an explicitly sized child. */}
      <div className="absolute inset-0">
        <div ref={div} style={{ width: "100%", height: "100%" }} aria-label="Interactive sky map" />
      </div>
      {!ready && !err && <div className="absolute inset-0 grid place-items-center text-faint text-sm">Loading sky viewer…</div>}
      {err && <div className="absolute inset-x-4 top-20 border border-bad/40 bg-panel text-bad text-sm rounded px-3 py-2">{err}</div>}
    </div>
  );
}
