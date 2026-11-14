"use client";

// Minimal scientific scatter/line plot in SVG: one y-axis, optional log axes,
// error bars only where an uncertainty exists, crosshair + tooltip on hover,
// legend for >= 2 series, shaded x-intervals (e.g. coverage gaps).

import { useMemo, useRef, useState } from "react";

export interface PlotPoint {
  x: number;
  y: number;
  yErr?: number | null;
  xErr?: number | null;
  series: string;
  label?: string;
  dim?: boolean;
  id?: string;
}
export interface Series {
  key: string;
  label: string;
  color: string;
  line?: boolean;
}

interface Props {
  points: PlotPoint[];
  series: Series[];
  xLabel: string;
  yLabel: string;
  logY?: boolean;
  height?: number;
  xFormat?: (v: number) => string;
  yFormat?: (v: number) => string;
  shadeX?: { from: number; to: number; label: string }[];
  markersX?: { x: number; label: string }[];
  onPoint?: (p: PlotPoint) => void;
  selectedId?: string;
  ariaLabel: string;
  hLine?: { y: number; label: string };
}

function ticks(lo: number, hi: number, n = 5): number[] {
  const span = hi - lo || 1;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9 * span; v += step) out.push(+v.toPrecision(12));
  return out;
}

export function Plot({ points, series, xLabel, yLabel, logY, height = 280, xFormat, yFormat, shadeX = [], markersX = [],
  onPoint, selectedId, ariaLabel, hLine }: Props) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<PlotPoint | null>(null);
  const W = 760, H = height, L = 62, R = 14, T = 12, B = 40;
  const fy = (v: number) => (logY ? Math.log10(Math.max(v, 1e-30)) : v);
  const usable = points.filter((p) => isFinite(p.x) && isFinite(p.y) && (!logY || p.y > 0));
  const dom = useMemo(() => {
    if (!usable.length) return { x0: 0, x1: 1, y0: 0, y1: 1 };
    const xs = usable.map((p) => p.x);
    const ys = usable.flatMap((p) => (p.yErr && !logY ? [p.y - p.yErr, p.y + p.yErr] : [p.y])).map(fy);
    if (hLine && !logY) ys.push(hLine.y);
    let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const px = (x1 - x0) * 0.04 || Math.abs(x0) * 0.05 || 1;
    const py = (y1 - y0) * 0.08 || Math.abs(y0) * 0.1 || 1;
    x0 -= px; x1 += px; y0 -= py; y1 += py;
    return { x0, x1, y0, y1 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, logY]);
  const sx = (x: number) => L + ((x - dom.x0) / (dom.x1 - dom.x0)) * (W - L - R);
  const sy = (y: number) => T + (1 - (fy(y) - dom.y0) / (dom.y1 - dom.y0)) * (H - T - B);
  const colors = Object.fromEntries(series.map((s) => [s.key, s.color]));
  const xt = ticks(dom.x0, dom.x1, 6);
  const yt = logY
    ? Array.from({ length: Math.floor(dom.y1) - Math.ceil(dom.y0) + 1 }, (_, i) => 10 ** (Math.ceil(dom.y0) + i))
    : ticks(dom.y0, dom.y1, 5);
  const fmtY = yFormat ?? ((v: number) => (Math.abs(v) >= 1000 ? v.toExponential(1) : +v.toPrecision(3) + ""));
  const fmtX = xFormat ?? ((v: number) => +v.toPrecision(4) + "");

  if (!usable.length)
    return <div className="h-40 grid place-items-center text-[12px] text-muted border border-dashed border-line rounded">No measurements to plot.</div>;

  const nearest = (clientX: number, clientY: number) => {
    const b = ref.current!.getBoundingClientRect();
    const mx = ((clientX - b.left) / b.width) * W, my = ((clientY - b.top) / b.height) * H;
    let best: PlotPoint | null = null, bd = 1e9;
    for (const p of usable) {
      const d = Math.hypot(sx(p.x) - mx, sy(p.y) - my);
      if (d < bd) { bd = d; best = p; }
    }
    return bd < 28 ? best : null;
  };

  return (
    <div className="relative">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="w-full h-auto select-none" role="img" aria-label={ariaLabel}
        onMouseMove={(e) => setHover(nearest(e.clientX, e.clientY))} onMouseLeave={() => setHover(null)}
        onClick={(e) => { const p = nearest(e.clientX, e.clientY); if (p && onPoint) onPoint(p); }}>
        {shadeX.map((s, i) => (
          <rect key={i} x={sx(s.from)} y={T} width={Math.max(0, sx(s.to) - sx(s.from))} height={H - T - B} fill="#121821">
            <title>{s.label}</title>
          </rect>
        ))}
        {yt.map((v) => (
          <g key={`y${v}`}>
            <line x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} stroke="#161d27" />
            <text x={L - 6} y={sy(v) + 3} fontSize="10" textAnchor="end" fill="#8592a5" className="num">{fmtY(v)}</text>
          </g>
        ))}
        {xt.map((v) => (
          <text key={`x${v}`} x={sx(v)} y={H - B + 14} fontSize="10" textAnchor="middle" fill="#8592a5" className="num">{fmtX(v)}</text>
        ))}
        <line x1={L} x2={W - R} y1={H - B} y2={H - B} stroke="#2b3646" />
        <line x1={L} x2={L} y1={T} y2={H - B} stroke="#2b3646" />
        <text x={(L + W - R) / 2} y={H - 6} fontSize="11" textAnchor="middle" fill="#8592a5">{xLabel}</text>
        <text x={12} y={(T + H - B) / 2} fontSize="11" textAnchor="middle" fill="#8592a5" transform={`rotate(-90 12 ${(T + H - B) / 2})`}>{yLabel}</text>
        {hLine && <g><line x1={L} x2={W - R} y1={sy(hLine.y)} y2={sy(hLine.y)} stroke="#566275" strokeDasharray="4 4" /><text x={W - R - 4} y={sy(hLine.y) - 4} fontSize="10" textAnchor="end" fill="#8592a5">{hLine.label}</text></g>}
        {markersX.map((m) => (
          <g key={m.label}><line x1={sx(m.x)} x2={sx(m.x)} y1={T} y2={H - B} stroke="#f2b45a" strokeDasharray="2 3" /><text x={sx(m.x) + 3} y={T + 10} fontSize="10" fill="#f2b45a">{m.label}</text></g>
        ))}
        {series.filter((s) => s.line).map((s) => {
          const ps = usable.filter((p) => p.series === s.key && !p.dim).sort((a, b) => a.x - b.x);
          return <polyline key={s.key} points={ps.map((p) => `${sx(p.x)},${sy(p.y)}`).join(" ")} fill="none" stroke={s.color} strokeWidth={2} opacity={0.85} />;
        })}
        {usable.map((p, i) => {
          const c = colors[p.series] ?? "#8592a5";
          const sel = selectedId && p.id === selectedId;
          return (
            <g key={i} opacity={p.dim ? 0.35 : 1}>
              {p.yErr != null && p.yErr > 0 && !logY && (
                <line x1={sx(p.x)} x2={sx(p.x)} y1={sy(p.y - p.yErr)} y2={sy(p.y + p.yErr)} stroke={c} strokeWidth={1.25} />
              )}
              {p.xErr != null && p.xErr > 0 && (
                <line x1={sx(p.x - p.xErr)} x2={sx(p.x + p.xErr)} y1={sy(p.y)} y2={sy(p.y)} stroke={c} strokeWidth={1} opacity={0.6} />
              )}
              <circle cx={sx(p.x)} cy={sy(p.y)} r={sel ? 5 : 3.5} fill={c} stroke="#0d1117" strokeWidth={2} />
              {sel && <circle cx={sx(p.x)} cy={sy(p.y)} r={8} fill="none" stroke="#fff" strokeWidth={1} />}
            </g>
          );
        })}
        {hover && <line x1={sx(hover.x)} x2={sx(hover.x)} y1={T} y2={H - B} stroke="#566275" strokeDasharray="2 2" />}
      </svg>
      {hover && (
        <div className="absolute pointer-events-none bg-panel-2 border border-line-strong rounded px-2 py-1 text-[11px] num shadow-lg"
          style={{ left: `${(sx(hover.x) / W) * 100}%`, top: `${(sy(hover.y) / H) * 100}%`, transform: "translate(8px,-110%)" }}>
          {hover.label ?? `${fmtX(hover.x)}, ${fmtY(hover.y)}`}
        </div>
      )}
      {series.length >= 2 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1 text-[11px] text-muted" aria-label="Legend">
          {series.map((s) => <span key={s.key} className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full" style={{ background: s.color }} />{s.label}</span>)}
        </div>
      )}
    </div>
  );
}
