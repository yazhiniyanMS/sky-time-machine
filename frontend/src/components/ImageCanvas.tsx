"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Layer } from "@/lib/api";
import { type Cmap, type Limits, type Stretch, toRGBA } from "@/lib/render";
import { KindBadge } from "./ui";

export interface View {
  zoom: number; // screen px per image px, relative to fit
  cx: number; // image-centre offset in image px
  cy: number;
}
export const DEFAULT_VIEW: View = { zoom: 1, cx: 0, cy: 0 };

export interface Marker {
  id: string;
  x: number; // array column (0-based)
  y: number; // array row (0-based, FITS orientation)
  sign: number;
  r: number; // radius in image px
  selected?: boolean;
  dim?: boolean;
}

interface Props {
  layer: Layer | null;
  title: string;
  kind: "original" | "derived";
  subtitle?: string;
  limits: Limits;
  stretch: Stretch;
  cmap: Cmap;
  view: View;
  onView: (v: View) => void;
  markers?: Marker[];
  onMarker?: (id: string) => void;
  unit?: string;
  className?: string;
  showMarkers?: boolean;
}

export function ImageCanvas({ layer, title, kind, subtitle, limits, stretch, cmap, view, onView, markers = [], onMarker, unit, className = "", showMarkers = true }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 300, h: 300 });
  const [hover, setHover] = useState<{ x: number; y: number; v: number } | null>(null);
  const drag = useRef<{ x: number; y: number; v: View } | null>(null);

  const bitmap = useMemo(() => {
    if (!layer || typeof document === "undefined") return null;
    const c = document.createElement("canvas");
    c.width = layer.cols;
    c.height = layer.rows;
    c.getContext("2d")!.putImageData(toRGBA(layer.data, layer.rows, layer.cols, limits, stretch, cmap), 0, 0);
    return c;
  }, [layer, limits, stretch, cmap]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scale = layer ? Math.min(size.w / layer.cols, size.h / layer.rows) * view.zoom : 1;
  // screen position of an image pixel centre (display orientation: north up)
  const toScreen = useCallback(
    (x: number, yFits: number) => {
      if (!layer) return { sx: 0, sy: 0 };
      const yd = layer.rows - 1 - yFits;
      return {
        sx: size.w / 2 + (x + 0.5 - layer.cols / 2 - view.cx) * scale,
        sy: size.h / 2 + (yd + 0.5 - layer.rows / 2 - view.cy) * scale,
      };
    },
    [layer, size, view, scale],
  );

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "#000";
    g.fillRect(0, 0, size.w, size.h);
    if (!bitmap || !layer) return;
    g.imageSmoothingEnabled = false;
    const x0 = size.w / 2 - (layer.cols / 2 + view.cx) * scale;
    const y0 = size.h / 2 - (layer.rows / 2 + view.cy) * scale;
    g.drawImage(bitmap, x0, y0, layer.cols * scale, layer.rows * scale);
    if (!showMarkers) return;
    for (const m of markers) {
      const { sx, sy } = toScreen(m.x, m.y);
      const rr = Math.max(6, m.r * scale);
      g.beginPath();
      g.arc(sx, sy, rr, 0, Math.PI * 2);
      g.lineWidth = m.selected ? 2 : 1.25;
      g.strokeStyle = m.dim ? "rgba(140,150,165,0.6)" : m.sign > 0 ? "#ff8a5c" : "#5cc8ff";
      if (m.dim) g.setLineDash([3, 3]);
      g.stroke();
      g.setLineDash([]);
      if (m.selected) {
        g.beginPath();
        g.arc(sx, sy, rr + 5, 0, Math.PI * 2);
        g.strokeStyle = "rgba(255,255,255,0.8)";
        g.lineWidth = 1;
        g.stroke();
      }
    }
  }, [bitmap, layer, size, view, scale, markers, toScreen, showMarkers]);

  const imgCoord = (ev: React.PointerEvent | React.MouseEvent) => {
    if (!layer || !ref.current) return null;
    const b = ref.current.getBoundingClientRect();
    const px = ev.clientX - b.left, py = ev.clientY - b.top;
    const x = (px - size.w / 2) / scale + layer.cols / 2 + view.cx;
    const yd = (py - size.h / 2) / scale + layer.rows / 2 + view.cy;
    return { x: Math.floor(x), y: layer.rows - 1 - Math.floor(yd), px, py };
  };

  const onKey = (e: React.KeyboardEvent) => {
    const step = 4 / Math.max(scale, 0.01) * 4;
    const m: Record<string, View> = {
      "+": { ...view, zoom: Math.min(view.zoom * 1.25, 40) },
      "=": { ...view, zoom: Math.min(view.zoom * 1.25, 40) },
      "-": { ...view, zoom: Math.max(view.zoom / 1.25, 0.5) },
      ArrowLeft: { ...view, cx: view.cx - step },
      ArrowRight: { ...view, cx: view.cx + step },
      ArrowUp: { ...view, cy: view.cy - step },
      ArrowDown: { ...view, cy: view.cy + step },
      "0": DEFAULT_VIEW,
    };
    if (m[e.key]) {
      e.preventDefault();
      onView(m[e.key]);
    }
  };

  return (
    <figure className={`relative flex flex-col border border-line rounded-md overflow-hidden bg-black ${className}`}>
      <figcaption className="flex items-center gap-2 px-2 h-8 bg-panel border-b border-line text-[12px]">
        <KindBadge kind={kind} />
        <span className="font-medium truncate">{title}</span>
        {subtitle && <span className="text-faint truncate hidden sm:inline">{subtitle}</span>}
      </figcaption>
      <div ref={wrap} className="relative flex-1 min-h-[180px]">
        <canvas
          ref={ref}
          tabIndex={0}
          role="img"
          aria-label={`${title}. Use + and - to zoom, arrow keys to pan, 0 to reset.`}
          className="absolute inset-0 w-full h-full cursor-crosshair touch-none"
          onKeyDown={onKey}
          onWheel={(e) => {
            const z = Math.min(40, Math.max(0.5, view.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
            onView({ ...view, zoom: z });
          }}
          onPointerDown={(e) => {
            (e.target as Element).setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY, v: view };
          }}
          onPointerUp={(e) => {
            const d = drag.current;
            drag.current = null;
            if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4 && onMarker) {
              const p = imgCoord(e);
              if (!p) return;
              let best: { id: string; d: number } | null = null;
              for (const m of markers) {
                const s = toScreen(m.x, m.y);
                const dd = Math.hypot(s.sx - p.px, s.sy - p.py);
                if (dd < Math.max(12, m.r * scale + 4) && (!best || dd < best.d)) best = { id: m.id, d: dd };
              }
              if (best) onMarker(best.id);
            }
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (d) {
              onView({ ...d.v, cx: d.v.cx - (e.clientX - d.x) / scale, cy: d.v.cy - (e.clientY - d.y) / scale });
              return;
            }
            const p = imgCoord(e);
            if (p && layer && p.x >= 0 && p.y >= 0 && p.x < layer.cols && p.y < layer.rows)
              setHover({ x: p.x, y: p.y, v: layer.data[p.y * layer.cols + p.x] });
            else setHover(null);
          }}
          onPointerLeave={() => setHover(null)}
        />
        {!layer && <div className="absolute inset-0 grid place-items-center text-faint text-[12px]">Loading…</div>}
        <div className="absolute bottom-1 left-1 right-1 flex justify-between text-[10px] num text-muted pointer-events-none">
          <span>{hover ? `x ${hover.x}  y ${hover.y}  ${isFinite(hover.v) ? hover.v.toPrecision(4) : "masked"}${unit && isFinite(hover.v) ? " " + unit : ""}` : "N↑ E←"}</span>
          <span>{view.zoom.toFixed(1)}×</span>
        </div>
      </div>
    </figure>
  );
}
