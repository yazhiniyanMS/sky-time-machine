import { describe, expect, it } from "vitest";
import { decDms, fmtDate, mjdToDate, parseCoords, raHms } from "@/lib/astro";
import { percentileLimits, toRGBA } from "@/lib/render";
import { href, readViewState, toQuery } from "@/lib/viewstate";


describe("URL view state", () => {
  it("round-trips every shareable field", () => {
    const v = { ra: 10.684712, dec: -41.269, fov: 0.25, det: 3, size: 0.1, a: "2025W28_1B_0600_1D1", b: "2025W33_2C_0100_1D1", mode: "diff" as const, cand: "ST-2026-000142", cmp: "CMP-ABC" };
    const restored = readViewState(new URLSearchParams(toQuery(v).slice(1)));
    expect(restored).toEqual(v);
  });
  it("drops invalid values instead of restoring a wrong view", () => {
    const r = readViewState(new URLSearchParams("ra=400&dec=-95&mode=hack&fov=abc&cand=ST-1"));
    expect(r).toEqual({ cand: "ST-1" });
  });
  it("builds discovery permalinks", () => {
    expect(href("/discovery/ST-2026-000142", {})).toBe("/discovery/ST-2026-000142");
    expect(href("/compare", { ra: 1, dec: 2, mode: "blink" })).toBe("/compare?ra=1&dec=2&mode=blink");
  });
});

describe("coordinates", () => {
  it("parses decimal and sexagesimal input", () => {
    expect(parseCoords("10.6847 +41.269")).toEqual({ ra: 10.6847, dec: 41.269 });
    const s = parseCoords("00 42 44.3 +41 16 09")!;
    expect(s.ra).toBeCloseTo(10.6846, 3);
    expect(s.dec).toBeCloseTo(41.2692, 3);
    expect(parseCoords("05:35:17.3 -05:23:28")!.dec).toBeLessThan(0);
    expect(parseCoords("M31")).toBeNull();
    expect(parseCoords("400 10")).toBeNull();
  });
  it("formats sexagesimal and MJD", () => {
    expect(raHms(10.6847)).toBe("00h42m44.33s");
    expect(decDms(-5.5)).toBe("−05°30′00.0″");
    expect(mjdToDate(60867.0).toISOString().slice(0, 10)).toBe("2025-07-11");
    expect(fmtDate(null)).toBe("—");
  });
});

describe("display rendering", () => {
  it("computes percentile and symmetric limits ignoring NaN", () => {
    const d = new Float32Array([NaN, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const l = percentileLimits(d, 0, 100);
    expect(l).toEqual({ lo: 1, hi: 10 });
    expect(percentileLimits(new Float32Array([-3, 1, 2]), 0, 100, true)).toEqual({ lo: -3, hi: 3 });
  });
  it("flips FITS rows (north up) and marks masked pixels", () => {
    // 2x1 image: bottom row (FITS row 0) = 0, top row = 1
    const img = toRGBA(new Float32Array([0, 1]), 2, 1, { lo: 0, hi: 1 }, "linear", "gray");
    expect(img.data[0]).toBe(255); // first canvas row is the top of the sky image
    expect(img.data[4]).toBe(0);
    const masked = toRGBA(new Float32Array([NaN]), 1, 1, { lo: 0, hi: 1 }, "linear", "gray");
    expect(masked.data[0]).toBeGreaterThan(0);
    expect(masked.data[0]).toBeLessThan(80);
  });
});
