# API reference

Base URL: `http://localhost:8000`. Interactive OpenAPI docs: `/docs`. All bodies are JSON.

## Health and survey

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Status, version, pipeline version |
| GET | `/api/survey` | Survey/data-release description and bands |
| GET | `/api/resolve?name=M31` | CDS Sesame name resolution → `{ra, dec}` |
| GET | `/api/constellation?ra=&dec=` | IAU constellation containing the position |

## Observations

| Method | Path | Description |
|---|---|---|
| GET | `/api/observations?ra=&dec=&radius=0.01` | SPHEREx DR1 images covering the position, grouped by exposure; per-detector counts; coverage gaps > 5 d |
| GET | `/api/observations/spectral?ra=&dec=&detector=1` | Per exposure: estimated λ and bandwidth at the target, pixel position, edge distance, PSF FWHM; spectrally matched pairs |

## Comparisons

| Method | Path | Description |
|---|---|---|
| POST | `/api/comparisons` | `{ra, dec, size_deg (0.01–0.25), product_a, product_b}` → `{comparison_id, job_id, status}`. Existing results are reused. |
| GET | `/api/comparisons` | Recent comparisons |
| GET | `/api/comparisons/{id}` | Status, summary, provenance, ranked candidates |
| GET | `/api/comparisons/{id}/layers/{layer}` | Raw little-endian float32; headers `X-Shape: rows,cols`, `X-Layer-Kind: original\|derived`; NaN = masked |
| GET | `/api/comparisons/{id}/fits/{layer}` | FITS file with grid WCS and provenance keywords |
| GET | `/api/jobs/{job_id}` | `{status, progress, message, result}` |

Layers: `a, b, diff, sigma, significance, valid, dlambda_frac, wave_a, wave_b, bad_a, bad_b, source_a, source_b`.

## Candidates and tracking

| Method | Path | Description |
|---|---|---|
| GET | `/api/candidates?ra=&dec=&radius=&include_rejected=&machine_class=` | Ranked candidates with community counts |
| GET | `/api/candidates/{ST-id}` | Measurements, checks, explanation, comparison, tracks |
| POST | `/api/candidates/{ST-id}/photometry?max_epochs=12` | Starts a forced-photometry job across spectrally matched epochs |
| POST | `/api/candidates/{ST-id}/verification` | Reviewer only (`X-Moderator-Token`): `{status, reviewer, reason}`; audited |
| POST | `/api/tracks` | `{ra, dec, radius_deg, n_sigma, include_rejected}` → tracks with kind and metrics |
| GET | `/api/tracks?ra=&dec=&radius=` | Stored tracks |

Verification states: `unverified` (default), `under_review`, `confirmed_real`, `rejected_artifact`.

## Community

| Method | Path | Description |
|---|---|---|
| POST | `/api/annotations` | `{target_type, target_id, author, kind, body}`; kinds `interesting, not_interesting, artifact, flag, note`. Text containing links is held as `pending`. |
| GET | `/api/annotations?target_id=` | Visible annotations |
| GET | `/api/annotations/summary/{target_id}` | Counts per kind |
| POST | `/api/annotations/{id}/moderate` | Moderator only: `{action: hide\|restore\|approve, reason}` |
| GET | `/api/moderation/queue` | Moderator only: pending and hidden annotations |
| GET | `/api/audit?target_id=` | Audit history |

Moderator endpoints require the `X-Moderator-Token` header to match `STM_MODERATOR_TOKEN`. They are disabled when
that setting is empty.

## Discovery feed and exports

| Method | Path | Description |
|---|---|---|
| GET | `/api/discoveries?sort=significance\|snr\|date\|created&order&q&machine_class&tier=A,B,R&min_snr&verification&ra&dec&radius&page&page_size` | Paginated feed of stored candidates |
| GET | `/api/export/candidates.csv` | All candidates with measurements, quality, versions |
| GET | `/api/comparisons/{id}/references.csv` | Archive observation references |
| GET | `/api/candidates/{id}/assessment` | Structured rule-based explanation (detection, measurements, checks, uncertainties, PSF, history) |

## Spectra and light curves

| Method | Path | Description |
|---|---|---|
| GET | `/api/spectra/channels` | Official 102 channels |
| GET | `/api/spectra/cube?ra&dec` | Archive coadd spectrum at the nearest cube pixel |
| POST | `/api/spectra/runs` | `{ra, dec, detectors?, max_exposures?, candidate_id?, label?}` → job; per-exposure spectrophotometry |
| GET | `/api/spectra/runs?ra&dec&radius_arcsec` · `?candidate_id=` | Stored runs |
| GET | `/api/spectra/runs/{id}` · `/csv` | Run with all measurements (including masked/outside/error) |
| GET | `/api/lightcurves/{run_id}?channel=&quality=good\|warning\|any` · `/csv` | Channel light curve, statistics, systematics warnings |

## Catalogues, layers and coverage

| Method | Path | Description |
|---|---|---|
| GET | `/api/candidates/{id}/counterparts?radius_arcsec=15&refresh&cached_only` | SIMBAD + Gaia DR3 positional cross-match (stored) |
| GET | `/api/catalog/objects?ra&dec&radius&kind=galaxy\|nebula` | SIMBAD objects by type |
| GET | `/api/catalog/constellations` | Boundaries, figures, names |
| POST/GET | `/api/coverage` `{ra, dec, size_deg, cells, pass_only}` | Coverage map job / cached result |
| GET | `/api/saved/candidates` | Candidates referenced by investigations or watchlists |

## Investigations and watchlists

| Method | Path | Description |
|---|---|---|
| GET/POST | `/api/investigations` | List / create |
| GET/PATCH/DELETE | `/api/investigations/{id}` | Read / edit (title, description, region, notes, references) / delete |
| POST | `/api/investigations/{id}/items` | `{kind: candidate\|comparison\|spectrum\|region\|observation, ref_id, note}` (snapshot stored) |
| DELETE | `/api/investigations/{id}/items/{item_id}` | Remove an item |
| GET | `/api/investigations/{id}/export.json` · `export.md` · `report.html` | Exports and printable scientific report |
| GET/POST | `/api/watchlists` | List / create (region, candidate or investigation; first check records a baseline) |
| POST | `/api/watchlists/{id}/check` | Re-query the archive; lists newly released products |
| DELETE | `/api/watchlists/{id}` | Remove |

## Assistant

| Method | Path | Description |
|---|---|---|
| GET | `/api/assistant/status` | `{provider, model, llm_enabled}` |
| POST | `/api/assistant/chat` | `{question, history[], context: {ra, dec, candidate_id, comparison_id, ...}}` → `{answer, mode, model, grounding}` |

Context keys: `ra, dec, candidate_id, comparison_id, investigation_id, run_id`. Responses include
`grounding.citations` (candidate, comparison, archive observations with URLs, catalogue records, runs,
investigations, documents). The LLM is instructed to cite only these records. Without `ANTHROPIC_API_KEY`
the assistant runs in rule-based mode and reports stored measurements only.
