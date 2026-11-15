"use client";

import { useState } from "react";
import type { CoverageMap } from "@/lib/api";
import { inputCls } from "./ui";

export const METRICS: Record<string, { label: string; help: string }> = {
  visits: { label: "Independent visits", help: "Exposures within 0.5 day count as one visit (epoch)" },
  exposures: { label: "Exposures", help: "Distinct exposures (each has six simultaneous detector images)" },
  images: { label: "Images", help: "Detector images — not independent epochs" },
  pairs: { label: "Matched pairs", help: "Same-detector exposure pairs at the same wavelength (±½ bandwidth), ≥ 0.5 d apart" },
  detectors: { label: "Detectors", help: "Number of the six detectors with coverage" },
};

// Sequential single-hue ramp (amber) for the graphite surface: low = dim, high = bright.
export function seqColor(t: number): string {
  const a = [52, 44, 32], b = [240, 200, 98];
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export function CoverageHeatmap({ map, metric, onMetric, onCell, detector }: {
  map: CoverageMap; metric: string; onMetric: (m: string) => void; onCell?: (ra: number, dec: number) => void; detector?: number;
}) {
  const [hover, setHover] = useState<{ i: number; j: number } | null>(null);
  const grid = metric === "pairs" && detector ? map.layers.pairs_by_detector[String(detector)] : map.layers[metric];
  const n = map.cells;
  const max = Math.max(1, ...grid.flat());
  const S = 300, c = S / n;
  const val = hover ? grid[hover.j][hover.i] : null;
  return (
    <div className="flex flex-col gap-2 text-[12px]">
      <label className="flex items-center gap-2 text-muted">Count
        <select className={`${inputCls} flex-1`} value={metric} onChange={(e) => onMetric(e.target.value)}>
          {Object.entries(METRICS).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
        </select>
      </label>
      <svg viewBox={`0 0 ${S} ${S}`} className="w-full h-auto border border-line" role="img" aria-label={`Coverage map: ${METRICS[metric].label}`} onMouseLeave={() => setHover(null)}>
        {grid.map((row, j) => row.map((v, i) => (
          // row 0 is the south edge: draw north up; column 0 is east: draw east on the left
          <rect key={`${i}-${j}`} x={i * c} y={(n - 1 - j) * c} width={c - 1} height={c - 1}
            fill={v > 0 ? seqColor(v / max) : "var(--plate)"} stroke={hover?.i === i && hover?.j === j ? "var(--text)" : "none"}
            onMouseEnter={() => setHover({ i, j })} onClick={() => onCell?.(map.cell_ra[j][i], map.cell_dec[j][i])} className="cursor-pointer" />
        )))}
        <circle cx={S / 2} cy={S / 2} r={3} fill="none" stroke="var(--text)" />
      </svg>
      <div className="flex items-center gap-2 text-[10px] text-faint">
        <span>0</span><div className="h-1.5 flex-1" style={{ background: `linear-gradient(90deg, ${seqColor(0)}, ${seqColor(1)})` }} /><span className="num">{max}</span>
      </div>
      <p className="num text-faint text-[11px] min-h-[2.5em]">{hover ? `${map.cell_ra[hover.j][hover.i].toFixed(3)}, ${map.cell_dec[hover.j][hover.i].toFixed(3)} — ${METRICS[metric].label}: ${val}; visits ${map.layers.visits[hover.j][hover.i]}, exposures ${map.layers.exposures[hover.j][hover.i]}, images ${map.layers.images[hover.j][hover.i]}, pairs ${map.layers.pairs[hover.j][hover.i]}` : METRICS[metric].help}</p>
      <p className="text-faint text-[11px]">{map.size_deg}° field, {n}×{n} cells of {map.cell_size_arcmin.toFixed(1)}′, {map.n_products_queried} archive images. North up, east left. {map.method}</p>
    </div>
  );
}
