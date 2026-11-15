# Product expansion V2 — audit and plan

Audit date: 2026-11-14. Basis: `main` at `57b89d2` (PRs #1 and #2 merged), the local database, the running
application and the test suites. Work continues on the branch `feat/sky-time-machine-mvp`.

## 1. Existing capabilities (verified)

| Capability | Evidence |
|---|---|
| SPHEREx DR1 discovery (SIA2), header reads via HTTP Range, IBE cutouts with retries | `stm/adapters/spherex.py`; live tests pass when IRSA is up |
| FITS/WCS validation, per-pixel wavelength (WCS-WAVE, matches wcslib) | `science/fitsio.py`, `test_fitsio.py` |
| Registration with residual-shift check | `science/registration.py`; 0.002 px on real M31 pairs |
| Spectrally matched differencing, ZODI, background plane, uncertainty + noise rescale | `science/difference.py` |
| EPSF cross-convolution PSF matching, orientation checked, interpolation blur modelled (pipeline 0.2.0) | `science/psf.py`; 46 backend tests |
| Detection, artifact checks, tiered explainable ranking, machine classes | `detection.py`, `artifacts.py`, `ranking.py` |
| Tracking (positional association, linear-motion linking) | `science/tracking.py` |
| Forced photometry at a candidate (cutout-based, matched epochs only) | `science/photometry.py`, `/api/candidates/{id}/photometry` |
| Explore (Aladin, IRSA HiPS incl. DR1 cube, footprints, SIMBAD), Timeline, Compare (blink/side/diff), Discoveries list, `/discovery/[id]`, Tracking, assistant (rule-based + Claude), Community | `frontend/src/app/*`; 10 frontend tests |
| Provenance, deterministic comparison ids, FITS export of layers | `pipeline.py` |

Gaps found in the audit:

- **Discoveries:** filtering is minimal. There is no pagination, ID search, date sort or quality filter.
- **Spectra:** there is no spectral view. Forced photometry needs a 4 MB cutout per epoch.
- **Catalogues:** there is no catalogue cross-matching beyond the SIMBAD overlay in Aladin.
- **Light curves:** they exist only inside the candidate page, with no statistics or export.
- **Persistence:** there are no investigations, watchlists or reports.
- **Migrations:** the schema is created with `create_all` and cannot evolve.
- **Header walker:** `iter_remote_headers` treats HTTP 416 at end of file as an error.
- **Data volume:** the local database holds 1 real comparison and 2 candidates, so the Discoveries feed must
  handle small numbers honestly.

## 2. Missing capabilities (this expansion)

Discovery feed · Spectral explorer · Known-object cross-matching · Multi-epoch light curves with statistics ·
Investigation workspace · Sky layers (constellation boundaries/lines, galaxies, nebulae, saved candidates,
coverage) · Coverage heatmap · Advanced candidate inspection · Context-rich assistant with citations ·
Watchlists with new-observation checks · CSV and report exports · Navigation update.

## 3. Architecture changes

### Spectral data sources (both real, both labelled)

1. **IRSA DR1 all-sky spectral cube** (`spherex_dr1_cube`, HEALPix order-5 tiles, 512 × 512 × 102).
   - HDUs: `IMAGE` (MJy/sr), `NHITS` (count), `FLAGS`, `SPECTRAL_CHANNELS` (official 102-channel table:
     detector, sub-channel, λ, λmin/λmax, R, bandwidth), `WCS-WAVE`.
   - The cube is a time-averaged coadd (MJD-BEG/END in the header). It has **no uncertainty plane**.
   - We read only the pixels at the position: three rows per channel per HDU, via HTTP Range.
   - Plotted quantity: *archive coadded surface brightness*, labelled as an IRSA derived product. No error bars
     are drawn. Hit counts are shown instead.
   - Channels listed in `BLANKCH` are marked missing.
2. **Per-exposure spectrophotometry** (computed by Sky Time Machine) from Level 2 images.
   - Every exposure covering the position samples one wavelength. For each, we read a 17-row stamp of IMAGE,
     FLAGS and VARIANCE by HTTP Range (preferring the public AWS mirror, falling back to IRSA).
   - Forced aperture photometry: r = 1.5 FWHM, annulus background, VARIANCE-based errors, flag screening.
   - Each sample is assigned to the official channel whose λmin–λmax contains its wavelength.
   - Optionally, an EPSF aperture correction for point sources (the EPSF is cached once per detector and
     pipeline version).
   - Plotted quantity: *measured aperture flux density (µJy)*, plus *derived aperture-corrected point-source
     flux density*.

Light curves are the same per-exposure samples grouped **by channel** (same detector and wavelength range), so
only comparable measurements are compared in time.

### Catalogues

The `stm.catalogs` service queries CDS TAP services:
- SIMBAD (`basic`: identifiers, object types, coordinate errors, bibcodes)
- VizieR, for Gaia DR3 (`I/355/gaiadr3`) and 2MASS PSC (`II/246/out`).

Responses are cached in object storage (7-day TTL) and every query is stored with provenance. Outages give an
`inconclusive` status, never a silent "no match".

Association classes:

| Class | Rule |
|---|---|
| `confirmed_positional` | Exactly one counterpart within 3σ (combined positional σ), and the chance-coincidence expectation from local source density is < 0.05 |
| `possible` | Counterpart(s) within 3σ, but several, or chance expectation ≥ 0.05 |
| `inconclusive` | Counterparts only within the search radius but beyond 3σ, or a catalogue service failed |
| `none` | No counterpart within the search radius and every queried service answered |

"Confirmed positional" means positions agree. It never means physical identity.

### Sky layers

- **Constellation boundaries:** IAU boundaries from CDS VizieR `VI/49` via TAP.
- **Constellation figures:** d3-celestial `constellations.lines.json` (BSD-3), fetched by the backend, cached
  and labelled as cultural figures.
- **Galaxies and nebulae:** SIMBAD object types `G..`, `PN`, `HII`, `RNe`, `GNe`, `SNR`, `MoC`.
- **Saved candidates:** from investigations and watchlists.
- **Coverage:** existing footprints, plus the heatmap.

### Coverage heatmap

For a field we fetch exposure headers once (cached) and evaluate on a grid of cells:
- number of images (product × detector)
- number of distinct exposures
- number of independent epochs: exposures clustered within 0.5 day are one visit
- detectors present
- per detector, the number of spectrally matched pairs (|Δλ| ≤ 0.5 bandwidth, baseline ≥ 0.5 d), from each
  header's WCS and the wavelength lookup.

Images are never counted as epochs.

### Persistence and migrations

- **Migrations:** Alembic (`backend/migrations`). Revision `0001` is the existing schema and `0002` adds the
  new tables. Existing SQLite databases created by `create_all` are stamped at `0001` automatically, then
  upgraded.
- **Investigations and watchlists:** rows in the database, shared by URL (`/investigations/INV-…`). There are
  no user accounts yet; ownership is a display name.
- **Historical comparisons:** never overwritten. Comparison ids include the pipeline version, so 0.1.0 results
  stay readable next to 0.2.0 ones.

## 4. New database models (migration 0002)

- `photometry_runs` — `id` (SPX-…), position, parameters, status, provenance, created_at
- `photometry_points` — run_id, product_id, obs_id, detector, channel, t_mid, λ, bandwidth, flux, error,
  aperture-corrected flux, masked fraction, flags, quality, access URL
- `catalog_queries` — key, catalogue, position, radius, status, rows (JSON), queried_at, service URL
- `counterpart_assessments` — candidate_id, radius, association class, summary JSON, catalogue query ids, created_at
- `investigations` — id (INV-…), title, description, owner, region, notes, references JSON, created/updated
- `investigation_items` — investigation_id, kind (candidate | comparison | region | spectrum | observation |
  reference), ref_id, payload, note, added_at
- `watchlist_entries` — id (WL-…), kind (region | candidate | investigation), label, params, known_products
  snapshot, last_checked_at, last_new_count
- `watch_checks` — entry_id, checked_at, n_products, new_product_ids, status, message

## 5. New API endpoints

| Area | Endpoints |
|---|---|
| Discovery feed | `GET /api/discoveries?sort=significance\|date&order&q&machine_class&tier&min_snr&ra&dec&radius&verification&page&page_size` |
| Spectra | `GET /api/spectra/channels`, `GET /api/spectra/cube?ra&dec`, `POST /api/spectra/runs`, `GET /api/spectra/runs/{id}`, `GET /api/spectra/runs?ra&dec`, `GET /api/spectra/runs/{id}.csv` |
| Light curves | `GET /api/lightcurves/{run_id}?channel=` (stats + points), `GET /api/lightcurves/{run_id}.csv?channel=` |
| Catalogues | `GET /api/candidates/{id}/counterparts?radius_arcsec=`, `GET /api/catalog/objects?ra&dec&radius&kind=galaxy\|nebula`, `GET /api/catalog/constellations` |
| Coverage | `GET /api/coverage?ra&dec&size&cells` (job-backed when headers are not cached) |
| Investigations | `GET/POST /api/investigations`, `GET/PATCH/DELETE /api/investigations/{id}`, `POST/DELETE /api/investigations/{id}/items`, `GET /api/investigations/{id}/export.{json,md}`, `GET /api/investigations/{id}/report.html` |
| Watchlists | `GET/POST /api/watchlists`, `DELETE /api/watchlists/{id}`, `POST /api/watchlists/{id}/check`, `GET /api/watchlists/{id}/checks` |
| Exports | `GET /api/export/candidates.csv`, `GET /api/comparisons/{id}/references.csv` |
| Assessment | `GET /api/candidates/{id}/assessment` (structured, explainable; no LLM) |

## 6. Milestones

1. Adapter: Range stamps, cube reader, 416-as-EOF fix; spectrophotometry and light-curve science; Alembic.
2. Catalogue service and cross-matching; sky layers; coverage heatmap.
3. Investigations, watchlists, exports, report, discovery feed, assessment endpoint, assistant context.
4. Frontend: navigation, Discoveries feed, Spectra, Investigations, Watchlists, Explore layers, coverage
   heatmap, advanced candidate page.
5. Tests (synthetic algorithm tests plus live-archive tests), documentation, real-data verification.

## 7. Testing requirements

- **Light-curve statistics** — weighted mean and χ² against analytic values; no variability flag for
  heteroscedastic noise; a significant flag for injected variability. Synthetic data.
- **Channel assignment** — against the real `SPECTRAL_CHANNELS` table (fixture extracted from IRSA).
- **Range-stamp photometry** — must equal cutout photometry on the same real exposure. Network test.
- **Cube spectrum** — real tile and position; 102 channels; blank channels marked. Network test.
- **Cross-match classification** — synthetic counterpart sets for every class; outage gives `inconclusive`.
  The live SIMBAD query is a network test.
- **Coverage** — epoch clustering must not count images as epochs; matched-pair counting.
- **Investigations and watchlists** — CRUD, items, exports, report contains no "confirmed discovery" wording,
  new-observation detection against a stored snapshot.
- **Migrations** — a fresh DB upgrades to head; a legacy `create_all` DB is stamped and upgraded.
- **Frontend** — feed filters, pagination and URL state; spectrum chart rendering (error bars only where
  uncertainties exist); light-curve stats display; investigation editor; navigation.

## 8. Implementation status (end of this iteration)

| Part | Status |
|---|---|
| 1 Audit and plan | This document |
| 2 Discovery feed | Implemented: `/api/discoveries`, rebuilt Discoveries page, honest empty states |
| 3 Spectral explorer | Implemented: cube spectrum, per-exposure spectrophotometry, channel table, observation (visit) selector, missing/invalid lists, provenance panel |
| 4 Cross-matching | Implemented: SIMBAD + Gaia DR3 with mirrors, association classes, Known Counterparts panel |
| 5 Light curves | Implemented: per-channel statistics, cadence gaps, excluded points, systematics warnings, CSV |
| 6 Investigations | Implemented: persistent workspace, items with snapshots, notes, references, share URL, exports, report |
| 7 Sky layers | Implemented: IAU boundaries, figures, galaxies, nebulae, saved candidates, coverage cells, footprints |
| 8 Coverage heatmap | Implemented: images / exposures / visits / detectors / matched pairs; real large-field maps were blocked by IRSA SIA 502s during development |
| 9 Advanced inspection | Implemented: assessment, PSF panel, counterparts, spectral/historical measurements, processing history, data-kind legend |
| 10 Sky Intelligence | Implemented: spectra, light curves, counterparts, investigations, similar candidates; citations on every answer |
| 11 Watchlists | Implemented: baseline + new-release checks, history, optional background interval |
| 12 Export and reports | Implemented: candidates CSV, observation references CSV, spectra/light-curve CSV, investigation JSON/MD/HTML report; FITS layers (V1) |
| 13 Design | New navigation; validated categorical palette; shared chart component |
| 14 Engineering | Alembic migrations, caching, mirrors, outage handling, pipeline-version-aware records |
