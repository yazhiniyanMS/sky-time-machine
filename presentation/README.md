# Sky Time Machine — project demonstration deck

| File | What it is |
|---|---|
| `Sky-Time-Machine-Project-Demo.pptx` | Editable 7-slide deck (16:9, Arial, native charts and text) |
| `Sky-Time-Machine-Project-Demo.pdf` | PDF export of the same deck (made with Keynote) |
| `scripts/build.sh` | Rebuilds everything below in order |
| `scripts/m31_psf_validation.py` | Re-runs the M31 detector-1 comparison with the previous PSF step and with EPSF cross-convolution; writes `assets/m31_validation.json` and the layer `.npz` files |
| `scripts/capture_screens.mjs` | Headless-Firefox capture of the running app at 1600×1000 CSS px, 2× (needs `npm install`) |
| `scripts/make_figures.py` | Builds the figures, crops and backgrounds in `assets/build/` from the captures and the validation run |
| `scripts/build_deck.js` | pptxgenjs script that lays out the slides |
| `scripts/export_pdf.applescript` | Keynote PDF export |
| `assets/screens/` | Raw app screenshots (Explore, Timeline, Compare, Discovery, Spectra) |
| `assets/m31_observations.json`, `assets/m31_d1_spectral_timeline.json` | API responses behind the slide 2 charts |

## Slides

1. **Title.** Sky Time Machine, one-line introduction, creator Yazhiniyan M.S. The background is the app's Explore view of M31 with real SPHEREx DR1 detector-1 footprints.
2. **The problem.** Three real obstacles at M31:
   - epochs are scattered in time (229 images, 116 exposures, a 125-day gap);
   - each exposure sees a different wavelength (744–1105 nm on detector 1, only 26 matched pairs);
   - naive subtraction leaves a false +14.1σ / −11.0σ dipole.
3. **The solution.** Four-step workflow: select a region, retrieve observations, compare epochs, inspect differences. Also covers the three principles: live data, like with like, honest output.
4. **Live product demonstration.** Annotated screenshots of the Compare, Explore and Timeline pages running against live IRSA data.
5. **Science and technology.**
   - SPHEREx facts: 102 channels, 0.75–5.0 µm, 6 detectors.
   - The seven-stage pipeline, with EPSF cross-convolution highlighted.
   - The real on-grid EPSF kernels for the two M31 epochs.
   - The PSF-matching results from the test suite.
6. **Demonstration results.** M31 epochs A and B and the significance maps before and after EPSF matching: 14.1σ → 7.4σ, and the −11.0σ dipole is gone.
   - Labelled as a pipeline validation example, not a discovery.
   - States the caveats (previous Gaussian step skipped because the header FWHMs are equal; remaining candidate is unverified; resolution cost).
7. **Future direction.** Features split into implemented (merged), in development (limited) and planned, then a closing line and the repository link.

## Rebuild

From the repository root, with the backend virtualenv and the frontend dependencies installed:

```bash
cd presentation && npm install && cd ..
# optional: refresh screenshots (backend on :8000, frontend on :3000)
node presentation/scripts/capture_screens.mjs "http://localhost:3000/?ra=10.6847&dec=41.269&fov=3" presentation/assets/screens/explore.png 12000
sh presentation/scripts/build.sh
```

`m31_psf_validation.py` reads the cached IRSA cutouts under `data/spherex/cutouts/`, which the app writes the first time it runs the M31 comparison.
