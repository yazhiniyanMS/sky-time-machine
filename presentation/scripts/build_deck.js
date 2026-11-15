// Builds presentation/Sky-Time-Machine-Project-Demo.pptx from the assets in presentation/assets/build.
// Run from presentation/:  node scripts/build_deck.js
// Every number on the slides comes from the repository docs or from assets/m31_validation.json /
// assets/m31_d1_spectral_timeline.json, which scripts/m31_psf_validation.py and the running API produced.

const path = require("path");
const fs = require("fs");
const pptxgen = require("pptxgenjs");
const React = require("react");
const ReactDOMServer = require("react-dom/server");
const sharp = require("sharp");
const { FiCrosshair, FiDatabase, FiLayers, FiSearch } = require("react-icons/fi");

const ROOT = path.resolve(__dirname, "..");
const B = (f) => path.join(ROOT, "assets", "build", f);
const VAL = JSON.parse(fs.readFileSync(path.join(ROOT, "assets", "m31_validation.json"), "utf8"));
const OBS = JSON.parse(fs.readFileSync(path.join(ROOT, "assets", "m31_observations.json"), "utf8"));
const TL = JSON.parse(fs.readFileSync(path.join(ROOT, "assets", "m31_d1_spectral_timeline.json"), "utf8"));
const OUT = path.join(ROOT, "Sky-Time-Machine-Project-Demo.pptx");
const REPO = "https://github.com/yazhiniyanMS/sky-time-machine";

// Palette: deep space navy, restrained cyan/blue accents. Orange appears only inside data (brightening).
const COL = {
  bg: "05080E",
  surface: "0C121D",
  surface2: "111A28",
  line: "1F2B3D",
  text: "EAF0F7",
  soft: "BAC6D6",
  muted: "8592A6",
  cyan: "5BC8F5",
  blue: "3987E5",
  orange: "E0703A",
  caution: "E3A44B",
};
const FONT = "Arial";
const W = 13.333, H = 7.5, MX = 0.6;

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE";
pres.author = "Yazhiniyan M.S.";
pres.company = "Sky Time Machine";
pres.title = "Sky Time Machine — Project Demonstration";
pres.subject = "Interactive time-domain explorer for NASA/IPAC SPHEREx observations";
pres.theme = { headFontFace: FONT, bodyFontFace: FONT };

pres.defineSlideMaster({
  title: "STM_CONTENT",
  background: { path: B("bg_stars.jpg") },
  objects: [
    { text: { text: "Sky Time Machine", options: { x: MX, y: 7.0, w: 4, h: 0.3, fontFace: FONT, fontSize: 10, color: COL.muted, margin: 0 } } },
  ],
  slideNumber: { x: W - MX - 0.6, y: 7.0, w: 0.6, h: 0.3, fontFace: FONT, fontSize: 10, color: COL.muted, align: "right" },
});
pres.defineSlideMaster({ title: "STM_TITLE", background: { color: COL.bg } });

// ---------- helpers ----------
function text(slide, str, o) {
  slide.addText(str, { fontFace: FONT, margin: 0, isTextBox: true, valign: "top", color: COL.text, ...o });
}
function header(slide, kicker, title) {
  text(slide, kicker.toUpperCase(), { x: MX, y: 0.42, w: 9, h: 0.3, fontSize: 11, bold: true, color: COL.cyan, charSpacing: 1.5 });
  text(slide, title, { x: MX, y: 0.74, w: W - 2 * MX, h: 0.6, fontSize: 30, bold: true, color: COL.text, valign: "middle" });
}
function card(slide, x, y, w, h, opts = {}) {
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x, y, w, h, rectRadius: 0.08,
    fill: { color: opts.fill || COL.surface, transparency: opts.transparency ?? 8 },
    line: { color: opts.line || COL.line, width: opts.lineWidth || 0.75 },
    objectName: opts.name,
  });
}
function img(slide, file, x, y, w, h, o = {}) {
  slide.addImage({ path: B(file), x, y, w, h, ...o });
}
function frame(slide, x, y, w, h) {
  slide.addShape(pres.shapes.RECTANGLE, { x, y, w, h, fill: { type: "none" }, line: { color: COL.line, width: 0.75 } });
}
function marker(slide, n, x, y, d = 0.34) {
  slide.addShape(pres.shapes.OVAL, { x: x - d / 2, y: y - d / 2, w: d, h: d, fill: { color: COL.cyan }, line: { color: COL.bg, width: 1.5 } });
  text(slide, String(n), { x: x - d / 2, y: y - d / 2, w: d, h: d, fontSize: 12, bold: true, color: COL.bg, align: "center", valign: "middle" });
}
function pill(slide, label, x, y, w, color, filled = false) {
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x, y, w, h: 0.3, rectRadius: 0.15,
    fill: filled ? { color } : { color: COL.bg, transparency: 100 },
    line: { color, width: 1 },
  });
  text(slide, label, { x, y, w, h: 0.3, fontSize: 10, bold: true, color: filled ? COL.bg : color, align: "center", valign: "middle", charSpacing: 0.5 });
}
async function icon(Comp, color) {
  const svg = ReactDOMServer.renderToStaticMarkup(React.createElement(Comp, { color: "#" + color, size: 256, strokeWidth: 1.6 }));
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return "image/png;base64," + png.toString("base64");
}
const f1 = (x) => x.toFixed(1).replace("-", "\u2212");

