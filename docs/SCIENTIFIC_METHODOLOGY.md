# Scientific methodology

This document states what the pipeline measures, the assumptions behind each step, and how uncertainty is
treated. It is also retrieved by the Sky Intelligence assistant.

## Why wavelength matching comes first

SPHEREx images through linear variable filters: the central wavelength changes across the detector (by about
1.8 × 10⁻⁴ µm per pixel along the dispersion direction in detector 1). The same sky position therefore lands
at a different wavelength in each exposure unless the pointing repeats. Subtracting two exposures taken at
different wavelengths measures the source spectrum, not time variability.

The pipeline evaluates the `WCS-WAVE` lookup table of each product at every pixel (bilinear interpolation in raw
detector coordinates, FITS Paper III `-TAB`). Our implementation agrees with wcslib to < 10⁻⁹ µm on a real
cutout once the celestial SIP terms, which astropy would otherwise apply to the wavelength axis too, are
excluded (`tests/test_fitsio.py`). After resampling both epochs to a common grid, pixels with
|λ_A − λ_B| > 0.5 × bandwidth are masked. A comparison with no spectrally matched pixels is rejected.

To find usable pairs before downloading images, the timeline estimates the wavelength at the target for every
exposure from its full-frame header (read with HTTP Range requests) and the detector lookup table.

## Background

SPHEREx `IMAGE` pixels include zodiacal light, which changes with observing geometry. The archive `ZODI` model
is subtracted from each epoch. A sigma-clipped (3σ) plane is then fitted to the difference image over usable,
non-`SOURCE` pixels and removed, absorbing residual offsets and gradients.

## Registration

Both epochs are resampled onto a tangent-plane grid centred on the target at the native 6.15″ pixel scale using
the archive astrometric WCS (TAN-SIP). Science and variance planes use bilinear interpolation, flags use nearest
neighbour, and any output pixel touching a bad input pixel is masked. A windowed cross-correlation then measures
any residual translation within ±5 px; above 0.35 px the comparison is rejected rather than shifted. On real M31
pairs the residual was 0.002 px.

## PSF matching

If header `PSF_FWHM` values differ by more than 5 %, the sharper epoch is convolved with a Gaussian of
σ = √(FWHM_broad² − FWHM_sharp²)/2.3548. This is a first-order correction: SPHEREx PSFs are undersampled
(FWHM ≈ 1.2 px) and vary across the detector, so bright sources can leave dipole residuals. The header value is
a detector median, so in DR1 both epochs usually report the same FWHM and no matching is applied.

## Uncertainty

Per-pixel σ_D = √(var_A + var_B) after the same operations. Bilinear resampling smooths noise and correlates
neighbouring pixels, so the propagated variance does not describe the resampled noise exactly. The pipeline
therefore rescales σ_D by the robust width (1.4826 × MAD) of D/σ_D over usable, non-source pixels, clipped to
[0.5, 5], and records the factor (`noise_rescale_factor`; 0.80–1.18 on real M31 pairs). Aperture sums still
ignore pixel-to-pixel covariance, so aperture uncertainties are approximate.

## Detection

Positive and negative changes are segmented separately on the significance map with a 5σ threshold and at least
2 connected pixels (photutils). For each segment, the pipeline reports:

- centroid, RA/Dec and npix
- peak significance
- difference flux in a circular aperture of radius 1.5 × FWHM (µJy, from MJy/sr × pixel solid angle)
- epoch A and B aperture fluxes after subtracting a local annulus median
- positional uncertainty: FWHM/(2.355 · S/N) added in quadrature to a 1″ astrometric floor
- wavelength of each epoch at the position.

## Artifact rejection

Hard pixel masks (archive flags): TRANSIENT, OVERFLOW, SUR_ERROR, NONFUNC, MISSING_DATA, HOT, COLD, NONLINEAR,
PERSIST, OUTLIER, GHOST, GHOST_FPA, GHOST_EXT, STREAK, BLOOM, SNOWBALL, HALO. CROSSTALK, DICHROIC and PHANMISS
are reported but not masked. CROSSTALK covers more than 60 % of pixels around bright extended sources such as
M31, so masking it would remove whole galaxies. SOURCE is informational.

Per-candidate checks:

| Check | Severity | Rule |
|---|---|---|
| `aperture_masking` | error | ≤ 30 % of the aperture masked |
| `spectral_consistency` | error | \|λ_A − λ_B\| ≤ 0.5 bandwidth at the position |
| `edge_distance` | warning | ≥ 1.5 FWHM from the nearest unusable pixel |
| `quality_flags_nearby` | warning | no hard or soft archive flag within aperture + 1 px in either epoch |
| `dipole` | warning | no opposite-sign detection with ≥ 0.3 × \|S\| within 2 FWHM |
| `bright_source_residual` | warning | not (epoch S/N ≥ 50 and fractional change < 10 %) |
| `extent` | warning | ≥ 3 pixels above threshold |

Comparison-level hard checks: same survey, same detector, same unit, positive baseline, ≥ 20 % jointly usable
pixels, registration residual ≤ 0.35 px, and per-epoch coverage and usable fractions.

## Ranking

The ranking is fully explainable and invents no probabilities or confidence scores. Candidates are ordered by:

1. Quality tier: A (all checks pass), B (warnings only), R (a hard check failed; kept for audit, hidden by default).
2. |Peak significance|, descending.

Every candidate stores a plain-language explanation of its rank.

## Machine classes (rules, not identifications)

| Class | Rule |
|---|---|
| `subtraction_residual` | `dipole` or `bright_source_residual` check failed |
| `new_source_candidate` | brightening; epoch A aperture S/N < 3 and epoch B ≥ 5 |
| `disappeared_source_candidate` | fading; epoch A S/N ≥ 5 and epoch B < 3 |
| `possible_moving_object_pair` | a new and a disappeared candidate in the same comparison separated by > 2 FWHM |
| `variable_candidate` | significant flux in both epochs (S/N ≥ 5) |
| `uncertain_change` | none of the above |

No class is a confirmed astrophysical identification. Verification status changes only through an explicit,
audited reviewer action. Community votes never change it.

## Tracking

Candidates from different comparisons are linked when their separation is ≤ n·√(σ₁² + σ₂²) (default n = 3).
Linked groups of two or more are labelled `stationary_repeated`. Unlinked brightening detections at three or more
distinct epochs that fit constant velocity within the summed uncertainty, and that moved by more than the
uncertainty, are labelled `potential_moving_object`. Everything else is `single_detection`. An association means
the measurements are consistent, not that the detections are the same physical object.

## Forced photometry

The same aperture and annulus as detection are applied at a fixed position in every exposure of the detector
whose wavelength at the target is within 0.5 bandwidth of the candidate's. Exposures at other wavelengths are
listed but not measured.

## Validation status

The algorithms are tested with synthetic images that have known answers: injection and recovery, null scenes,
misregistration, spectral mismatch, flagged and unflagged hot pixels, PSF mismatch and determinism. They are
also tested on real DR1 data: registration residual, noise calibration, and recovery of a synthetic source
injected into a real epoch. These tests check the implementation. They do not validate the pipeline's
completeness, purity or photometric accuracy for SPHEREx science, which would require a large injection campaign
and comparison with independent catalogues.
