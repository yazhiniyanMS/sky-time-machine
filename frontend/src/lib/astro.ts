// Coordinate and time helpers.

export function mjdToDate(mjd: number): Date {
  return new Date((mjd - 40587) * 86400000);
}

export function fmtDate(mjd: number | null | undefined, withTime = true): string {
  if (mjd == null || !isFinite(mjd)) return "—";
  const iso = mjdToDate(mjd).toISOString();
  return withTime ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : iso.slice(0, 10);
}

const pad = (n: number, w = 2, d = 0) => n.toFixed(d).padStart(w + (d ? d + 1 : 0), "0");

export function raHms(ra: number): string {
  let h = ((ra % 360) + 360) % 360 / 15;
  const hh = Math.floor(h);
  h = (h - hh) * 60;
  const mm = Math.floor(h);
  let ss = (h - mm) * 60;
  if (ss >= 59.995) ss = 59.99;
  return `${pad(hh)}h${pad(mm)}m${pad(ss, 2, 2)}s`;
}

export function decDms(dec: number): string {
  const s = dec < 0 ? "−" : "+";
  let d = Math.abs(dec);
  const dd = Math.floor(d);
  d = (d - dd) * 60;
  const mm = Math.floor(d);
  let ss = (d - mm) * 60;
  if (ss >= 59.95) ss = 59.9;
  return `${s}${pad(dd)}°${pad(mm)}′${pad(ss, 2, 1)}″`;
}

/** Parse "10.6847 41.269", "10.6847, +41.269" or "00 42 44.3 +41 16 09". Returns null if not coordinates. */
export function parseCoords(text: string): { ra: number; dec: number } | null {
  const t = text.trim().replace(/[hdms°′″:'",]/g, " ").replace(/\s+/g, " ");
  const parts = t.split(" ");
  if (parts.some((p) => !/^[+-−]?\d+(\.\d+)?$/.test(p))) return null;
  const nums = parts.map((p) => parseFloat(p.replace("−", "-")));
  if (nums.length === 2) {
    const [ra, dec] = nums;
    return ra >= 0 && ra < 360 && dec >= -90 && dec <= 90 ? { ra, dec } : null;
  }
  if (nums.length === 6) {
    const ra = 15 * (nums[0] + nums[1] / 60 + nums[2] / 3600);
    const neg = /^[-−]/.test(parts[3]);
    const dec = (neg ? -1 : 1) * (Math.abs(nums[3]) + nums[4] / 60 + nums[5] / 3600);
    return ra < 360 && Math.abs(dec) <= 90 ? { ra, dec } : null;
  }
  return null;
}

export const DETECTOR_COLORS: Record<number, string> = {
  1: "#8fb8ff",
  2: "#7fd6c8",
  3: "#b9e07a",
  4: "#f2c35a",
  5: "#f59b6b",
  6: "#ef7aa0",
};

export const BANDS: Record<number, string> = {
  1: "0.75–1.09 µm",
  2: "1.10–1.62 µm",
  3: "1.63–2.41 µm",
  4: "2.42–3.82 µm",
  5: "3.83–4.41 µm",
  6: "4.42–5.00 µm",
};

export const CLASS_LABEL: Record<string, string> = {
  variable_candidate: "Variable candidate",
  new_source_candidate: "New-source candidate",
  disappeared_source_candidate: "Disappeared-source candidate",
  possible_moving_object_pair: "Possible moving-object pair",
  subtraction_residual: "Subtraction residual",
  uncertain_change: "Uncertain change",
};

export const TRACK_LABEL: Record<string, string> = {
  stationary_repeated: "Stationary, repeated",
  potential_moving_object: "Potential moving object",
  single_detection: "Single detection",
};

export function sepArcsec(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const r = Math.PI / 180;
  const s =
    Math.sin(((dec2 - dec1) * r) / 2) ** 2 +
    Math.cos(dec1 * r) * Math.cos(dec2 * r) * Math.sin(((ra2 - ra1) * r) / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(s)))) / r * 3600;
}
