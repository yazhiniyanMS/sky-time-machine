# Processing pipeline

`stm.pipeline.run_comparison(ra, dec, size_deg, product_a, product_b)` runs these stages. The API submits it as a
background job (`POST /api/comparisons`).

## Stage A — Retrieval

1. SIA2 query at the target (radius 0.01°) to resolve product ids to archive records. Responses are cached for
   24 h.
2. IBE cutouts of 1.6 × the requested size, cached by product and position. HTTP errors 5xx, 408 and 429 are
   retried with exponential backoff (1, 2, 4 s). Other 4xx errors fail immediately. A non-FITS response is an
   error.

For the timeline, headers of every exposure are read with HTTP Range requests (~26 kB each), and the detector's
`WCS-WAVE` table once per pipeline version.

## Stage B — Preprocessing and validation

`load_spherex_l2` reads the IMAGE, FLAGS, VARIANCE, ZODI and WCS-WAVE HDUs and checks:

- extension shapes match
- `BUNIT` is MJy/sr
- finite-pixel fraction
- non-negative variance
- time keywords present
- celestial WCS present and the pixel→sky→pixel round trip under 0.01 px
- pixel scale ≈ 6.15″
- Level 1 data-quality flag

It then builds the per-pixel wavelength and bandwidth maps and keeps provenance header keywords.

## Stage C — Registration

`target_grid` builds an odd-sized TAN grid centred on the target. `register` resamples each epoch, grows the
bad-pixel mask, and reports coverage and usable fractions. `registration_check` measures the residual shift.

## Stage D — Differencing

`compare` applies the checks and steps described in [SCIENTIFIC_METHODOLOGY.md](SCIENTIFIC_METHODOLOGY.md):
compatibility checks, spectral mask, ZODI subtraction, optional Gaussian PSF matching, background plane,
uncertainty propagation and empirical noise rescaling.

## Stages E–G — Detection, artifact rejection, ranking

`detect` → `artifacts.assess` → `ranking.classify` / `mark_moving_pairs` / `quality_tier` → sort → `explain`.

## Stage H — Persistence and reproducibility

- `products/<CMP>.npz`: layers `a, b, diff, sigma, significance, valid, dlambda_frac, wave_a, wave_b, bad_a,
  bad_b, source_a, source_b` (float32)
- `products/<CMP>.wcs.hdr`: grid WCS
- `comparisons` row: status, summary, full provenance (inputs, URLs, headers, flag definitions, software
  versions, configuration, grid, checks, metrics, layer descriptions, timestamps)
- `candidates` rows: id, position, measurements, checks, tier, class, rank, explanation, pipeline version,
  verification status

`GET /api/comparisons/{id}/fits/{layer}` exports any layer as FITS with the grid WCS and `STM_*` provenance
keywords. Layers are labelled `original` (archive pixels, resampled) or `derived`.

## Default configuration

```json
{
  "difference": {"max_dlambda_frac": 0.5, "min_valid_fraction": 0.2, "subtract_zodi": true,
                 "fit_background_plane": true, "psf_match": true, "psf_match_min_ratio": 1.05,
                 "noise_rescale": true, "max_registration_shift_pix": 0.35, "min_baseline_days": 0.0,
                 "bad_flags": ["TRANSIENT", "OVERFLOW", "SUR_ERROR", "NONFUNC", "MISSING_DATA", "HOT", "COLD",
                               "NONLINEAR", "PERSIST", "OUTLIER", "GHOST", "GHOST_FPA", "GHOST_EXT", "STREAK",
                               "BLOOM", "SNOWBALL", "HALO"]},
  "detection": {"threshold_sigma": 5.0, "min_pixels": 2, "aperture_fwhm_mult": 1.5, "astrometric_floor_arcsec": 1.0},
  "artifacts": {"max_masked_fraction_in_aperture": 0.3, "min_edge_distance_fwhm": 1.5, "dipole_search_fwhm": 2.0,
                "dipole_min_ratio": 0.3, "bright_residual_snr": 50.0, "bright_residual_max_frac": 0.1,
                "max_dlambda_frac": 0.5, "flag_dilation_pix": 1}
}
```

Changing any value or `PIPELINE_VERSION` produces a new comparison id.

## Running from Python

```python
from stm.pipeline import run_comparison
run_comparison(10.6847, 41.269, 0.1, "2025W28_2A_0263_3D1", "2026W01_2A_0680_1D1")
```
