# Sky Time Machine — project demonstration deck (Snack Seekers)

The deck uses the same visual system as the web app: "Plate & Graphite", described in
[docs/DESIGN_SYSTEM.md](../docs/DESIGN_SYSTEM.md). It has paper slides, Georgia titles, Arial text and
Courier New for measurements. Real screenshots and pipeline outputs appear as captioned figure plates.

| File | What it is |
|---|---|
| `Sky-Time-Machine-Project-Demo.pptx` | Editable 7-slide deck (16:9; native text and charts) |
| `Sky-Time-Machine-Project-Demo.pdf` | PDF export of the same deck (Keynote) |
| `scripts/build.sh` | Rebuilds everything below in order |
| `scripts/m31_psf_validation.py` | Re-runs the M31 detector-1 comparison with the previous PSF step and with EPSF cross-convolution; writes `assets/m31_validation.json` and the layer `.npz` files |
| `scripts/capture_screens.mjs` | Headless-Firefox capture of the running app at 1600 × 1000 CSS px, 2× (`npm install` first) |
| `scripts/make_figures.py` | Builds the figure plates, crops and thumbnails in `assets/build/` |
| `scripts/build_deck.js` | pptxgenjs script that lays out the slides |
| `scripts/export_pdf.applescript` | Keynote PDF export |
| `scripts/check_palette.py` | OKLab / colour-vision check used for the detector palette |
| `assets/screens/` | Raw captures of the production build: Explore, Timeline, Compare, candidate page, Spectra |
| `assets/m31_observations.json`, `assets/m31_d1_spectral_timeline.json` | API responses behind the slide 2 charts |

## Slides

1. **Title.** Sky Time Machine, its purpose, team Snack Seekers (Yazhiniyan M.S.). Figure 1 is the Explore workspace on M31 with real SPHEREx footprints.
2. **The problem.** Three measured obstacles at M31:
   - scattered epochs (native chart of 229 images, 116 exposures, a 125-day gap);
   - a different wavelength in every exposure (native chart, 744–1105 nm on detector 1, 26 matched pairs);
   - a false +14.1σ / −11.0σ dipole from the previous PSF step.
3. **The solution.** Four steps, each shown with a thumbnail of the real page: select a region, retrieve observations, compare epochs, inspect differences. Also covers the three principles: live archive data, like with like, honest output.
4. **Live product.** The Compare page in difference mode with six numbered annotations.
5. **Science and technology.**
   - SPHEREx facts: 102 channels, 0.75–5.0 µm, 6 detectors.
   - The seven-step pipeline, with EPSF cross-convolution highlighted.
   - The real EPSF kernels of the two M31 epochs.
   - The PSF-matching results from the test suite.
6. **Demonstration result.** M31 epochs A and B and significance maps before and after EPSF matching: 14.1σ → 7.4σ, and the dipole is removed. Labelled a validation example, not a discovery, with the caveats on the slide.
7. **Status and direction.** An editorial table of what is implemented (merged), what is built with limits, and what is planned; Figure 3 shows the spectral explorer. Ends with the closing line, team and repository.

## Rebuild

From the repository root, with the backend virtualenv and frontend dependencies installed and the app running
(backend on :8000, production frontend on :3000 via `npm run build && npm run start`):

```bash
cd presentation && npm install && cd ..
node presentation/scripts/capture_screens.mjs "http://localhost:3000/?ra=10.6847&dec=41.269&fov=3" presentation/assets/screens/explore.png 15000
sh presentation/scripts/build.sh
```

`m31_psf_validation.py` reads the cached IRSA cutouts under `data/spherex/cutouts/`, which the app writes the first
time it runs the M31 comparison. PDF export needs Keynote (macOS).
