"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Comparison, fetchLayer, type Layer } from "@/lib/api";
import { CLASS_LABEL, fmtDate } from "@/lib/astro";
import { type Limits, percentileLimits, type Stretch } from "@/lib/render";
import { href } from "@/lib/viewstate";
import { DEFAULT_VIEW, ImageCanvas, type Marker, type View } from "./ImageCanvas";
import { Button, KindBadge, TierBadge } from "./ui";

type Mode = "blink" | "side" | "diff";
const LAYERS = ["a", "b", "diff", "significance", "sigma", "valid", "dlambda_frac"] as const;

export function ComparisonViewer({ comp, mode, onMode, selected, onSelect }: {
  comp: Comparison; mode: Mode; onMode: (m: Mode) => void; selected?: string; onSelect: (id: string) => void;
}) {
  const [layers, setLayers] = useState<Partial<Record<(typeof LAYERS)[number], Layer>>>({});
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [stretch, setStretch] = useState<Stretch>("asinh");
  const [pLo, setPLo] = useState(1);
  const [pHi, setPHi] = useState(99.5);
  const [sigLim, setSigLim] = useState(6);
  const [hz, setHz] = useState(2);
  const [playing, setPlaying] = useState(true);
  const [reverse, setReverse] = useState(false);
  const [frame, setFrame] = useState(0);
  const [showRejected, setShowRejected] = useState(false);
  const [showMarkers, setShowMarkers] = useState(true);
  const blinkRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let off = false;
    LAYERS.forEach((n) => fetchLayer(comp.id, n).then((l) => !off && setLayers((s) => ({ ...s, [n]: l }))).catch(() => {}));
    return () => { off = true; };
  }, [comp.id]);

  // Common limits for both epochs so the blink compares like with like.
  const origLim: Limits = useMemo(() => {
    if (!layers.a || !layers.b) return { lo: 0, hi: 1 };
    const both = new Float32Array(layers.a.data.length + layers.b.data.length);
    both.set(layers.a.data);
    both.set(layers.b.data, layers.a.data.length);
    return percentileLimits(both, pLo, pHi);
  }, [layers.a, layers.b, pLo, pHi]);
  const diffLim: Limits = useMemo(() => {
    if (!layers.sigma) return { lo: -1, hi: 1 };
    const s = percentileLimits(layers.sigma.data, 50, 50);
    return { lo: -sigLim * s.lo, hi: sigLim * s.lo };
  }, [layers.sigma, sigLim]);
  const sigmaLim = useMemo(() => (layers.sigma ? percentileLimits(layers.sigma.data, 1, 99) : { lo: 0, hi: 1 }), [layers.sigma]);

  useEffect(() => {
    if (mode !== "blink" || !playing) return;
    const t = setInterval(() => setFrame((f) => (f + (reverse ? -1 : 1) + 2) % 2), 1000 / (2 * hz));
    return () => clearInterval(t);
  }, [mode, playing, hz, reverse]);

  const onKey = useCallback((e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "SELECT") return;
    if (e.key === " " && mode === "blink") { e.preventDefault(); setPlaying((p) => !p); }
    if (e.key === "r" && mode === "blink") setReverse((r) => !r);
    if ((e.key === "," || e.key === ".") && mode === "blink") { setPlaying(false); setFrame((f) => 1 - f); }
  }, [mode]);
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  const cands = (comp.candidates ?? []).filter((c) => showRejected || !c.rejected);
  const fwhmPix = (comp.provenance.metrics?.psf_fwhm_a_arcsec ?? 7.5) / (comp.provenance.grid?.pixscale_arcsec ?? 6.15);
  const markers: Marker[] = cands.map((c) => ({ id: c.id, x: c.x_pix, y: c.y_pix, sign: c.sign, r: 1.5 * fwhmPix, selected: c.id === selected, dim: c.rejected }));
  const inA = comp.provenance.inputs?.[0], inB = comp.provenance.inputs?.[1];
  const dateA = fmtDate(comp.t_a_mjd), dateB = fmtDate(comp.t_b_mjd);
  const common = { view, onView: setView, markers, onMarker: onSelect, showMarkers };

  const tabs: { id: Mode; label: string }[] = [{ id: "blink", label: "Blink" }, { id: "side", label: "Side by side" }, { id: "diff", label: "Difference" }];

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" className="flex border border-line rounded overflow-hidden">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={mode === t.id} onClick={() => onMode(t.id)}
              className={`h-8 px-3 text-[13px] ${mode === t.id ? "bg-panel-2 text-text" : "text-muted hover:text-text"}`}>{t.label}</button>
          ))}
        </div>
        <label className="flex items-center gap-1 text-[12px] text-muted ml-2">Stretch
          <select value={stretch} onChange={(e) => setStretch(e.target.value as Stretch)} className="h-7 bg-bg border border-line-strong rounded px-1 text-text">
            <option value="linear">linear</option><option value="sqrt">sqrt</option><option value="asinh">asinh</option><option value="log">log</option>
          </select>
        </label>
        <label className="flex items-center gap-1 text-[12px] text-muted">Range
          <input aria-label="Lower percentile" type="number" min={0} max={50} step={0.5} value={pLo} onChange={(e) => setPLo(+e.target.value)} className="w-14 h-7 bg-bg border border-line-strong rounded px-1 num text-text" />
          –
          <input aria-label="Upper percentile" type="number" min={50} max={100} step={0.1} value={pHi} onChange={(e) => setPHi(+e.target.value)} className="w-16 h-7 bg-bg border border-line-strong rounded px-1 num text-text" />%
        </label>
        <label className="flex items-center gap-1 text-[12px] text-muted">Diff ±
          <input type="range" min={2} max={30} value={sigLim} onChange={(e) => setSigLim(+e.target.value)} aria-label="Difference display range in sigma" />
          <span className="num w-8">{sigLim}σ</span>
        </label>
        <label className="flex items-center gap-1 text-[12px] text-muted"><input type="checkbox" checked={showMarkers} onChange={(e) => setShowMarkers(e.target.checked)} />Candidates</label>
        <label className="flex items-center gap-1 text-[12px] text-muted"><input type="checkbox" checked={showRejected} onChange={(e) => setShowRejected(e.target.checked)} />Show rejected</label>
        <Button variant="ghost" className="ml-auto" onClick={() => setView(DEFAULT_VIEW)}>Reset view</Button>
      </div>

      {mode === "blink" && (
        <div ref={blinkRef} className="flex flex-col gap-2 bg-bg">
          <div className="flex flex-wrap items-center gap-3 text-[12px]">
            <Button onClick={() => setPlaying((p) => !p)} aria-label={playing ? "Pause blink" : "Play blink"}>{playing ? "Pause" : "Play"}</Button>
            <Button onClick={() => setReverse((r) => !r)} aria-pressed={reverse}>{reverse ? "Reverse ◀" : "Forward ▶"}</Button>
            <Button onClick={() => { setPlaying(false); setFrame((f) => 1 - f); }}>Step</Button>
            <label className="flex items-center gap-2 text-muted">Flicker
              <input type="range" min={0.25} max={8} step={0.25} value={hz} onChange={(e) => setHz(+e.target.value)} aria-label="Blink frequency in hertz" />
              <span className="num text-text w-12">{hz.toFixed(2)} Hz</span>
            </label>
            <Button variant="ghost" onClick={() => blinkRef.current?.requestFullscreen?.()}>Full screen</Button>
            <span className="text-faint hidden md:inline">Space play/pause · R reverse · , step · scroll zoom · drag pan</span>
          </div>
          <div className="relative">
            <ImageCanvas {...common} className="h-[min(70dvh,720px)]" layer={frame === 0 ? layers.a ?? null : layers.b ?? null}
              title={frame === 0 ? `Epoch A · ${dateA}` : `Epoch B · ${dateB}`} subtitle={frame === 0 ? comp.product_a : comp.product_b}
              kind="original" limits={origLim} stretch={stretch} cmap="gray" unit="MJy/sr" />
            <div aria-live="polite" className={`absolute top-10 right-3 px-2 py-1 rounded text-[13px] num font-semibold ${frame === 0 ? "bg-neg/20 text-neg" : "bg-pos/20 text-pos"}`}>
              {frame === 0 ? "A" : "B"} · {frame === 0 ? dateA : dateB}
            </div>
          </div>
        </div>
      )}

      {mode === "side" && (
        <div className="grid md:grid-cols-2 gap-2">
          <ImageCanvas {...common} className="h-[min(60dvh,600px)]" layer={layers.a ?? null} title={`Epoch A · ${dateA}`} subtitle={comp.product_a} kind="original" limits={origLim} stretch={stretch} cmap="gray" unit="MJy/sr" />
          <ImageCanvas {...common} className="h-[min(60dvh,600px)]" layer={layers.b ?? null} title={`Epoch B · ${dateB}`} subtitle={comp.product_b} kind="original" limits={origLim} stretch={stretch} cmap="gray" unit="MJy/sr" />
        </div>
      )}

      {mode === "diff" && (
        <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-2">
          <ImageCanvas {...common} className="h-72" layer={layers.a ?? null} title={`A · ${dateA}`} kind="original" limits={origLim} stretch={stretch} cmap="gray" unit="MJy/sr" />
          <ImageCanvas {...common} className="h-72" layer={layers.b ?? null} title={`B · ${dateB}`} kind="original" limits={origLim} stretch={stretch} cmap="gray" unit="MJy/sr" />
          <ImageCanvas {...common} className="h-72" layer={layers.diff ?? null} title="Difference B − A" subtitle="orange brighter · blue fainter" kind="derived" limits={diffLim} stretch="linear" cmap="diverging" unit="MJy/sr" />
          <ImageCanvas {...common} className="h-72" layer={layers.significance ?? null} title="Significance (B − A)/σ" kind="derived" limits={{ lo: -sigLim, hi: sigLim }} stretch="linear" cmap="diverging" unit="σ" />
          <ImageCanvas {...common} className="h-72" layer={layers.sigma ?? null} title="Uncertainty σ" subtitle="propagated, rescaled" kind="derived" limits={sigmaLim} stretch="linear" cmap="inferno" unit="MJy/sr" />
          <ImageCanvas {...common} className="h-72" layer={layers.valid ?? null} title="Usable-pixel mask" subtitle="green = used; hatched = no data" kind="derived" limits={{ lo: 0, hi: 1 }} stretch="linear" cmap="mask" />
          <ImageCanvas {...common} className="h-72" layer={layers.dlambda_frac ?? null} title="|λA − λB| / bandwidth" kind="derived" limits={{ lo: 0, hi: 1 }} stretch="linear" cmap="inferno" />
          <div className="border border-line rounded-md p-3 text-[12px] text-muted flex flex-col gap-2">
            <div className="flex gap-2 items-center"><KindBadge kind="original" /> archive IMAGE pixels, resampled (bilinear) to a common TAN grid; no background removed.</div>
            <div className="flex gap-2 items-center"><KindBadge kind="derived" /> computed by this pipeline ({comp.pipeline_version}).</div>
            <p>Hatched pixels are masked: archive quality flags, outside a footprint, or observed at different wavelengths in A and B.</p>
            <p className="num">Display limits are visual only; hover any pixel for its stored value.</p>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-faint num">
        <span>A: {inA?.access_url ? <a className="hover:text-accent" href={inA.access_url}>{comp.product_a}</a> : comp.product_a}</span>
        <span>B: {inB?.access_url ? <a className="hover:text-accent" href={inB.access_url}>{comp.product_b}</a> : comp.product_b}</span>
        <span>{(inA?.synthetic || inB?.synthetic) ? "⚠ SYNTHETIC test inputs" : "Source: NASA/IPAC IRSA SPHEREx DR1"}</span>
      </div>

      <CandidateTable comp={comp} selected={selected} onSelect={onSelect} showRejected={showRejected} />
    </div>
  );
}

