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

// ---------------------------------------------------------------- V2 research platform types
export interface DiscoveryItem extends CandidateBrief {
  diff_snr: number | null;
  snr_a: number | null;
  snr_b: number | null;
  wave_um: number | null;
  survey: string | null;
  collection: string | null;
  pipeline_version: string;
  created_at: string;
  failed_checks: string[];
  counterpart_association: string | null;
}
export interface DiscoveryPage {
  items: DiscoveryItem[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
  n_comparisons_processed: number;
  class_descriptions: Record<string, string>;
  note: string;
}
export interface Channel {
  index: number;
  detector: number;
  subchannel: number;
  wave_um: number;
  wave_min_um: number;
  wave_max_um: number;
  R: number;
  bandwidth_um: number;
}
export interface CubeChannel extends Channel {
  plane: number;
  surface_brightness_mjy_sr: number | null;
  nhits: number;
  flags: number;
  missing: boolean;
  missing_reason: string | null;
}
export interface CubeSpectrum {
  ra: number;
  dec: number;
  tile: string;
  tile_id: string;
  pixel: [number, number];
  pixel_scale_arcsec: number;
  unit: string;
  mjd_range: [number, number];
  blank_channels: string[];
  channels: CubeChannel[];
  quantity: string;
}
export interface PhotPoint {
  product_id: string;
  obs_id: string;
  detector: number | null;
  channel: number | null;
  subchannel: number | null;
  t_mid_mjd: number;
  wave_um: number | null;
  bandwidth_um: number | null;
  flux_ujy: number | null;
  flux_err_ujy: number | null;
  aperture_correction: number | null;
  flux_pointsource_ujy: number | null;
  flux_pointsource_err_ujy: number | null;
  masked_fraction: number | null;
  status: "ok" | "masked" | "outside" | "error";
  quality: "good" | "warning" | "bad" | null;
  message: string | null;
  access_url: string | null;
  extra: Record<string, any>;
}
export interface SpectroRun {
  id: string;
  status: string;
  created_at: string;
  ra: number;
  dec: number;
  label: string | null;
  candidate_id: string | null;
  params: Record<string, any>;
  provenance: Record<string, any>;
  n_points: number;
  error: string | null;
  points?: PhotPoint[];
}
export interface LightCurveStats {
  n_points: number;
  n_visits?: number;
  time_span_days?: number;
  coverage_gaps?: { from_mjd: number; to_mjd: number; days: number }[];
  mean_ujy?: number;
  weighted_mean_ujy?: number;
  weighted_mean_err_ujy?: number;
  median_ujy?: number;
  std_ujy?: number | null;
  relative_scatter?: number | null;
  chi2?: number;
  dof?: number;
  reduced_chi2?: number;
  p_value_constant?: number;
  fractional_excess_variance?: number | null;
  verdict: string;
  explanation?: string;
  config?: Record<string, any>;
  systematics?: string[];
  systematics_possible?: boolean;
}
export interface LightCurve {
  run_id: string;
  channel?: Channel;
  channels: (Channel & { n_measurements: number })[];
  points?: PhotPoint[];
  excluded?: { product_id: string; t_mid_mjd: number; status: string; quality: string | null; message: string | null }[];
  stats?: LightCurveStats;
  quantity?: string;
  note?: string;
}
export interface Counterpart {
  id: string;
  type: string | null;
  ra: number;
  dec: number;
  sep_arcsec: number;
  pos_err_arcsec: number | null;
  sigma_arcsec: number;
  n_sigma: number;
  within_3sigma: boolean;
  reference: string | null;
  url: string | null;
  phot_g_mean_mag?: number | null;
  parallax?: number | null;
  pm?: number | null;
}
export interface CounterpartResult {
  candidate_id: string;
  radius_arcsec: number;
  candidate_err_arcsec: number;
  association: string;
  explanation: string;
  assessed_at: string;
  method: string;
  catalogs: Record<string, {
    status: string; service: string | null; message: string; cached: boolean; association: string; explanation: string;
    expected_chance: number; density_per_arcmin2: number; match_radius_arcsec: number; counterparts: Counterpart[];
  }>;
}
export interface Assessment {
  candidate_id: string;
  data_kinds: Record<string, string>;
  why_detected: { text: string; threshold_sigma: number; peak_significance: number; npix: number };
  supporting_measurements: { name: string; value: any; error?: number | null; unit: string; kind: string }[];
  checks_passed: Check[];
  checks_failed: Check[];
  comparison_checks_failed: Check[];
  classification: { machine_class: string; rule: string; quality_tier: string; verification_status: string };
  psf: Record<string, any>;
  counterparts: { association: string; text: string; assessed_at: string } | null;
  remaining_uncertainties: string[];
  processing_history: Record<string, any>;
}
export interface InvestigationItem {
  id: number;
  kind: string;
  ref_id: string;
  label: string;
  note: string;
  payload: Record<string, any>;
  added_at: string;
}
export interface Investigation {
  id: string;
  title: string;
  description: string;
  owner: string;
  ra: number | null;
  dec: number | null;
  radius_deg: number | null;
  notes: string;
  references: { title?: string; url?: string; bibcode?: string }[];
  created_at: string;
  updated_at: string;
  n_items: number;
  items?: InvestigationItem[];
}
export interface WatchEntry {
  id: string;
  kind: string;
  label: string;
  ref_id: string | null;
  ra: number;
  dec: number;
  radius_deg: number;
  n_known_products: number;
  created_at: string;
  last_checked_at: string | null;
  last_new_count: number;
  checks: { checked_at: string; status: string; n_products: number; new_products: string[]; message: string }[];
}
export interface CoverageMap {
  ra: number;
  dec: number;
  size_deg: number;
  cells: number;
  cell_size_arcmin: number;
  n_products_queried: number;
  cell_ra: number[][];
  cell_dec: number[][];
  layers: Record<string, number[][]> & { pairs_by_detector: Record<string, number[][]> };
  method: string;
  computed_at?: string;
}

export async function patch<T>(p: string, body: unknown): Promise<T> {
  return req<T>(p, { method: "PATCH", body: JSON.stringify(body) });
}
export async function del<T>(p: string): Promise<T> {
  return req<T>(p, { method: "DELETE" });
}
