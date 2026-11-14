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

## Assistant

| Method | Path | Description |
|---|---|---|
| GET | `/api/assistant/status` | `{provider, model, llm_enabled}` |
| POST | `/api/assistant/chat` | `{question, history[], context: {ra, dec, candidate_id, comparison_id, ...}}` → `{answer, mode, model, grounding}` |

Without `ANTHROPIC_API_KEY`, the assistant runs in rule-based mode and reports stored measurements only.
