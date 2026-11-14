// Display stretches and colour maps for float images. Rendering is purely
// visual: it never changes the underlying values shown in tooltips.

export type Stretch = "linear" | "asinh" | "log" | "sqrt";
export type Cmap = "gray" | "inferno" | "diverging" | "mask";

export interface Limits {
  lo: number;
  hi: number;
}

export function percentileLimits(data: Float32Array, pLo: number, pHi: number, symmetric = false): Limits {
  const v: number[] = [];
  for (let i = 0; i < data.length; i++) if (isFinite(data[i])) v.push(data[i]);
  if (!v.length) return { lo: 0, hi: 1 };
  v.sort((a, b) => a - b);
  const q = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.floor((p / 100) * (v.length - 1))))];
  if (symmetric) {
    const m = Math.max(Math.abs(q(pLo)), Math.abs(q(pHi))) || 1;
    return { lo: -m, hi: m };
  }
  const lo = q(pLo);
  const hi = q(pHi);
  return { lo, hi: hi > lo ? hi : lo + 1 };
}

function stretchUnit(t: number, s: Stretch): number {
  t = Math.min(1, Math.max(0, t));
  switch (s) {
    case "asinh":
      return Math.asinh(10 * t) / Math.asinh(10);
    case "log":
      return Math.log10(1 + 1000 * t) / 3;
    case "sqrt":
      return Math.sqrt(t);
    default:
      return t;
  }
}

// Inferno-like perceptual ramp (8 stops)
const INFERNO = [
  [0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164],
];
function ramp(stops: number[][], t: number): [number, number, number] {
  const x = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const u = x - i;
  const a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

/** Render to RGBA. NaN pixels are drawn as a hatched dark slate so masks are visible. */
export function toRGBA(data: Float32Array, rows: number, cols: number, lim: Limits, s: Stretch, cmap: Cmap): ImageData {
  const img = new ImageData(cols, rows);
  const out = img.data;
  const span = lim.hi - lim.lo || 1;
  for (let r = 0; r < rows; r++) {
    // FITS row 0 is the bottom of the image (north up, east left): flip vertically.
    const srcRow = rows - 1 - r;
    for (let c = 0; c < cols; c++) {
      const v = data[srcRow * cols + c];
      const o = (r * cols + c) * 4;
      if (!isFinite(v)) {
        const hatch = (r + c) % 4 === 0;
        out[o] = hatch ? 52 : 22;
        out[o + 1] = hatch ? 60 : 26;
        out[o + 2] = hatch ? 74 : 34;
        out[o + 3] = 255;
        continue;
      }
      let rgb: [number, number, number];
      if (cmap === "diverging") {
        const t = Math.max(-1, Math.min(1, (v - (lim.lo + lim.hi) / 2) / (span / 2)));
        const m = stretchUnit(Math.abs(t), s);
        // fading = cyan-blue, brightening = orange; neutral = near black
        rgb = t >= 0 ? [20 + 235 * m, 20 + 118 * m, 24 + 68 * m] : [20 + 72 * m, 22 + 178 * m, 26 + 229 * m];
      } else if (cmap === "mask") {
        rgb = v > 0.5 ? [111, 211, 155] : [40, 20, 28];
      } else {
        const m = stretchUnit((v - lim.lo) / span, s);
        rgb = cmap === "inferno" ? ramp(INFERNO, m) : [255 * m, 255 * m, 255 * m];
      }
      out[o] = rgb[0];
      out[o + 1] = rgb[1];
      out[o + 2] = rgb[2];
      out[o + 3] = 255;
    }
  }
  return img;
}
