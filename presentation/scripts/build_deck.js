// Builds presentation/Sky-Time-Machine-Project-Demo.pptx (Snack Seekers) from presentation/assets/build.
// Run from presentation/:  node scripts/build_deck.js
// Visual system: docs/DESIGN_SYSTEM.md ("Plate & Graphite"), the same one the web app uses.
// Every number on the slides comes from the repository docs, assets/m31_validation.json (scripts/m31_psf_validation.py)
// or the app's API responses saved in assets/*.json.

const path = require("path");
const fs = require("fs");
const pptxgen = require("pptxgenjs");

const ROOT = path.resolve(__dirname, "..");
const B = (f) => path.join(ROOT, "assets", "build", f);
const J = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, "assets", f), "utf8"));
const VAL = J("m31_validation.json"), TL = J("m31_d1_spectral_timeline.json"), OBS = J("m31_observations.json");
const OUT = path.join(ROOT, "Sky-Time-Machine-Project-Demo.pptx");

// Paper surface tokens (docs/DESIGN_SYSTEM.md). Office-safe type: Georgia / Arial / Courier New.
const C = {
  paper: "F4F1EA", ink: "1C1B19", muted: "5D594F", faint: "8A8578",
  line: "DCD6C8", rule: "BFB7A6", accent: "B4561E", olive: "5F6B2E", amber: "A36A12",
};
const DET = ["3B5788", "27A595", "686D12", "D9A53E", "C2552A", "7A2A2B"]; // D1–D6, paper steps
const SERIF = "Georgia", SANS = "Arial", MONO = "Courier New";
const W = 13.333, H = 7.5, MX = 0.6, CW = W - 2 * MX;

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE";
pres.author = "Snack Seekers";
pres.company = "Snack Seekers";
pres.title = "Sky Time Machine — Project Demonstration";
pres.subject = "Interactive time-domain explorer for NASA/IPAC SPHEREx observations";
pres.theme = { headFontFace: SERIF, bodyFontFace: SANS };

pres.defineSlideMaster({
  title: "PAPER",
  background: { color: C.paper },
  objects: [
    { text: { text: "Sky Time Machine  ·  Snack Seekers", options: { x: MX, y: 7.02, w: 6, h: 0.25, fontFace: SANS, fontSize: 9, color: C.faint, margin: 0 } } },
  ],
  slideNumber: { x: W - MX - 0.5, y: 7.0, w: 0.5, h: 0.25, fontFace: MONO, fontSize: 9, color: C.faint, align: "right" },
});

// ---------- helpers ----------
const t = (s, str, o) => s.addText(str, { fontFace: SANS, margin: 0, isTextBox: true, valign: "top", color: C.ink, ...o });
function head(s, n, label, title) {
  t(s, [{ text: n, options: { fontFace: MONO, color: C.accent } }, { text: "   " + label, options: { color: C.muted } }], { x: MX, y: 0.42, w: 8, h: 0.25, fontSize: 11 });
  t(s, title, { x: MX, y: 0.72, w: CW, h: 0.62, fontFace: SERIF, fontSize: 28, color: C.ink, valign: "middle" });
}
const rule = (s, x, y, w, color = C.rule, wt = 0.75) => s.addShape(pres.shapes.LINE, { x, y, w, h: 0, line: { color, width: wt } });
const vrule = (s, x, y, h, color = C.line) => s.addShape(pres.shapes.LINE, { x, y, w: 0, h, line: { color, width: 0.75 } });
function plate(s, file, x, y, w, h, alt) {
  s.addImage({ path: B(file), x, y, w, h, altText: alt || file });
  s.addShape(pres.shapes.RECTANGLE, { x, y, w, h, fill: { type: "none" }, line: { color: C.rule, width: 0.5 } });
}
function marker(s, n, x, y, d = 0.3) {
  s.addShape(pres.shapes.OVAL, { x: x - d / 2, y: y - d / 2, w: d, h: d, fill: { color: C.ink }, line: { color: C.paper, width: 1.25 } });
  t(s, String(n), { x: x - d / 2, y: y - d / 2, w: d, h: d, fontFace: MONO, fontSize: 11, bold: true, color: C.paper, align: "center", valign: "middle" });
}
const cap = (s, str, o) => t(s, str, { fontSize: 10, color: C.muted, ...o });
const f1 = (x) => x.toFixed(1).replace("-", "−");

