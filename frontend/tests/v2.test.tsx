import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
let search = new URLSearchParams("");
vi.mock("next/navigation", () => ({
  usePathname: () => "/discoveries",
  useSearchParams: () => search,
  useRouter: () => ({ replace, push: vi.fn() }),
  useParams: () => ({}),
}));
const getMock = vi.fn();
vi.mock("@/lib/api", async (orig) => {
  const mod: any = await orig();
  return { ...mod, get: (p: string) => getMock(p) };
});

import DiscoveriesPage from "@/app/discoveries/page";
import { CoverageHeatmap } from "@/components/CoverageHeatmap";
import { LightCurvePanel } from "@/components/LightCurvePanel";
import { Nav } from "@/components/Nav";
import { Plot } from "@/components/Plot";

const feedItem = {
  id: "ST-2026-000002", comparison_id: "CMP-X", ra: 10.688, dec: 41.2245, sign: -1, peak_significance: -6.3, quality_tier: "B",
  rejected: false, machine_class: "uncertain_change", rank_in_comparison: 2, verification_status: "unverified", x_pix: 1, y_pix: 1,
  diff_flux_ujy: -2010, diff_flux_err_ujy: 611, pos_err_arcsec: 1.4, epoch_signal_mjd: 60867.9, diff_snr: 3.3, snr_a: -12, snr_b: -15,
  wave_um: 1.0747, survey: "SPHEREx", collection: "spherex_dr1", pipeline_version: "stm-pipeline-0.1.0", created_at: "2026-11-14",
  failed_checks: ["edge_distance"], counterpart_association: "possible", detector: 1, t_a_mjd: 60867.9, t_b_mjd: 61044.9,
};

beforeEach(() => { replace.mockReset(); getMock.mockReset(); search = new URLSearchParams(""); });

describe("discovery feed", () => {
  it("renders real feed rows with survey, dates, pipeline, quality and counterpart status", async () => {
    getMock.mockResolvedValue({ items: [feedItem], total: 1, page: 1, page_size: 25, pages: 1, n_comparisons_processed: 1, class_descriptions: {}, note: "n" });
    render(<DiscoveriesPage />);
    expect(await screen.findByText("ST-2026-000002")).toBeTruthy();
    expect(screen.getByText("Possible association")).toBeTruthy();
    expect(screen.getByText("v0.1.0")).toBeTruthy();
    expect(screen.getByText("edge_distance")).toBeTruthy();
    expect(getMock.mock.calls[0][0]).toContain("sort=significance");
  });
  it("puts filters in the URL and resets to page 1", async () => {
    getMock.mockResolvedValue({ items: [feedItem], total: 1, page: 1, page_size: 25, pages: 1, n_comparisons_processed: 1, class_descriptions: {}, note: "" });
    render(<DiscoveriesPage />);
    await screen.findByText("ST-2026-000002");
    fireEvent.change(screen.getByDisplayValue("Significance (tier first)"), { target: { value: "date:asc" } });
    const url = String(replace.mock.calls.at(-1)?.[0]);
    expect(url).toContain("sort=date");
    expect(url).toContain("order=asc");
    expect(url).not.toContain("page=");
  });
  it("shows an honest empty state instead of placeholder candidates", async () => {
    getMock.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 25, pages: 1, n_comparisons_processed: 0, class_descriptions: {}, note: "" });
    render(<DiscoveriesPage />);
    expect(await screen.findByText(/No comparisons have been processed yet/)).toBeTruthy();
  });
});

describe("plot", () => {
  it("draws error bars only where an uncertainty exists and a legend only for >= 2 series", () => {
    const { container, rerender } = render(<Plot ariaLabel="t" xLabel="x" yLabel="y" series={[{ key: "a", label: "A", color: "#000" }]}
      points={[{ x: 1, y: 2, yErr: 0.5, series: "a" }, { x: 2, y: 3, yErr: null, series: "a" }]} />);
    expect(container.querySelectorAll("line[stroke-width='1.25']").length).toBe(1);
    expect(screen.queryByLabelText("Legend")).toBeNull();
    rerender(<Plot ariaLabel="t" xLabel="x" yLabel="y" series={[{ key: "a", label: "A", color: "#000" }, { key: "b", label: "B", color: "#fff" }]}
      points={[{ x: 1, y: 2, series: "a" }, { x: 2, y: 3, series: "b" }]} />);
    expect(screen.getByLabelText("Legend")).toBeTruthy();
  });
});

describe("light curve panel", () => {
  it("never presents systematic-dominated scatter as clean variability", async () => {
    getMock.mockResolvedValue({
      run_id: "SPX-1", channel: { index: 9, detector: 1, subchannel: 10, wave_um: 0.932, bandwidth_um: 0.025 },
      channels: [{ index: 9, detector: 1, subchannel: 10, wave_um: 0.932, bandwidth_um: 0.025, n_measurements: 4 }],
      points: [1, 2, 3, 4].map((i) => ({ product_id: `P${i}`, t_mid_mjd: 60860 + i * 50, flux_ujy: 1000 * i, flux_err_ujy: 50, quality: "good" })),
      excluded: [], stats: { n_points: 4, n_visits: 4, verdict: "significant_variability", explanation: "Constant flux rejected", chi2: 42.8, dof: 3,
        p_value_constant: 2.7e-9, systematics: ["The local background in the aperture is 6.9× the source flux"], systematics_possible: true, config: {} },
    });
    render(<LightCurvePanel runId="SPX-1" channel={9} onChannel={() => {}} />);
    expect(await screen.findByText(/systematics likely/)).toBeTruthy();
    expect(screen.getByText(/6.9× the source flux/)).toBeTruthy();
    expect(screen.getByText("42.8 / 3")).toBeTruthy();
  });
});

describe("coverage heatmap and navigation", () => {
  it("draws one cell per grid position and explains the metric", () => {
    const g = [[0, 1], [2, 3]];
    const map: any = { ra: 1, dec: 2, size_deg: 0.5, cells: 2, cell_size_arcmin: 15, n_products_queried: 4, cell_ra: g, cell_dec: g, method: "m",
      layers: { visits: g, exposures: g, images: g, pairs: g, detectors: g, time_span_days: g, pairs_by_detector: { "1": g } } };
    const { container } = render(<CoverageHeatmap map={map} metric="visits" onMetric={() => {}} />);
    expect(container.querySelectorAll("rect").length).toBe(4);
    expect(screen.getByText(/Exposures within 0.5 day count as one visit/)).toBeTruthy();
  });
  it("lists the eight research sections plus tools", () => {
    render(<Nav />);
    for (const l of ["Explore", "Timeline", "Discoveries", "Spectra", "Tracking", "Investigations", "Watchlists", "Sky Intelligence", "Compare", "Community"])
      expect(screen.getAllByText(l).length).toBeGreaterThan(0);
  });
});