function CandidateTable({ comp, selected, onSelect, showRejected }: { comp: Comparison; selected?: string; onSelect: (id: string) => void; showRejected: boolean }) {
  const rows = (comp.candidates ?? []).filter((c) => showRejected || !c.rejected);
  return (
    <section className="border border-line rounded-md bg-panel">
      <header className="h-9 px-3 flex items-center border-b border-line text-[12px] uppercase tracking-wider text-muted">
        Ranked candidates ({rows.length}) <span className="ml-3 normal-case tracking-normal text-faint">ordered by quality tier, then |peak significance|</span>
      </header>
      {rows.length === 0 ? (
        <p className="p-3 text-[13px] text-muted">
          {comp.status === "rejected" ? "This comparison was rejected before detection (see quality checks)." : "No change above the 5σ detection threshold in the usable area."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead className="text-faint text-left"><tr className="border-b border-line">
              <th className="px-3 py-1 font-normal">#</th><th className="font-normal">ID</th><th className="font-normal">Tier</th>
              <th className="font-normal">Machine class</th><th className="font-normal text-right">Peak</th>
              <th className="font-normal text-right">ΔF (µJy)</th><th className="font-normal text-right">σ pos</th><th className="font-normal px-3">RA, Dec</th>
            </tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} onClick={() => onSelect(c.id)} className={`border-b border-line/60 cursor-pointer hover:bg-panel-2 ${c.id === selected ? "bg-panel-2" : ""} ${c.rejected ? "opacity-50" : ""}`}>
                  <td className="px-3 py-1 num text-muted">{c.rank_in_comparison}</td>
                  <td className="num"><Link className="hover:text-accent" href={href(`/discovery/${c.id}`, {})} onClick={(e) => e.stopPropagation()}>{c.id}</Link></td>
                  <td><TierBadge tier={c.quality_tier} /></td>
                  <td>{CLASS_LABEL[c.machine_class] ?? c.machine_class}</td>
                  <td className={`num text-right ${c.sign > 0 ? "text-pos" : "text-neg"}`}>{c.peak_significance >= 0 ? "+" : ""}{c.peak_significance.toFixed(1)}σ</td>
                  <td className="num text-right">{c.diff_flux_ujy.toFixed(0)} ± {c.diff_flux_err_ujy.toFixed(0)}</td>
                  <td className="num text-right">{c.pos_err_arcsec.toFixed(1)}″</td>
                  <td className="num px-3 text-muted">{c.ra.toFixed(5)}, {c.dec.toFixed(5)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