(async () => {
  const E = VAL.epsf_cross, G = VAL.gaussian;
  const before = f1(G.peak_abs_sigma), after = f1(E.peak_abs_sigma), dip = f1(G.peak_neg_sigma);
  const waves = TL.observations.map((o) => o.wave_um).filter((v) => v);
  const wmin = Math.round(Math.min(...waves) * 1000), wmax = Math.round(Math.max(...waves) * 1000);
  const maxGap = Math.round(Math.max(...OBS.coverage_gaps.map((g) => g.days)));

  // ===== 1. Title =====
  {
    const s = pres.addSlide({ masterName: "PAPER" });
    t(s, "NASA SPHEREx  ·  time-domain exploration", { x: MX, y: 0.9, w: 4.8, h: 0.3, fontSize: 11, color: C.muted });
    t(s, "Sky Time Machine", { x: MX, y: 1.3, w: 4.9, h: 1.5, fontFace: SERIF, fontSize: 44, color: C.ink });
    t(s, "Exploring how the sky changes between SPHEREx observations.", { x: MX, y: 2.95, w: 4.5, h: 0.8, fontFace: SERIF, fontSize: 17, italic: true, color: C.muted });
    t(s, "Pick a position, list every archived SPHEREx exposure of it, compare two epochs taken at the same wavelength, and inspect what changed, with uncertainties and provenance.",
      { x: MX, y: 3.95, w: 4.4, h: 1.2, fontSize: 13, color: C.ink, lineSpacingMultiple: 1.2 });
    rule(s, MX, 5.45, 4.4, C.rule);
    t(s, "Team", { x: MX, y: 5.6, w: 2, h: 0.25, fontSize: 10, color: C.muted });
    t(s, "Snack Seekers", { x: MX, y: 5.85, w: 4.4, h: 0.45, fontFace: SERIF, fontSize: 22 });
    t(s, "Yazhiniyan M.S.", { x: MX, y: 6.32, w: 4.4, h: 0.3, fontSize: 13, color: C.ink });
    t(s, "github.com/yazhiniyanMS/sky-time-machine", { x: MX, y: 6.65, w: 4.6, h: 0.25, fontFace: MONO, fontSize: 10, color: C.muted });
    const px = 5.55, pw = W - MX - px, ph = pw / 1.6;
    plate(s, "shot_explore.jpg", px, 0.9, pw, ph, "Explore workspace showing M31 with SPHEREx footprints");
    cap(s, [{ text: "Fig. 1  ", options: { bold: true, color: C.ink } }, { text: "Explore workspace (production build). M31 with the real SPHEREx DR1 detector-1 footprints returned by NASA/IPAC IRSA; background DSS2 colour via IRSA HiPS." }],
      { x: px, y: 0.9 + ph + 0.12, w: pw, h: 0.45 });
    s.addNotes("Sky Time Machine by team Snack Seekers. Figure 1 is a screenshot of the running application: the Explore workspace on Andromeda, with the actual SPHEREx DR1 detector-1 footprints that cover it.");
  }

  // ===== 2. Problem =====
  {
    const s = pres.addSlide({ masterName: "PAPER" });
    head(s, "01", "The problem", "Comparing the same sky across dates is harder than it looks");
    const cw = (CW - 2 * 0.5) / 3, xs = [MX, MX + cw + 0.5, MX + 2 * (cw + 0.5)], y0 = 1.75;
    [xs[1] - 0.25, xs[2] - 0.25].forEach((x) => vrule(s, x, y0, 4.95));
    const heads = ["Observations are scattered in time", "Each exposure sees a different wavelength", "Naive subtraction invents signals"];
    xs.forEach((x, i) => {
      t(s, String(i + 1).padStart(2, "0"), { x, y: y0, w: 0.6, h: 0.3, fontFace: MONO, fontSize: 12, color: C.accent });
      t(s, heads[i], { x, y: y0 + 0.32, w: cw, h: 0.4, fontFace: SERIF, fontSize: 16 });
    });
    const vy = y0 + 0.95, vh = 2.25, ty = y0 + 3.35;
    const axis = (yTitle) => ({
      valAxisLabelColor: C.muted, catAxisLabelColor: C.muted, valAxisLabelFontSize: 9, catAxisLabelFontSize: 9,
      valAxisLabelFontFace: SANS, catAxisLabelFontFace: SANS,
      showValAxisTitle: true, valAxisTitle: yTitle, valAxisTitleColor: C.muted, valAxisTitleFontSize: 9, valAxisTitleFontFace: SANS,
      showCatAxisTitle: true, catAxisTitle: "days since 2025-07-09", catAxisTitleColor: C.muted, catAxisTitleFontSize: 9, catAxisTitleFontFace: SANS,
      valGridLine: { color: C.line, size: 0.5 }, catGridLine: { style: "none" }, valAxisLineShow: false, catAxisLineColor: C.rule,
      catAxisMinVal: 0, catAxisMaxVal: 200, catAxisMajorUnit: 50, catAxisLabelFormatCode: "0", showLegend: false,
      lineSize: 0, lineDataSymbol: "circle", lineDataSymbolSize: 5,
      plotArea: { fill: { color: C.paper } }, chartArea: { fill: { color: C.paper } },
    });
    // 1: every M31 exposure midpoint by detector (IRSA SIA2, via the app's API)
    const T0 = Math.min(...OBS.exposures.map((e) => e.t_mid_mjd));
    const pts = [];
    OBS.exposures.forEach((e) => e.products.forEach((p) => pts.push([+(e.t_mid_mjd - T0).toFixed(3), p.detector])));
    s.addChart(pres.charts.SCATTER, [{ name: "days", values: pts.map((p) => p[0]) }].concat(
      [1, 2, 3, 4, 5, 6].map((d) => ({ name: "D" + d, values: pts.map((p) => (p[1] === d ? d : null)) }))),
      { x: xs[0] - 0.1, y: vy, w: cw + 0.1, h: vh, chartColors: DET, ...axis("detector"), valAxisMinVal: 0.5, valAxisMaxVal: 6.5, valAxisMajorUnit: 1, valAxisLabelFormatCode: "0" });
    t(s, `${OBS.n_products} images from ${OBS.n_exposures} exposures on six detectors, with a ${maxGap}-day gap in coverage.`,
      { x: xs[0], y: ty, w: cw, h: 0.9, fontSize: 13, lineSpacingMultiple: 1.15 });
    cap(s, "M31 exposure midpoints, 2025-07-09 to 2026-01-28", { x: xs[0], y: ty + 1.25, w: cw, h: 0.25 });
    // 2: wavelength at the target, detector 1
    const t0 = Math.min(...TL.observations.map((o) => o.t_mid_mjd));
    const ob = TL.observations.filter((o) => o.wave_um);
    s.addChart(pres.charts.SCATTER, [
      { name: "days", values: ob.map((o) => +(o.t_mid_mjd - t0).toFixed(3)) },
      { name: "λ", values: ob.map((o) => Math.round(o.wave_um * 1000)) },
    ], { x: xs[1] - 0.1, y: vy, w: cw + 0.1, h: vh, chartColors: [C.ink], ...axis("λ at target (nm)"), valAxisMinVal: 700, valAxisMaxVal: 1150, valAxisMajorUnit: 100, valAxisLabelFormatCode: "0" });
    t(s, `Detector 1 saw M31 anywhere from ${wmin} to ${wmax} nm. Only ${TL.pairs.length} epoch pairs match within half a bandwidth.`,
      { x: xs[1], y: ty, w: cw, h: 0.9, fontSize: 13, lineSpacingMultiple: 1.15 });
    cap(s, `${TL.observations.length} detector-1 exposures; wavelength from FITS headers`, { x: xs[1], y: ty + 1.25, w: cw, h: 0.25 });
    // 3: the real false dipole
    const side = vh;
    plate(s, "m31_sig_gaussian.png", xs[2], vy, side, side, "Significance map with a false dipole");
    t(s, `+${before}σ\n${dip}σ`, { x: xs[2] + side + 0.2, y: vy + 0.7, w: cw - side - 0.2, h: 0.7, fontFace: MONO, fontSize: 13, color: C.ink });
    cap(s, "adjacent peaks in the ringed pair", { x: xs[2] + side + 0.2, y: vy + 1.42, w: cw - side - 0.2, h: 0.5 });
    t(s, "Mismatched image shapes left a dipole on a bright source in M31: an artifact that looks like a change.",
      { x: xs[2], y: ty, w: cw, h: 0.9, fontSize: 13, lineSpacingMultiple: 1.15 });
    cap(s, "Significance map, previous PSF step", { x: xs[2], y: ty + 1.25, w: cw, h: 0.25 });
    s.addNotes("Three measured obstacles at M31: scattered epochs, a different wavelength in every exposure (linear variable filters), and subtraction artifacts from mismatched PSFs.");
  }

  // ===== 3. Workflow =====
  {
    const s = pres.addSlide({ masterName: "PAPER" });
    head(s, "02", "The solution", "From a sky position to an inspected change");
    const steps = [
      ["thumb_explore.jpg", "Select a sky region", "Name or coordinates; real SPHEREx footprints on the sky map."],
      ["thumb_timeline.jpg", "Retrieve observations", "Every exposure from IRSA, with the wavelength seen at the target."],
      ["thumb_compare.jpg", "Compare epochs", "Same detector, same wavelength: blink, side by side, difference."],
      ["thumb_discovery.jpg", "Inspect differences", "Ranked candidates with σ, artifact checks and provenance."],
    ];
    const gap = 0.35, tw = (CW - 3 * gap) / 4, th = tw / 1.5, y0 = 1.85;
    steps.forEach(([f, h, d], i) => {
      const x = MX + i * (tw + gap);
      t(s, String(i + 1), { x, y: y0, w: 0.3, h: 0.3, fontFace: MONO, fontSize: 12, color: C.accent });
      t(s, h, { x: x + 0.3, y: y0, w: tw - 0.3, h: 0.3, fontFace: SERIF, fontSize: 15 });
      plate(s, f, x, y0 + 0.45, tw, th, h);
      t(s, d, { x, y: y0 + 0.6 + th, w: tw, h: 0.75, fontSize: 12, color: C.ink, lineSpacingMultiple: 1.15 });
      if (i < 3) t(s, "→", { x: x + tw + 0.02, y: y0 + 0.45 + th / 2 - 0.2, w: gap - 0.04, h: 0.4, fontSize: 16, color: C.muted, align: "center", valign: "middle" });
    });
    const by = 5.75;
    rule(s, MX, by, CW);
    const p3 = [["Live archive data", "NASA/IPAC IRSA SPHEREx DR1; nothing simulated."], ["Like with like", "Same detector and |Δλ| ≤ ½ bandwidth before subtracting."], ["Honest output", "Every layer is labelled original or derived, with σ."]];
    const pw = CW / 3;
    p3.forEach(([h, d], i) => {
      t(s, h, { x: MX + i * pw, y: by + 0.18, w: pw - 0.3, h: 0.3, fontSize: 12, bold: true });
      t(s, d, { x: MX + i * pw, y: by + 0.48, w: pw - 0.3, h: 0.5, fontSize: 12, color: C.muted });
    });
    s.addNotes("Each thumbnail is the real page for that step in the production build: Explore, Timeline, Compare and the candidate page.");
  }

  // ===== 4. Comparison workspace =====
  {
    const s = pres.addSlide({ masterName: "PAPER" });
    head(s, "03", "Live product", "The comparison workspace, on real SPHEREx data");
    const iw = 8.0, ih = iw / 1.6, ix = MX, iy = 1.55;
    plate(s, "shot_compare.jpg", ix, iy, iw, ih, "Compare page in difference mode, M31 epochs 2025-07-11 and 2026-01-04");
    // Markers sit on empty space; 2 and 6 go in the left margin, level with their rows.
    const pts = [[0.49, 0.1], [-0.03, 0.17], [0.11, 0.38], [0.475, 0.38], [0.955, 0.355], [-0.03, 0.893]];
    pts.forEach(([fx, fy], i) => marker(s, i + 1, ix + iw * fx, iy + ih * fy));
    const nx = ix + iw + 0.5, nw = W - MX - nx;
    const notes = [
      ["Epoch metadata", "times, 176.9 d baseline, λ A/B, 0.002 px residual"],
      ["Toolbar", "blink, side by side, difference; stretch and range"],
      ["Original pixels", "archive A and B on one grid, shared stretch"],
      ["Derived maps", "B − A and (B − A)/σ; masked pixels hatched"],
      ["Quality checks", "registration, wavelength match, coverage"],
      ["Ranked candidate", "tier, peak σ, flux and position error"],
    ];
    notes.forEach(([h, d], i) => {
      const y = iy + i * 0.86;
      t(s, String(i + 1), { x: nx, y, w: 0.3, h: 0.3, fontFace: MONO, fontSize: 12, bold: true, color: C.ink });
      t(s, h, { x: nx + 0.35, y, w: nw - 0.35, h: 0.3, fontSize: 12, bold: true });
      t(s, d, { x: nx + 0.35, y: y + 0.28, w: nw - 0.35, h: 0.5, fontSize: 11, color: C.muted, lineSpacingMultiple: 1.1 });
    });
    cap(s, [{ text: "Fig. 2  ", options: { bold: true, color: C.ink } }, { text: "Compare page, difference mode (pipeline 0.2.0, EPSF matching): M31, detector 1, 2025-07-11 vs 2026-01-04." }],
      { x: ix, y: iy + ih + 0.1, w: iw, h: 0.3 });
    s.addNotes("Full-resolution capture of the running production build against live IRSA data. The graphite surface is used for image work; reading pages use paper.");
  }

  // ===== 5. Science and technology =====
  {
    const s = pres.addSlide({ masterName: "PAPER" });
    head(s, "04", "Science and technology", "Comparing like with like: wavelength, alignment, image shape");
    const y0 = 1.7;
    const c1 = 3.0, c2x = MX + c1 + 0.4, c2 = 4.55, c3x = c2x + c2 + 0.4, c3 = W - MX - c3x;
    // SPHEREx facts
    t(s, "NASA SPHEREx", { x: MX, y: y0, w: c1, h: 0.3, fontFace: SERIF, fontSize: 15 });
    const facts = [["102", "spectral channels"], ["0.75–5.0 µm", "near-infrared range"], ["6", "detectors, linear variable filters"], ["≈ 6 months", "between all-sky passes"]];
    facts.forEach(([v, l], i) => {
      const y = y0 + 0.5 + i * 0.95;
      rule(s, MX, y, c1, C.line);
      t(s, v, { x: MX, y: y + 0.1, w: c1, h: 0.45, fontFace: SERIF, fontSize: 24 });
      t(s, l, { x: MX, y: y + 0.55, w: c1, h: 0.3, fontSize: 11, color: C.muted });
    });
    vrule(s, c2x - 0.2, y0, 4.85);
    // Pipeline as a typographic list
    t(s, "Processing pipeline", { x: c2x, y: y0, w: c2, h: 0.3, fontFace: SERIF, fontSize: 15 });
    const steps = [
      ["Archive Level 2 image", "IMAGE, FLAGS, VARIANCE, ZODI, EPSF, WCS-WAVE"],
      ["Validate and mask", "WCS, units, 17 archive quality flags"],
      ["Register", "common TAN grid; reject residual > 0.35 px"],
      ["Match wavelength", "mask pixels with |Δλ| > ½ bandwidth"],
      ["EPSF cross-convolution", "A ⊗ PSF_B and B ⊗ PSF_A: one shared PSF"],
      ["Difference and uncertainty", "σ propagated from VARIANCE, then rescaled"],
      ["Detect, check, rank", "5σ segments, 7 artifact checks, tiers A/B/R"],
    ];
    steps.forEach(([h, d], i) => {
      const y = y0 + 0.5 + i * 0.62, hl = i === 4;
      rule(s, c2x, y, c2, C.line);
      t(s, String(i + 1), { x: c2x, y: y + 0.08, w: 0.3, h: 0.25, fontFace: MONO, fontSize: 11, color: hl ? C.accent : C.muted, bold: hl });
      t(s, h, { x: c2x + 0.35, y: y + 0.07, w: c2 - 0.35, h: 0.25, fontSize: 12, bold: true, color: hl ? C.accent : C.ink });
      t(s, d, { x: c2x + 0.35, y: y + 0.32, w: c2 - 0.35, h: 0.25, fontSize: 10.5, color: C.muted });
    });
    vrule(s, c3x - 0.2, y0, 4.85);
    // PSF figure + verified results
    t(s, "Why PSF matching matters", { x: c3x, y: y0, w: c3, h: 0.3, fontFace: SERIF, fontSize: 15 });
    const ks = 0.95, ky = y0 + 0.5;
    [["psf_a.png", "epoch A"], ["psf_b.png", "epoch B"], ["psf_common.png", "shared"]].forEach(([f, l], i) => {
      const x = c3x + i * (ks + 0.35);
      plate(s, f, x, ky, ks, ks, `EPSF kernel, ${l}`);
      cap(s, l, { x, y: ky + ks + 0.06, w: ks, h: 0.22, align: "center" });
    });
    t(s, "⊗", { x: c3x + ks + 0.04, y: ky + 0.3, w: 0.27, h: 0.35, fontSize: 14, color: C.muted, align: "center" });
    t(s, "=", { x: c3x + 2 * ks + 0.39, y: ky + 0.3, w: 0.27, h: 0.35, fontSize: 14, color: C.muted, align: "center" });
    t(s, "Two epochs see a star through slightly different PSFs; subtracting them directly leaves dipoles that mimic change.",
      { x: c3x, y: ky + ks + 0.4, w: c3, h: 0.75, fontSize: 11.5, lineSpacingMultiple: 1.15 });
    const vr = [["> 20σ → < 6σ", "synthetic, orthogonal elongations"], ["13.8σ → 3.7σ", "synthetic, epoch rotated 35°"], ["χ² 415k vs 453k", "orientation, 20 real stars"], [`${before}σ → ${after}σ`, "real M31 pair (next slide)"]];
    const vy = ky + ks + 1.25;
    t(s, "Verified in the test suite", { x: c3x, y: vy, w: c3, h: 0.25, fontSize: 11, bold: true });
    vr.forEach(([v, l], i) => {
      const y = vy + 0.32 + i * 0.36;
      rule(s, c3x, y, c3, C.line);
      t(s, v, { x: c3x, y: y + 0.06, w: 1.6, h: 0.26, fontFace: MONO, fontSize: 11, bold: true });
      t(s, l, { x: c3x + 1.65, y: y + 0.07, w: c3 - 1.65, h: 0.26, fontSize: 10.5, color: C.muted });
    });
    s.addNotes("Kernels are the actual EPSF kernels for the two M31 epochs on the comparison grid. Test numbers are from docs/SCIENTIFIC_METHODOLOGY.md.");
  }

  // ===== 6. Results =====
  {
    const s = pres.addSlide({ masterName: "PAPER" });
    head(s, "05", "Demonstration result", "M31 validation: the false dipole disappears");
    s.addShape(pres.shapes.RECTANGLE, { x: W - MX - 5.1, y: 0.38, w: 5.1, h: 0.32, fill: { type: "none" }, line: { color: C.amber, width: 1 } });
    t(s, "PIPELINE VALIDATION EXAMPLE  ·  NOT A CONFIRMED DISCOVERY", { x: W - MX - 5.1, y: 0.38, w: 5.1, h: 0.32, fontSize: 10, bold: true, color: C.amber, align: "center", valign: "middle" });
    const sz = 2.42, g1 = 0.2, g2 = 0.55, y0 = 1.75;
    const total = 4 * sz + 2 * g1 + g2, x0 = MX + (CW - total) / 2;
    const xs = [x0, x0 + sz + g1, x0 + 2 * sz + g1 + g2, x0 + 3 * sz + 2 * g1 + g2];
    const panels = [
      ["m31_epoch_a.png", "(a) Epoch A", "2025-07-11 22:22 · 1.075 µm"],
      ["m31_epoch_b.png", "(b) Epoch B", "2026-01-04 20:50 · 1.080 µm"],
      ["m31_sig_gaussian.png", "(c) Previous PSF step", `peak ${before}σ, ${dip}σ dipole`],
      ["m31_sig_epsf.png", "(d) EPSF matching", `peak ${after}σ, no dipole`],
    ];
    panels.forEach(([f, h, d], i) => {
      t(s, h, { x: xs[i], y: y0, w: sz, h: 0.28, fontSize: 12, bold: true, color: i === 3 ? C.accent : C.ink });
      plate(s, f, xs[i], y0 + 0.32, sz, sz, h);
      t(s, d, { x: xs[i], y: y0 + 0.4 + sz, w: sz, h: 0.25, fontFace: MONO, fontSize: 9.5, color: C.muted });
    });
    const cby = y0 + 0.82 + sz, cbx = xs[2], cbw = xs[3] + sz - xs[2];
    s.addImage({ path: B("sig_colorbar.png"), x: cbx, y: cby, w: cbw, h: 0.1 });
    cap(s, "−10σ fading", { x: cbx, y: cby + 0.13, w: 2, h: 0.22, fontSize: 9 });
    cap(s, "0", { x: cbx + cbw / 2 - 0.2, y: cby + 0.13, w: 0.4, h: 0.22, fontSize: 9, align: "center" });
    cap(s, "brightening +10σ", { x: cbx + cbw - 2, y: cby + 0.13, w: 2, h: 0.22, fontSize: 9, align: "right" });
    cap(s, "(a, b) archive pixels on the common grid, shared stretch; times UTC, λ at the target; 0.10° field, detector 1", { x: xs[0], y: cby, w: 2 * sz + g1, h: 0.4, fontSize: 9 });
    // the numbers
    const sy = 5.48, sw = CW / 3;
    rule(s, MX, sy, CW);
    [[`${before}σ → ${after}σ`, "peak |significance| of the difference image"], [`${dip}σ → none`, "dipole subtraction residual"], ["0.002 px", "registration residual, 176.9-day baseline"]].forEach(([v, l], i) => {
      const x = MX + i * sw;
      if (i) vrule(s, x - 0.15, sy + 0.12, 0.8);
      t(s, v, { x, y: sy + 0.1, w: sw - 0.3, h: 0.5, fontFace: SERIF, fontSize: 26 });
      t(s, l, { x, y: sy + 0.62, w: sw - 0.3, h: 0.3, fontSize: 11, color: C.muted });
    });
    t(s, "Same archive inputs; only the PSF step differs. The previous step matched header FWHMs with a Gaussian and was skipped here (both 7.53″). The remaining −7.4σ detection (ST-2026-000003) is tier B with three warnings and unverified. Cost: resolution 7.5″ → 14.1″.",
      { x: MX, y: 6.5, w: CW, h: 0.45, fontSize: 10, color: C.muted, lineSpacingMultiple: 1.1 });
    s.addNotes("Reproduce with presentation/scripts/m31_psf_validation.py (cached IRSA cutouts; psf_method gaussian vs epsf_cross). Gaussian run: +14.14σ peak and −10.95σ subtraction residual. EPSF run: |S| 7.43σ peak.");
  }

  // ===== 7. Status and direction =====
  {
    const s = pres.addSlide({ masterName: "PAPER" });
    head(s, "06", "Status and direction", "What is built, what is limited, what comes next");
    const tx = MX, tw = 7.65, cw = tw / 3, y0 = 1.65;
    const data = [
      ["Implemented, merged", C.olive, ["Explore, timeline and epoch comparison", "EPSF-based PSF matching with σ maps", "Spectral explorer across 102 channels", "Multi-epoch light curves per channel", "SIMBAD and Gaia DR3 cross-matching", "Candidate pages, investigations, watchlists"]],
      ["Built, with limits", C.amber, ["Coverage maps: not yet run on a real field (archive timeouts)", "Claude assistant: implemented, not yet exercised", "Sharing: links and notes, no user accounts"]],
      ["Planned", C.muted, ["Accounts and team workspaces", "Injection campaign for completeness and false positives", "Ephemeris checks for moving objects", "More surveys through the adapter interface"]],
    ];
    data.forEach(([h, col, items], i) => {
      const x = tx + i * cw;
      s.addShape(pres.shapes.RECTANGLE, { x, y: y0 + 0.08, w: 0.12, h: 0.12, fill: { color: col }, line: { color: col, width: 0 } });
      t(s, h, { x: x + 0.22, y: y0, w: cw - 0.3, h: 0.3, fontSize: 12, bold: true });
      rule(s, x, y0 + 0.42, cw - 0.2, C.ink, 1);
      items.forEach((it, k) => {
        const y = y0 + 0.52 + k * 0.56;
        t(s, it, { x, y, w: cw - 0.3, h: 0.5, fontSize: 11.5, lineSpacingMultiple: 1.1 });
        rule(s, x, y + 0.5, cw - 0.2, C.line);
      });
    });
    const fx = tx + tw + 0.3, fw = W - MX - fx, fh = fw * 824 / 2000;
    plate(s, "shot_spectra.jpg", fx, y0, fw, fh, "Spectral explorer page");
    cap(s, [{ text: "Fig. 3  ", options: { bold: true, color: C.ink } }, { text: "Spectral explorer: IRSA DR1 coadded spectrum (102 channels) and per-exposure photometry at an M31 disk position." }],
      { x: fx, y: y0 + fh + 0.1, w: fw, h: 0.7 });
    rule(s, MX, 5.55, CW, C.ink, 1);
    t(s, "See every observation. Compare like with like. Trust what changed.", { x: MX, y: 5.72, w: CW, h: 0.5, fontFace: SERIF, fontSize: 22 });
    t(s, [{ text: "Snack Seekers", options: { bold: true } }, { text: "   Yazhiniyan M.S.   " }, { text: "github.com/yazhiniyanMS/sky-time-machine", options: { fontFace: MONO, color: C.muted } }],
      { x: MX, y: 6.35, w: CW, h: 0.3, fontSize: 12 });
    s.addNotes("Implemented items are merged on main (PRs #1–#3). Items with limits exist in code with the restrictions stated in docs/LIMITATIONS.md. Planned items are not implemented.");
  }

  await pres.writeFile({ fileName: OUT });
  console.log("wrote", OUT);
})();
