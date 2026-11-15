import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Comparison } from "@/lib/api";

vi.mock("next/navigation", () => ({
  usePathname: () => "/timeline",
  useSearchParams: () => new URLSearchParams("ra=10.68&dec=41.27&det=2&cand=ST-2026-000001"),
}));
vi.mock("@/lib/api", async (orig) => {
  const mod: any = await orig();
  return { ...mod, fetchLayer: vi.fn(async () => ({ data: new Float32Array(9).fill(1), rows: 3, cols: 3, kind: "original" })) };
});

import { ComparisonViewer } from "@/components/ComparisonViewer";
import { Nav } from "@/components/Nav";

const comp: Comparison = {
  id: "CMP-TEST", status: "done", error: null, created_at: "", survey: "SPHEREx", ra: 10, dec: 41, size_deg: 0.1, detector: 1,
  product_a: "A_PRODUCT", product_b: "B_PRODUCT", t_a_mjd: 60866.3, t_b_mjd: 60901.9, pipeline_version: "stm-pipeline-0.1.0",
  summary: { accepted: true, n_candidates: 1 },
  provenance: { metrics: { psf_fwhm_a_arcsec: 7.5 }, grid: { pixscale_arcsec: 6.15 }, inputs: [] },
  candidates: [{ id: "ST-2026-000001", comparison_id: "CMP-TEST", ra: 10, dec: 41, sign: 1, peak_significance: 7.2, quality_tier: "A", rejected: false,
    machine_class: "new_source_candidate", rank_in_comparison: 1, verification_status: "unverified", x_pix: 1, y_pix: 1,
    diff_flux_ujy: 100, diff_flux_err_ujy: 10, pos_err_arcsec: 1.2, epoch_signal_mjd: 60901.9 }],
};

describe("navigation", () => {
  it("lists all seven sections, marks the active one and carries sky context", () => {
    render(<Nav />);
    for (const l of ["Explore", "Timeline", "Discoveries", "Compare", "Tracking", "Assistant", "Community"])
      expect(screen.getAllByText(l).length).toBeGreaterThan(0);
    const tl = screen.getAllByRole("link", { name: "Timeline" })[0];
    expect(tl.getAttribute("aria-current")).toBe("page");
    expect(tl.getAttribute("href")).toContain("ra=10.68");
    expect(tl.getAttribute("href")).toContain("cand=ST-2026-000001");
  });
});

describe("blink comparator", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("alternates epochs with dated labels, pauses, steps and reverses", async () => {
    render(<ComparisonViewer comp={comp} mode="blink" onMode={() => {}} onSelect={() => {}} />);
    await act(async () => { await Promise.resolve(); });
    const label = () => screen.getByText(/^(A|B) · \d{4}-/).textContent!;
    const first = label();
    expect(first.startsWith("A")).toBe(true);
    expect(first).toContain("2025-07-10");
    await act(async () => { vi.advanceTimersByTime(260); }); // 2 Hz => 250 ms per frame
    expect(label().startsWith("B")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Pause blink" }));
    const paused = label();
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(label()).toBe(paused);
    fireEvent.click(screen.getByRole("button", { name: "Step" }));
    expect(label()).not.toBe(paused);
    fireEvent.click(screen.getByRole("button", { name: /Forward/ }));
    expect(screen.getByRole("button", { name: /Reverse/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Blink frequency in hertz"), { target: { value: "4" } });
    expect(screen.getByText("4.00 Hz")).toBeTruthy();
  });

  it("lists ranked candidates and reports selection", async () => {
    const onSelect = vi.fn();
    render(<ComparisonViewer comp={comp} mode="side" onMode={() => {}} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("New-source candidate"));
    expect(onSelect).toHaveBeenCalledWith("ST-2026-000001");
    expect(screen.getAllByText(/^Original$/i).length).toBe(2);
  });
});
