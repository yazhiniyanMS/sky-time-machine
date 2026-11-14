// Typed client for the Sky Time Machine backend.

export const API = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${API}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers || {}) } });
  } catch {
    throw new ApiError(0, `Cannot reach the Sky Time Machine API at ${API}. Is the backend running?`);
  }
  if (!r.ok) {
    let msg = r.statusText;
    try {
      const j = await r.json();
      msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j);
    } catch {}
    throw new ApiError(r.status, msg);
  }
  return r.json() as Promise<T>;
}

export const get = <T,>(p: string) => req<T>(p);
export const post = <T,>(p: string, body: unknown, headers?: Record<string, string>) =>
  req<T>(p, { method: "POST", body: JSON.stringify(body), headers });

export interface Product {
  product_id: string;
  detector: number | null;
  band: string;
  em_min_um: number | null;
  em_max_um: number | null;
  s_region: string;
  access_url: string;
  release_date: string | null;
}
export interface Exposure {
  obs_id: string;
  t_mid_mjd: number;
  date_iso: string;
  exptime_s: number | null;
  products: Product[];
}
export interface ObservationsResponse {
  query: { ra: number; dec: number; radius_deg: number };
  source: Record<string, unknown>;
  n_products: number;
  n_exposures: number;
  detectors: Record<string, number>;
  exposures: Exposure[];
  coverage_gaps: { from_mjd: number; to_mjd: number; days: number }[];
  note: string;
}
export interface SpectralObs {
  product_id: string;
  obs_id: string;
  t_mid_mjd: number;
  date_iso: string | null;
  wave_um?: number;
  bandwidth_um?: number;
  in_footprint?: boolean;
  edge_distance_pix?: number;
  psf_fwhm_arcsec?: number;
  error?: string;
}
export interface SpectralPair {
  a: string;
  b: string;
  baseline_days: number;
  dlambda_frac: number;
  dlambda_nm: number;
}
export interface SpectralResponse {
  detector: number;
  band: { min_um: number; max_um: number; R: number } | null;
  observations: SpectralObs[];
  pairs: SpectralPair[];
  wavelength_lookup?: { calibration_source: string; pipeline_version: string; from_product: string };
  method?: string;
}
export interface Check {
  name: string;
  passed: boolean;
  detail: string;
  value: unknown;
  threshold: unknown;
  severity: "error" | "warning" | "info";
}
export interface CandidateBrief {
  id: string;
  comparison_id: string;
  ra: number;
  dec: number;
  sign: number;
  peak_significance: number;
  quality_tier: "A" | "B" | "R";
  rejected: boolean;
  machine_class: string;
  rank_in_comparison: number;
  verification_status: string;
  x_pix: number;
  y_pix: number;
  diff_flux_ujy: number;
  diff_flux_err_ujy: number;
  pos_err_arcsec: number;
  epoch_signal_mjd: number;
  detector?: number;
  t_a_mjd?: number;
  t_b_mjd?: number;
  product_a?: string;
  product_b?: string;
  community?: Record<string, number>;
}
export interface Comparison {
  id: string;
  status: "queued" | "running" | "done" | "rejected" | "failed";
  error: string | null;
  created_at: string;
  survey: string;
  ra: number;
  dec: number;
  size_deg: number;
  detector: number | null;
  product_a: string;
  product_b: string;
  t_a_mjd: number | null;
  t_b_mjd: number | null;
  pipeline_version: string;
  summary: {
    accepted?: boolean;
    n_candidates?: number;
    n_rejected?: number;
    n_tier_a?: number;
    baseline_days?: number;
    rejection_reasons?: string[];
  };
  provenance: {
    inputs?: Array<Record<string, any>>;
    software?: Record<string, string>;
    config?: Record<string, any>;
    grid?: Record<string, any>;
    quality_checks?: Check[];
    metrics?: Record<string, any>;
    layers?: Record<string, { kind: "original" | "derived"; description: string }>;
    processed_at?: string;
    finished_at?: string;
  };
  candidates?: CandidateBrief[];
}
export interface CandidateDetail {
  id: string;
  ra: number;
  dec: number;
  sign: number;
  peak_significance: number;
  quality_tier: "A" | "B" | "R";
  rejected: boolean;
  machine_class: string;
  machine_class_description: string;
  rank_in_comparison: number;
  rank_explanation: string;
  measurements: Record<string, any>;
  quality_checks: Check[];
  verification_status: string;
  pipeline_version: string;
  created_at: string;
  comparison: Comparison;
  tracks: { id: string; kind: string; members: string[]; metrics: Record<string, any> }[];
}
export interface Job {
  id: string;
  kind: string;
  status: "queued" | "running" | "done" | "failed";
  progress: number;
  message: string;
  params: Record<string, any>;
  result: Record<string, any>;
}
export interface Annotation {
  id: number;
  created_at: string;
  target_type: string;
  target_id: string;
  author: string;
  kind: string;
  body: string;
  status: string;
}

export interface Layer {
  data: Float32Array;
  rows: number;
  cols: number;
  kind: "original" | "derived";
}

const layerCache = new Map<string, Promise<Layer>>();
export function fetchLayer(cid: string, name: string): Promise<Layer> {
  const key = `${cid}/${name}`;
  if (!layerCache.has(key)) {
    const p = fetch(`${API}/api/comparisons/${cid}/layers/${name}`).then(async (r) => {
      if (!r.ok) throw new ApiError(r.status, `layer ${name}: ${r.statusText}`);
      const [rows, cols] = (r.headers.get("X-Shape") || "0,0").split(",").map(Number);
      const buf = await r.arrayBuffer();
      return { data: new Float32Array(buf), rows, cols, kind: (r.headers.get("X-Layer-Kind") as Layer["kind"]) || "derived" };
    });
    p.catch(() => layerCache.delete(key));
    layerCache.set(key, p);
  }
  return layerCache.get(key)!;
}

export async function pollJob(jobId: string, onProgress?: (j: Job) => void, intervalMs = 800): Promise<Job> {
  for (;;) {
    const j = await get<Job>(`/api/jobs/${jobId}`);
    onProgress?.(j);
    if (j.status === "done" || j.status === "failed") return j;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
