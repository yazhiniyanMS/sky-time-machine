# Known limitations

## Scientific

- **Unvalidated detection performance.** Unit tests and a real-data injection test check the implementation.
  Completeness, false-positive rate and photometric accuracy for SPHEREx have not been measured. Treat every
  candidate as a lead for expert follow-up.
- **Wavelength matching limits the usable pairs.** Because of the linear-variable filters, most pairs of epochs
  observe a position at different wavelengths. Only pairs within half a bandwidth are compared. At M31,
  detector 1 had 26 such pairs among 38 exposures.
- **PSF matching is per field, not per source.** The EPSF is evaluated at the field centre. Zones are about
  97 px (0.17°) apart and change slowly, but within a 0.25° field the PSF does vary somewhat. The
  interpolation blur is modelled by its field-average value, so very bright stars (S/N ≳ 300) can still leave
  residuals of a few percent of their peak. These are flagged by the dipole and bright-source checks. Fitting
  real stars shows the archive EPSFs are imperfect models (reduced χ² of a few hundred on bright stars).
- **Cross-convolution costs resolution.** The matched FWHM is about √2 larger than either epoch's (≈ 14″ vs
  8.8″), which lowers point-source sensitivity in exchange for robustness.
- **Correlated noise.** Bilinear resampling correlates pixels. Per-pixel σ is rescaled empirically, but aperture
  uncertainties ignore covariance.
- **Epoch fluxes in extended emission.** Epoch A/B aperture fluxes subtract a local annulus median. Inside
  galaxies or nebulae that median is biased, and epoch fluxes can be strongly negative (e.g. −4550 µJy on the
  M31 disk). Difference fluxes are not affected in the same way, because the background plane is fitted to the
  difference image.
- **Machine classes are simple rules.** For example, `variable_candidate` can be triggered by diffuse galaxy
  light. No classification uses spectral shape, catalogue cross-matching or proper motion priors.
- **Moving objects.** Linking needs at least three single detections at distinct epochs from stored comparisons.
  No ephemeris (e.g. JPL Horizons / MPC) cross-check is performed yet.
- **Header-based wavelength estimates.** The timeline's per-exposure wavelength uses the detector lookup table
  cached per L2 pipeline version. Comparisons always recompute it from each cutout's own table.
- **Cutout size.** Comparisons are limited to ≤ 0.25° fields (cutouts ≤ 0.3°).

## Engineering

- **Moderation is token-based.** A single shared token gates moderation and verification; there are no user
  accounts. Community author names are self-reported.
- **No Celery or PostGIS.** A thread-pool runner and SQLite are used by default (see ARCHITECTURE). PostgreSQL is
  supported through SQLAlchemy but untested.
- **Local storage only.** S3/GCS backends and the IRSA AWS mirror are not implemented.
- **No browser end-to-end tests.** Frontend tests are Vitest unit and component tests. The full UI flow was
  exercised manually in a browser against live data while developing.
- **External viewers.** Aladin Lite loads from jsDelivr and HiPS tiles come from IRSA, so the explorer map needs
  that network access. The SPHEREx cube channel slider calls Aladin's slice API when it exists; channel
  switching was not verified.
- **No constellation figures.** Constellations are reported by name for the map centre (IAU boundaries via
  astropy); figure lines are not drawn.
- **LLM path not exercised.** The Anthropic provider is implemented and type-checked but was not called during
  development because no API key was configured. The rule-based mode is tested.
