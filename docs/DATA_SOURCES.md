# Data sources

## SPHEREx at NASA/IPAC IRSA

| Item | Value (verified against the live archive, November 2026) |
|---|---|
| Mission | SPHEREx: 0.75–5 µm all-sky spectral survey, launched March 2025 |
| Archive | NASA/IPAC Infrared Science Archive — <https://irsa.ipac.caltech.edu/Missions/spherex.html> |
| Documentation | <https://caltech-ipac.github.io/spherex-archive-documentation/> |
| Product used | Level 2 Spectral Images, Data Release 1 (`spherex_dr1`, wide survey) |
| Discovery | IVOA SIA v2: `https://irsa.ipac.caltech.edu/SIA?COLLECTION=spherex_dr1&POS=circle RA DEC R&RESPONSEFORMAT=VOTABLE` |
| Files | `https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/<period>/l2b-v<ver>-<date>/<det>/level2_<obsid>D<det>_spx_l2b-v<ver>-<date>.fits` |
| Cutouts | IBE cutout service: append `?center=RA,DEC&size=DEG` to the file URL; all extensions preserved |
| Access | Public, no authentication. HTTP Range requests are supported (used to read headers only). |
| Cloud mirror | `s3://nasa-irsa-spherex/dr1/...` (us-east-1), listed in the SIA `cloud_access` column; not used yet |

### Level 2 product layout

| HDU | Content |
|---|---|
| `IMAGE` | Calibrated surface brightness, MJy/sr, 2040 × 2040, TAN-SIP celestial WCS; zodiacal light **not** subtracted |
| `FLAGS` | Per-pixel bitmask. Bit names/values are read from the file's own `MSKNnnnn` / `MSKMnnnn` keywords |
| `VARIANCE` | Variance of `IMAGE`, (MJy/sr)² |
| `ZODI` | Modelled zodiacal light, MJy/sr |
| `EPSF` / `PSF` | Empirical PSFs on a grid of detector zones (not used yet beyond the header `PSF_FWHM`) |
| `WCS-WAVE` | 9 × 9 lookup table of central wavelength and bandwidth versus raw detector position (`-TAB`, keyword set `W`) |

Observation time: `MJD-AVG` (mid-exposure, UTC); also `DATE-BEG/END`, `XPOSURE`. Detector: `DETECTOR` (1–6).

Bands (from IRSA): D1 0.75–1.09 µm (R≈39), D2 1.10–1.62 (41), D3 1.63–2.41 (41), D4 2.42–3.82 (35),
D5 3.83–4.41 (112), D6 4.42–5.00 (128).

### Flag bits observed in DR1 files

`TRANSIENT 0, OVERFLOW 1, SUR_ERROR 2, NONFUNC 6, DICHROIC 7, MISSING_DATA 9, HOT 10, COLD 11, FULLSAMPLE 12,
PHANMISS 14, NONLINEAR 15, PERSIST 17, OUTLIER 19, CROSSTALK 20, SOURCE 21, GHOST 22, GHOST_FPA 23,
GHOST_EXT 24, STREAK 25, BLOOM 26, SNOWBALL 27, HALO 28`. The application always prefers the definitions in
each file over this list.

### SPHEREx HiPS

IRSA publishes a DR1 all-sky spectral cube HiPS (`ivo://IPAC/P/SPHEREx/DR1/cube`, 102 channels) at
<https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube>. It is offered as a background layer in the
explorer for context only; no measurement uses HiPS pixels.

## Other services

| Service | Use |
|---|---|
| CDS Sesame (via `astropy.coordinates.SkyCoord.from_name`) | Object-name resolution |
| CDS SIMBAD (via Aladin Lite) | Optional catalogue overlay in the explorer |
| DSS2 colour and 2MASS colour HiPS, IRSA mirrors | Explorer backgrounds |
| Aladin Lite 3.8.2 (jsDelivr, pinned) | Sky viewer |

## Provenance kept for every comparison

Input product ids, archive access URLs, exact cutout URLs, cloud locations, selected header keywords
(`OBSID`, `EXPIDN`, times, `PSF_FWHM`, astrometry flags, `L1DQAFLG`, pipeline `VERSION`), the spectral-WCS
calibration file name, flag definitions, processing configuration, software versions, grid WCS and all quality
checks. See `provenance` in `GET /api/comparisons/{id}` and the `STM_*` keywords in FITS downloads.

## Test fixtures

`backend/tests/fixtures/` contains (1) a real DR1 cutout of M31 with the EPSF extension removed and (2) the first
12 rows of a real SIA response for M31. Synthetic images are generated at test time by
`backend/tests/synthetic.py`, carry `SYNTHET = T` and `SYNTHETIC-` product ids, and are reported as synthetic
in provenance.
