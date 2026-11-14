"use client";

import { fmtDate } from "@/lib/astro";

interface Point { product_id: string; t_mid_mjd?: number; flux_ujy?: number; flux_err_ujy?: number; wave_um?: number; masked_fraction?: number; error?: string; in_image?: boolean }
interface Result { points: Point[]; target_wave_um: number | null; not_measured_different_wavelength: { product_id: string; wave_um: number }[]; not_measured_over_limit: string[]; method: string }

export function LightCurve({ result, highlight }: { result: Result; highlight: number[] }) {
  const pts = result.points.filter((p) => p.flux_ujy != null && p.t_mid_mjd != null) as Required<Point>[];
  if (!pts.length) return <p className="text-[12px] text-muted">No usable measurements. {result.points.map((p) => p.error).filter(Boolean).join("; ")}</p>;
  const W = 640, H = 220, L = 56, B = 28, T = 10, R = 10;
  const t0 = Math.min(...pts.map((p) => p.t_mid_mjd)) - 2, t1 = Math.max(...pts.map((p) => p.t_mid_mjd)) + 2;
  const lo = Math.min(...pts.map((p) => p.flux_ujy - p.flux_err_ujy)), hi = Math.max(...pts.map((p) => p.flux_ujy + p.flux_err_ujy));
  const pad = (hi - lo) * 0.1 || 1;
  const x = (t: number) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - (lo - pad)) / (hi - lo + 2 * pad)) * (H - T - B);
  const yt = [lo, (lo + hi) / 2, hi];
  return (
    <div className="flex flex-col gap-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Forced photometry flux versus time">
        <line x1={L} x2={W - R} y1={H - B} y2={H - B} stroke="#2b3646" />
        <line x1={L} x2={L} y1={T} y2={H - B} stroke="#2b3646" />
        {yt.map((v) => (<g key={v}><line x1={L - 3} x2={W - R} y1={y(v)} y2={y(v)} stroke="#121821" /><text x={L - 6} y={y(v) + 3} fontSize="10" textAnchor="end" fill="#8592a5" className="num">{v.toFixed(0)}</text></g>))}
        <text x={12} y={H / 2} fontSize="10" fill="#8592a5" transform={`rotate(-90 12 ${H / 2})`} textAnchor="middle">flux (µJy)</text>
        <text x={L} y={H - 8} fontSize="10" fill="#8592a5" className="num">{fmtDate(t0, false)}</text>
        <text x={W - R} y={H - 8} fontSize="10" fill="#8592a5" textAnchor="end" className="num">{fmtDate(t1, false)}</text>
        {pts.map((p) => {
          const hl = highlight.some((h) => Math.abs(h - p.t_mid_mjd) < 1e-3);
          return (
            <g key={p.product_id}>
              <line x1={x(p.t_mid_mjd)} x2={x(p.t_mid_mjd)} y1={y(p.flux_ujy - p.flux_err_ujy)} y2={y(p.flux_ujy + p.flux_err_ujy)} stroke={hl ? "#f2b45a" : "#7cc4ff"} />
              <circle cx={x(p.t_mid_mjd)} cy={y(p.flux_ujy)} r={hl ? 4 : 3} fill={hl ? "#f2b45a" : "#7cc4ff"} opacity={p.masked_fraction > 0.3 ? 0.4 : 1}>
                <title>{`${p.product_id}\n${fmtDate(p.t_mid_mjd)}\n${p.flux_ujy.toFixed(1)} ± ${p.flux_err_ujy.toFixed(1)} µJy at ${p.wave_um?.toFixed(4)} µm\nmasked ${(p.masked_fraction * 100).toFixed(0)}%`}</title>
              </circle>
            </g>
          );
        })}
      </svg>
      <p className="text-[11px] text-faint">{result.method} Amber points are the two compared epochs; faded points have &gt;30% masked aperture. {result.not_measured_different_wavelength.length} exposures not measured (different wavelength at this position){result.not_measured_over_limit.length ? `, ${result.not_measured_over_limit.length} over the per-run limit` : ""}.</p>
    </div>
  );
}