(async () => {
  const E = VAL.epsf_cross, G = VAL.gaussian;
  const before = f1(G.peak_abs_sigma), after = f1(E.peak_abs_sigma), dip = f1(G.peak_neg_sigma);
  const nPairs = TL.pairs.length, nObs = TL.observations.length;
  const waves = TL.observations.map((o) => o.wave_um).filter((v) => v);
  const wmin = Math.min(...waves).toFixed(2), wmax = Math.max(...waves).toFixed(2);

  // ===== 1. Title =====
  {
    const s = pres.addSlide({ masterName: "STM_TITLE" });
    s.addImage({ path: B("hero_explore.jpg"), x: 0, y: 0, w: W, h: H, altText: "Sky Time Machine Explore view of M31 with SPHEREx footprints" });
    s.addImage({ path: B("hero_scrim.png"), x: 0, y: 0, w: W, h: H });
    text(s, "NASA SPHEREX  ·  TIME-DOMAIN EXPLORER", { x: MX + 0.1, y: 1.5, w: 7, h: 0.3, fontSize: 12, bold: true, color: COL.cyan, charSpacing: 1.5 });
    text(s, "Sky Time Machine", { x: MX + 0.1, y: 1.9, w: 7.5, h: 1.0, fontSize: 54, bold: true, color: "FFFFFF", valign: "middle" });
    text(s, "A new way to explore how the universe changes over time.", { x: MX + 0.1, y: 3.0, w: 6.3, h: 0.9, fontSize: 22, color: COL.text });
    text(s,
      "Pick a position on the sky, see every archived SPHEREx exposure of it, compare two epochs taken at the same wavelength, and inspect what changed, with its uncertainty, quality checks and provenance.",
      { x: MX + 0.1, y: 4.05, w: 5.6, h: 1.2, fontSize: 14, color: COL.soft, lineSpacingMultiple: 1.15 });
    text(s, "CREATED BY", { x: MX + 0.1, y: 5.55, w: 3, h: 0.25, fontSize: 10, bold: true, color: COL.muted, charSpacing: 1.5 });
    text(s, "Yazhiniyan M.S.", { x: MX + 0.1, y: 5.82, w: 5, h: 0.45, fontSize: 20, bold: true, color: "FFFFFF" });
    text(s, "github.com/yazhiniyanMS/sky-time-machine", { x: MX + 0.1, y: 6.42, w: 6, h: 0.3, fontSize: 12, color: COL.cyan });
    text(s, "Live app view: M31 with real SPHEREx DR1 detector-1 footprints · background DSS2 colour via IRSA HiPS",
      { x: W - MX - 8.2, y: 7.02, w: 8.2, h: 0.28, fontSize: 10, color: COL.soft, align: "right" });
    s.addNotes("Sky Time Machine, built by Yazhiniyan M.S. The background is a real screenshot of the app's Explore view: Andromeda (M31) with the actual SPHEREx DR1 detector-1 footprints that cover it.");
  }

  // ===== 2. Problem =====
  {
    const s = pres.addSlide({ masterName: "STM_CONTENT" });
    header(s, "01  ·  The problem", "Comparing the same sky across dates is harder than it looks");
    const cw = 3.84, gap = 0.31, y0 = 1.75, ch = 4.95;
    const xs = [MX, MX + cw + gap, MX + 2 * (cw + gap)];
    const heads = ["Observations are scattered in time", "Each exposure sees a different wavelength", "Naive subtraction invents signals"];
    xs.forEach((x, i) => {
      card(s, x, y0, cw, ch);
      text(s, String(i + 1).padStart(2, "0"), { x: x + 0.3, y: y0 + 0.28, w: 0.6, h: 0.3, fontSize: 12, bold: true, color: COL.cyan });
      text(s, heads[i], { x: x + 0.3, y: y0 + 0.58, w: cw - 0.6, h: 0.7, fontSize: 17, bold: true });
    });
    // Shared native-chart styling (axis labels identical on both charts).
    const vy = y0 + 1.22, vh = 2.0, ty = y0 + 3.32, capY = y0 + ch - 0.42;
    const axis = (yTitle, xTitle) => ({
      valAxisLabelColor: COL.muted, catAxisLabelColor: COL.muted, valAxisLabelFontSize: 10, catAxisLabelFontSize: 10,
      valAxisLabelFontFace: FONT, catAxisLabelFontFace: FONT,
      showValAxisTitle: true, valAxisTitle: yTitle, valAxisTitleColor: COL.muted, valAxisTitleFontSize: 10, valAxisTitleFontFace: FONT,
      showCatAxisTitle: true, catAxisTitle: xTitle, catAxisTitleColor: COL.muted, catAxisTitleFontSize: 10, catAxisTitleFontFace: FONT,
      valGridLine: { color: "1A2433", size: 0.5 }, catGridLine: { style: "none" },
      valAxisLineShow: false, catAxisLineColor: "2A3647", showLegend: false,
      catAxisMinVal: 0, catAxisMaxVal: 200, catAxisMajorUnit: 50, catAxisLabelFormatCode: "0",
      lineSize: 0, lineDataSymbol: "circle", lineDataSymbolSize: 6,
      plotArea: { fill: { color: COL.surface } }, chartArea: { fill: { color: COL.surface } },
    });
    const body = (x, str) => text(s, str, { x: x + 0.3, y: ty, w: cw - 0.6, h: 1.05, fontSize: 14, color: COL.soft, lineSpacingMultiple: 1.08 });
    const cap = (x, str) => text(s, str, { x: x + 0.3, y: capY, w: cw - 0.6, h: 0.25, fontSize: 10, color: COL.muted });

    // 1: native scatter — every M31 exposure midpoint by detector (IRSA SIA2 result served by the app's API)
    const T0 = Math.min(...OBS.exposures.map((e) => e.t_mid_mjd));
    const pts = [];
    OBS.exposures.forEach((e) => e.products.forEach((p) => pts.push([+(e.t_mid_mjd - T0).toFixed(3), p.detector])));
    const DET = ["3987E5", "D95926", "199E70", "C98500", "D55181", "0CA30C"];
    s.addChart(pres.charts.SCATTER, [{ name: "days", values: pts.map((p) => p[0]) }].concat(
      [1, 2, 3, 4, 5, 6].map((d) => ({ name: "D" + d, values: pts.map((p) => (p[1] === d ? d : null)) }))
    ), { x: xs[0] + 0.15, y: vy, w: cw - 0.3, h: vh, chartColors: DET, ...axis("detector", "days since 2025-07-09"),
      valAxisMinVal: 0.5, valAxisMaxVal: 6.5, valAxisMajorUnit: 1, valAxisLabelFormatCode: "0" });
    const maxGap = Math.round(Math.max(...OBS.coverage_gaps.map((g) => g.days)));
    body(xs[0], `At M31: ${OBS.n_products} images from ${OBS.n_exposures} exposures on six detectors, with a ${maxGap}-day gap in coverage.`);
    cap(xs[0], "Exposure midpoints, 2025-07-09 to 2026-01-28");

    // 2: native scatter — wavelength at the target for each detector-1 exposure
    const t0 = Math.min(...TL.observations.map((o) => o.t_mid_mjd));
    const obs = TL.observations.filter((o) => o.wave_um);
    s.addChart(pres.charts.SCATTER, [
      { name: "days", values: obs.map((o) => +(o.t_mid_mjd - t0).toFixed(3)) },
      { name: "λ", values: obs.map((o) => Math.round(o.wave_um * 1000)) },
    ], { x: xs[1] + 0.15, y: vy, w: cw - 0.3, h: vh, chartColors: [COL.blue], ...axis("λ at target (nm)", "days since 2025-07-09"),
      valAxisMinVal: 700, valAxisMaxVal: 1150, valAxisMajorUnit: 100, valAxisLabelFormatCode: "0" });
    body(xs[1], `Detector 1 saw M31 anywhere from ${Math.round(Math.min(...waves) * 1000)} to ${Math.round(Math.max(...waves) * 1000)} nm. Only ${nPairs} epoch pairs match within half a bandwidth.`);
    cap(xs[1], `${nObs} detector-1 exposures, from FITS headers`);

    // 3: the real false dipole
    const side = vh;
    img(s, "m31_sig_gaussian.png", xs[2] + (cw - side) / 2, vy, side, side);
    frame(s, xs[2] + (cw - side) / 2, vy, side, side);
    body(xs[2], `Mismatched image shapes left a +${before}σ / ${dip}σ dipole on a bright source: an artifact, not a change.`);
    cap(xs[2], "Significance map, previous PSF step (ringed)");
    s.addNotes("Three real obstacles, all measured at M31: scattered epochs, a different wavelength in every exposure because of SPHEREx's linear variable filters, and subtraction artifacts from mismatched PSFs.");
  }

  // ===== 3. Solution =====
  {
    const s = pres.addSlide({ masterName: "STM_CONTENT" });
    header(s, "02  ·  The solution", "One interface from sky position to inspected change");
    const steps = [
      [FiCrosshair, "Select a sky region", "Search a name or coordinates on an interactive sky map showing real SPHEREx footprints."],
      [FiDatabase, "Retrieve observations", "Query the IRSA archive and read each exposure's wavelength at the target from its FITS header."],
      [FiLayers, "Compare epochs", "Pair exposures from the same detector at matching wavelength. Blink, side by side, or subtract."],
      [FiSearch, "Inspect differences", "Ranked candidates with σ maps, artifact checks, an explanation and a permanent link."],
    ];
    const n = steps.length, colW = 2.7, gap = (W - 2 * MX - n * colW) / (n - 1), cy = 2.35, d = 1.15;
    for (let i = 0; i < n; i++) {
      const x = MX + i * (colW + gap), cx = x + colW / 2;
      s.addShape(pres.shapes.OVAL, { x: cx - d / 2, y: cy, w: d, h: d, fill: { color: COL.surface2 }, line: { color: COL.cyan, width: 1.25 } });
      s.addImage({ data: await icon(steps[i][0], COL.cyan), x: cx - 0.28, y: cy + d / 2 - 0.28, w: 0.56, h: 0.56 });
      if (i < n - 1) {
        s.addShape(pres.shapes.LINE, { x: cx + d / 2 + 0.15, y: cy + d / 2, w: colW + gap - d - 0.3, h: 0, line: { color: COL.cyan, width: 1.25, endArrowType: "triangle", transparency: 30 } });
      }
      text(s, String(i + 1).padStart(2, "0"), { x, y: cy + d + 0.3, w: colW, h: 0.3, fontSize: 12, bold: true, color: COL.cyan, align: "center" });
      text(s, steps[i][1], { x, y: cy + d + 0.6, w: colW, h: 0.4, fontSize: 18, bold: true, align: "center" });
      text(s, steps[i][2], { x: x + 0.05, y: cy + d + 1.05, w: colW - 0.1, h: 1.1, fontSize: 14, color: COL.soft, align: "center", lineSpacingMultiple: 1.1 });
    }
    const by = 5.95, bh = 0.8;
    card(s, MX, by, W - 2 * MX, bh, { fill: COL.surface2 });
    const facts = [
      ["Live archive data", "NASA/IPAC IRSA SPHEREx DR1, nothing simulated"],
      ["Like with like", "same detector, |Δλ| ≤ ½ bandwidth"],
      ["Honest output", "every layer labelled original or derived, with σ"],
    ];
    const fw = (W - 2 * MX) / 3;
    facts.forEach(([h, t], i) => {
      text(s, [{ text: h + "  ", options: { bold: true, color: COL.text } }, { text: t, options: { color: COL.soft } }],
        { x: MX + 0.3 + i * fw, y: by, w: fw - 0.4, h: bh, fontSize: 13, valign: "middle" });
    });
    s.addNotes("The workflow mirrors the app's navigation: Explore, Timeline, Compare and the candidate pages.");
  }

  // ===== 4. Live product =====
  {
    const s = pres.addSlide({ masterName: "STM_CONTENT" });
    header(s, "03  ·  Live product demonstration", "Real SPHEREx data, end to end, in the running app");
    const y0 = 1.62;
    // Compare page (main)
    const cw = 7.95, chh = cw * 1680 / 3200;
    img(s, "demo_compare.jpg", MX, y0, cw, chh, { altText: "Compare page, M31 epochs 2025-07-11 and 2026-01-04" });
    frame(s, MX, y0, cw, chh);
    // Right column: explore + timeline
    const rx = MX + cw + 0.3, rw = W - MX - rx;
    const eh = rw * 1410 / 2400;
    img(s, "demo_explore.jpg", rx, y0, rw, eh); frame(s, rx, y0, rw, eh);
    const th = rw * 998 / 2400;
    img(s, "demo_timeline.jpg", rx, y0 + eh + 0.2, rw, th); frame(s, rx, y0 + eh + 0.2, rw, th);
    // markers (positions as fractions of each screenshot)
    marker(s, 1, rx + rw * 0.42, y0 + eh * 0.5);
    marker(s, 2, rx + rw * 0.17, y0 + eh + 0.2 + th * 0.33);
    marker(s, 3, MX + cw * 0.195, y0 + chh * 0.152);
    marker(s, 4, MX + cw * 0.568, y0 + chh * 0.152);
    marker(s, 5, MX + cw * 0.03, y0 + chh * 0.93);
    marker(s, 6, MX + cw * 0.762, y0 + chh * 0.355);
    const notes = [
      ["Explore", "M31 with real detector-1 footprints"],
      ["Timeline", "116 exposure midpoints, D1–D6"],
      ["Epochs A, B", "archive pixels 176.9 days apart"],
      ["Difference, σ", "derived maps with masks"],
      ["Ranked candidate", "tier, σ, flux, position error"],
      ["Quality checks", "registration, λ, coverage"],
    ];
    const ly = y0 + chh + 0.28, lw = (W - 2 * MX) / 3;
    notes.forEach(([h, t], i) => {
      const col = i % 3, row = Math.floor(i / 3);
      const x = MX + col * lw, y = ly + row * 0.42;
      marker(s, i + 1, x + 0.17, y + 0.15, 0.3);
      text(s, [{ text: h + "  ", options: { bold: true, color: COL.text } }, { text: t, options: { color: COL.soft } }],
        { x: x + 0.45, y, w: lw - 0.5, h: 0.3, fontSize: 12, valign: "middle" });
    });
    s.addNotes("All three are full-resolution captures of the running app (Next.js frontend + FastAPI backend) against live IRSA data. The Compare page re-ran the current pipeline (stm-pipeline-0.2.0, EPSF matching) on the M31 detector-1 pair 2025-07-11 vs 2026-01-04.");
  }

  // ===== 5. Science and technology =====
  {
    const s = pres.addSlide({ masterName: "STM_CONTENT" });
    header(s, "04  ·  The science and technology", "Like with like: wavelength, alignment and image shape");
    // SPHEREx facts
    const facts = [["102", "spectral channels"], ["0.75–5.0 µm", "near-infrared coverage"], ["6", "detectors with linear variable filters"], ["All sky", "mapped about every six months"]];
    const fw = (W - 2 * MX) / 4;
    facts.forEach(([v, l], i) => {
      text(s, v, { x: MX + i * fw, y: 1.55, w: fw - 0.2, h: 0.55, fontSize: 28, bold: true, color: COL.cyan });
      text(s, l, { x: MX + i * fw, y: 2.1, w: fw - 0.2, h: 0.3, fontSize: 12, color: COL.soft });
    });
    // Pipeline chain
    const steps = [
      ["SPHEREx L2", "image, flags, variance, zodi, EPSF"],
      ["Validate & mask", "WCS, units, 17 archive flags"],
      ["Register", "common TAN grid, residual check"],
      ["Match wavelength", "|Δλ| ≤ ½ bandwidth per pixel"],
      ["EPSF cross-convolution", "A⊗PSF_B and B⊗PSF_A"],
      ["Difference + σ", "propagated, then rescaled"],
      ["Detect & rank", "5σ, 7 artifact checks, tiers"],
    ];
    const n = steps.length, py = 2.7, ph = 1.2, pg = 0.2, pw = (W - 2 * MX - (n - 1) * pg) / n;
    steps.forEach(([h, t], i) => {
      const x = MX + i * (pw + pg), hl = i === 4;
      card(s, x, py, pw, ph, { fill: hl ? "0E2A3A" : COL.surface, line: hl ? COL.cyan : COL.line, lineWidth: hl ? 1.5 : 0.75, transparency: 0 });
      text(s, h, { x: x + 0.1, y: py + 0.1, w: pw - 0.2, h: 0.45, fontSize: 12, bold: true, color: hl ? COL.cyan : COL.text, align: "center", valign: "middle" });
      text(s, t, { x: x + 0.1, y: py + 0.6, w: pw - 0.2, h: 0.5, fontSize: 10, color: COL.soft, align: "center" });
      if (i < n - 1) s.addShape(pres.shapes.LINE, { x: x + pw + 0.02, y: py + ph / 2, w: pg - 0.04, h: 0, line: { color: COL.muted, width: 1, endArrowType: "triangle" } });
    });
    // Why PSF matching matters (real kernels from the M31 pair)
    const by = 4.2, bh = 2.55;
    card(s, MX, by, 7.0, bh);
    text(s, "Why PSF matching matters", { x: MX + 0.3, y: by + 0.22, w: 6.4, h: 0.35, fontSize: 16, bold: true });
    const ks = 1.0, ky = by + 0.75, kx0 = MX + 0.3;
    const kern = [["psf_a.png", "Epoch A PSF"], ["psf_b.png", "Epoch B PSF"], ["psf_common.png", "Shared PSF"]];
    kern.forEach(([f, l], i) => {
      const x = kx0 + i * 1.3;
      img(s, f, x, ky, ks, ks); frame(s, x, ky, ks, ks);
      text(s, l, { x: x - 0.1, y: ky + ks + 0.08, w: ks + 0.2, h: 0.25, fontSize: 10, color: COL.muted, align: "center" });
    });
    text(s, "⊗", { x: kx0 + ks + 0.02, y: ky + 0.3, w: 0.26, h: 0.4, fontSize: 16, color: COL.soft, align: "center" });
    text(s, "=", { x: kx0 + 1.3 + ks + 0.02, y: ky + 0.3, w: 0.26, h: 0.4, fontSize: 16, color: COL.soft, align: "center" });
    text(s, "Two epochs see a star through slightly different PSFs, so direct subtraction leaves dipoles that mimic real change. Convolving each epoch with the other's empirical PSF gives both one shape, without deconvolution.",
      { x: MX + 4.15, y: by + 0.72, w: 2.6, h: 1.7, fontSize: 12, color: COL.soft, lineSpacingMultiple: 1.05 });
    // Verified results
    const vx = MX + 7.3, vw = W - MX - vx;
    card(s, vx, by, vw, bh);
    text(s, "Verified in the test suite", { x: vx + 0.3, y: by + 0.22, w: vw - 0.6, h: 0.35, fontSize: 16, bold: true });
    const rows = [
      ["> 20σ → < 6σ", "synthetic stars, orthogonal PSF elongations"],
      ["13.8σ → 3.7σ", "synthetic, epoch rotated 35°, S/N ≤ 60"],
      ["χ² 415k vs 453k", "EPSF orientation confirmed on 20 real stars"],
      [`${before}σ → ${after}σ`, "real M31 pair (next slide)"],
    ];
    rows.forEach(([v, l], i) => {
      const y = by + 0.72 + i * 0.44;
      text(s, v, { x: vx + 0.3, y, w: 1.75, h: 0.36, fontSize: 14, bold: true, color: COL.cyan, valign: "middle" });
      text(s, l, { x: vx + 2.1, y, w: vw - 2.35, h: 0.36, fontSize: 11, color: COL.soft, valign: "middle" });
    });
    s.addNotes("Kernels shown are the actual EPSF kernels evaluated on the comparison grid for the two M31 epochs (rotations 25.7° and −148.4°). Test numbers are from docs/SCIENTIFIC_METHODOLOGY.md.");
  }

  // ===== 6. Results =====
  {
    const s = pres.addSlide({ masterName: "STM_CONTENT" });
    header(s, "05  ·  Demonstration results", "M31 validation: the false dipole disappears");
    pill(s, "VALIDATION EXAMPLE  ·  NOT A CONFIRMED DISCOVERY", W - MX - 4.9, 0.4, 4.9, COL.caution);
    const sz = 2.3, y0 = 1.62, g1 = 0.22, g2 = 0.6;
    const total = 4 * sz + 2 * g1 + g2, x0 = (W - total) / 2;
    const xs = [x0, x0 + sz + g1, x0 + 2 * sz + g1 + g2, x0 + 3 * sz + 2 * g1 + g2];
    const panels = [
      ["m31_epoch_a.png", "Epoch A", "2025-07-11 22:22 UTC · λ 1.075 µm"],
      ["m31_epoch_b.png", "Epoch B", "2026-01-04 20:50 UTC · λ 1.080 µm"],
      ["m31_sig_gaussian.png", "Before: previous PSF step", `peak ${before}σ · ${dip}σ dipole`],
      ["m31_sig_epsf.png", "After: EPSF matching", `peak ${after}σ · no dipole`],
    ];
    panels.forEach(([f, h, t], i) => {
      text(s, h, { x: xs[i], y: y0 - 0.02, w: sz, h: 0.3, fontSize: 13, bold: true, color: i === 3 ? COL.cyan : COL.text });
      img(s, f, xs[i], y0 + 0.33, sz, sz); frame(s, xs[i], y0 + 0.33, sz, sz);
      text(s, t, { x: xs[i], y: y0 + 0.4 + sz, w: sz, h: 0.25, fontSize: 10, color: COL.soft });
    });
    // arrow between before/after
    s.addShape(pres.shapes.LINE, { x: xs[2] + sz + 0.03, y: y0 + 0.33 + sz / 2, w: g1 - 0.06, h: 0, line: { color: COL.cyan, width: 1.5, endArrowType: "triangle" } });
    // colour bar under the significance maps
    const cbx = xs[2], cbw = xs[3] + sz - xs[2], cby = y0 + 0.78 + sz;
    img(s, "sig_colorbar.png", cbx, cby, cbw, 0.12);
    text(s, "−10σ  fading", { x: cbx, y: cby + 0.15, w: 2, h: 0.22, fontSize: 10, color: COL.muted });
    text(s, "0", { x: cbx + cbw / 2 - 0.2, y: cby + 0.15, w: 0.4, h: 0.22, fontSize: 10, color: COL.muted, align: "center" });
    text(s, "brightening  +10σ", { x: cbx + cbw - 2, y: cby + 0.15, w: 2, h: 0.22, fontSize: 10, color: COL.muted, align: "right" });
    text(s, "Archive pixels on the common grid, shared stretch · 0.10° field, detector 1", { x: xs[0], y: cby, w: 2 * sz + g1, h: 0.25, fontSize: 10, color: COL.muted });
    // stats
    const sy = 5.22, sw = (W - 2 * MX - 0.6) / 3;
    const stats = [
      [`${before}σ → ${after}σ`, "peak |significance| of the difference image"],
      [`${dip}σ → gone`, "dipole subtraction residual removed"],
      ["0.002 px", "registration residual · 176.9-day baseline"],
    ];
    stats.forEach(([v, l], i) => {
      const x = MX + i * (sw + 0.3);
      card(s, x, sy, sw, 1.0, { fill: COL.surface2 });
      text(s, v, { x: x + 0.25, y: sy + 0.1, w: sw - 0.5, h: 0.5, fontSize: 24, bold: true, color: COL.cyan, valign: "middle" });
      text(s, l, { x: x + 0.25, y: sy + 0.6, w: sw - 0.5, h: 0.3, fontSize: 12, color: COL.soft });
    });
    text(s, "Same archive inputs; only the PSF step differs. The previous step matched header FWHMs with a Gaussian and was skipped here, as both report 7.53″. The remaining \u22127.4σ detection (ST-2026-000003) is tier B with three warnings and is unverified. Cost: resolution 7.5″ → 14.1″.",
      { x: MX, y: 6.35, w: W - 2 * MX, h: 0.5, fontSize: 11, color: COL.muted, lineSpacingMultiple: 1.05 });
    s.addNotes("Reproduce with presentation/scripts/m31_psf_validation.py: same cached IRSA cutouts, psf_method 'gaussian' vs 'epsf_cross'. Gaussian run: peak +14.14σ, minimum −10.95σ (subtraction residual). EPSF run: peak |S| 7.43σ, one tier-B 'variable candidate' at −7.43σ with edge_distance, quality_flags_nearby and extent warnings.");
  }

  // ===== 7. Future + closing =====
  {
    const s = pres.addSlide({ masterName: "STM_CONTENT" });
    header(s, "06  ·  Future direction", "From comparison tool to research platform");
    const cols = [
      { h: "Implemented", tag: "MERGED", color: COL.cyan, filled: true, items: [
        "Sky explorer, observation timeline, epoch comparison",
        "EPSF-based PSF matching with uncertainty maps",
        "Spectral explorer across the 102 channels",
        "Multi-epoch light curves per channel",
        "SIMBAD and Gaia DR3 cross-matching",
        "Candidate pages, investigations, watchlists" ] },
      { h: "In development", tag: "LIMITED", color: COL.caution, filled: false, items: [
        "Coverage heatmaps: built, not yet run on a real field (archive timeouts)",
        "Claude-powered assistant: implemented, not yet exercised",
        "Collaboration: shareable investigations and notes, no accounts yet" ] },
      { h: "Planned", tag: "ROADMAP", color: COL.muted, filled: false, items: [
        "Accounts and team workspaces for collaborative research",
        "Injection campaign to measure completeness and false positives",
        "Ephemeris cross-checks for moving objects",
        "More surveys through the adapter interface" ] },
    ];
    const cy = 1.6, chh = 3.95, gap = 0.3, cw = (W - 2 * MX - 2 * gap) / 3;
    cols.forEach((c, i) => {
      const x = MX + i * (cw + gap);
      card(s, x, cy, cw, chh);
      text(s, c.h, { x: x + 0.3, y: cy + 0.25, w: cw - 1.9, h: 0.4, fontSize: 18, bold: true, valign: "middle" });
      pill(s, c.tag, x + cw - 1.45, cy + 0.3, 1.15, c.color, c.filled);
      const runs = c.items.map((t, k) => ({ text: t, options: { bullet: { indent: 14 }, breakLine: k < c.items.length - 1, paraSpaceAfter: 6 } }));
      text(s, runs, { x: x + 0.3, y: cy + 0.85, w: cw - 0.55, h: chh - 1.0, fontSize: 13, color: COL.soft, lineSpacingMultiple: 1.05 });
    });
    text(s, "See every observation. Compare like with like. Trust what changed.",
      { x: MX, y: 5.85, w: W - 2 * MX, h: 0.5, fontSize: 24, bold: true, color: "FFFFFF", valign: "middle" });
    text(s, [{ text: "github.com/yazhiniyanMS/sky-time-machine" }, { text: "     ·     Yazhiniyan M.S.", options: { color: COL.soft } }],
      { x: MX, y: 6.4, w: W - 2 * MX, h: 0.35, fontSize: 14, color: COL.cyan, valign: "middle" });
    s.addNotes("Implemented items are merged on main (PRs #1–#3). 'In development' items exist in code but have the stated limits (docs/LIMITATIONS.md). 'Planned' items are not implemented.");
  }

  await pres.writeFile({ fileName: OUT });
  console.log("wrote", OUT);
})();
