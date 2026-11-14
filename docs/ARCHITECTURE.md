# Architecture

```
 Browser (Next.js 15, React 19, TypeScript, Tailwind)
 ├─ Explore      Aladin Lite 3.8.2 (CDN, pinned) + IRSA HiPS, footprints, SIMBAD, candidates
 ├─ Timeline     SVG coverage strip, spectral table, matched pairs
 ├─ Compare      Canvas renderer (client-side stretch/colormap), blink / side / difference
 ├─ Discoveries  ranked list, /discovery/[id] permalink, forced-photometry light curve
 ├─ Tracking · Sky Intelligence · Community
 │        │  REST/JSON + raw float32 layers
 ▼        ▼
 FastAPI (stm.main)  ── routers: observations · comparisons · candidates · community · assistant
   │
   ├─ stm.adapters      SurveyAdapter ABC → SpherexAdapter (SIA2, HTTP Range headers, IBE cutouts, retries)
   ├─ stm.science       fitsio · registration · difference · detection · artifacts · ranking · tracking · photometry
   ├─ stm.pipeline      orchestration, provenance, product storage, comparison ids
   ├─ stm.jobs          thread-pool job runner with persisted job rows
   ├─ stm.assistant     grounded context builder + providers (Anthropic, rule-based)
   ├─ stm.db            SQLAlchemy 2 models (SQLite default; any SQLAlchemy URL)
   └─ stm.storage       ObjectStorage ABC → LocalStorage (FITS cache, derived .npz products)
        │
        ▼
 NASA/IPAC IRSA (SIA2, IBE files + cutouts) · CDS Sesame
```

## Responsibilities

| Concern | Module |
|---|---|
| Archive ingestion | `stm/adapters/spherex.py` |
| Preprocessing / validation | `stm/science/fitsio.py` |
| Registration | `stm/science/registration.py` |
| Difference analysis | `stm/science/difference.py` |
| Candidate detection | `stm/science/detection.py` |
| Artifact rejection | `stm/science/artifacts.py` |
| Ranking and machine classes | `stm/science/ranking.py` |
| Tracking | `stm/science/tracking.py` |
| Forced photometry | `stm/science/photometry.py` |
| AI assistant | `stm/assistant/` |
| Community | `stm/api/community.py`, `Annotation` and `AuditEvent` tables |

## Design decisions

- **Single backend service.** One FastAPI process serves the API and runs background jobs. There are no
  microservices.
- **Lightweight jobs instead of Celery.** Comparisons and photometry are I/O bound (archive downloads) and take
  seconds to a minute. A two-worker thread pool with job rows in the database keeps local development free of
  Redis. Jobs interrupted by a restart are marked failed. The `jobs.submit` interface is where a Celery or RQ
  backend would plug in.
- **SQLite by default, PostgreSQL-ready.** Models use portable SQLAlchemy types. `STM_DATABASE_URL` accepts
  PostgreSQL (install the `postgres` extra). Spatial queries use RA/Dec bounding boxes refined with exact
  great-circle distances in Python, which is adequate for thousands of candidates. PostGIS or a HEALPix index is
  the upgrade path. PostgreSQL has not been exercised in tests.
- **Object storage abstraction.** All FITS and derived products go through `ObjectStorage`; only the local
  filesystem backend exists.
- **Survey extensibility.** Everything downstream of the adapter consumes `ImageProduct`. Adding a survey needs
  a `SurveyAdapter` and a reader that returns `ImageProduct` with flags, variance and WCS.
- **Client-side rendering of float data.** The API serves float32 arrays (`/layers/{name}`). The browser applies
  the stretch and colour map, so display changes never alter or re-request data, and hover readouts show stored
  values.
- **Deterministic comparison ids.** `CMP-…` is a hash of position, size, inputs, configuration and pipeline
  version. Identical requests reuse stored results, and any change produces a new id.
- **Candidate permalinks.** `ST-<year>-<sequence>` ids are stable database identifiers, and URLs encode the full
  view state (`ra, dec, fov, det, size, a, b, mode, cand, cmp`).
