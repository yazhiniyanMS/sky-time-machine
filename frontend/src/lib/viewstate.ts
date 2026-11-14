// Shareable view state carried in URL query parameters.

export interface ViewState {
  ra?: number;
  dec?: number;
  fov?: number; // degrees
  det?: number;
  size?: number; // comparison cutout size (deg)
  a?: string;
  b?: string;
  mode?: "blink" | "side" | "diff";
  cand?: string;
  cmp?: string;
}

const NUM = ["ra", "dec", "fov", "det", "size"] as const;
const STR = ["a", "b", "mode", "cand", "cmp"] as const;

export function readViewState(sp: URLSearchParams | { get(k: string): string | null }): ViewState {
  const v: ViewState = {};
  for (const k of NUM) {
    const s = sp.get(k);
    if (s != null && s !== "" && isFinite(Number(s))) (v as any)[k] = Number(s);
  }
  for (const k of STR) {
    const s = sp.get(k);
    if (s) (v as any)[k] = s;
  }
  if (v.ra != null && (v.ra < 0 || v.ra >= 360)) delete v.ra;
  if (v.dec != null && Math.abs(v.dec) > 90) delete v.dec;
  if (v.mode && !["blink", "side", "diff"].includes(v.mode)) delete v.mode;
  return v;
}

export function toQuery(v: ViewState): string {
  const sp = new URLSearchParams();
  for (const [k, val] of Object.entries(v)) {
    if (val === undefined || val === null || val === "") continue;
    sp.set(k, typeof val === "number" ? String(+val.toFixed(k === "fov" || k === "size" ? 4 : 6)) : String(val));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export function href(path: string, v: ViewState): string {
  return `${path}${toQuery(v)}`;
}
