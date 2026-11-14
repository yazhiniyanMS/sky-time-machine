# Development

## Prerequisites (macOS)

- Python 3.12 (`brew install python@3.12`); 3.11+ supported
- Node.js 20+ (tested with 26) and npm
- Network access to `irsa.ipac.caltech.edu`, `cdn.jsdelivr.net` (Aladin Lite) and `fonts.googleapis.com`
  (build-time fonts)

No database server, Docker, Redis or GPU is required.

## Setup

```bash
python3.12 -m venv .venv
.venv/bin/pip install -e "backend[dev]"      # add [postgres] for PostgreSQL
(cd frontend && npm install)
cp .env.example .env
```

## Run

```bash
cd backend && ../.venv/bin/uvicorn stm.main:app --reload --port 8000
cd frontend && npm run dev   # NEXT_PUBLIC_API_URL defaults to http://localhost:8000
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `STM_DATA_DIR` | `./data` | Cache for SIA responses, headers, cutouts, derived products, SQLite DB |
| `STM_DATABASE_URL` | SQLite in data dir | Any SQLAlchemy URL |
| `STM_SPHEREX_COLLECTION` | `spherex_dr1` | SIA2 collection |
| `STM_HTTP_RETRIES` / `STM_HTTP_TIMEOUT_S` | 3 / 120 | Archive retry policy |
| `ANTHROPIC_API_KEY` | — | Enables LLM answers (server-side only) |
| `STM_ASSISTANT_PROVIDER` | `auto` | `auto`, `anthropic` or `none` |
| `STM_ASSISTANT_MODEL` | `claude-opus-5-5` | Model id |
| `STM_MODERATOR_TOKEN` | — | Enables moderation and reviewer verification |
| `STM_CORS_ORIGINS` | `http://localhost:3000,...` | Allowed browser origins |
| `STM_PREFER_CLOUD_MIRROR` | `true` | Byte-range reads from the AWS mirror first |
| `STM_RANGE_WORKERS` | 12 | Parallel byte-range requests |
| `STM_WATCH_INTERVAL_HOURS` | 0 (off) | Background watchlist re-checks |
| `NEXT_PUBLIC_API_URL` | `http://localhost:8000` | Frontend → API base URL |

Never commit `.env`. The data directory is git-ignored.

## Data ingestion

There is no bulk ingestion step: data are fetched on demand and cached.

- `GET /api/observations` queries SIA2.
- `GET /api/observations/spectral` reads headers with HTTP Range.
- `POST /api/comparisons` downloads two cutouts (about 4 MB each, dominated by the EPSF extension).
- Forced photometry downloads one cutout per measured epoch.

To pre-warm a region, call these endpoints or `stm.pipeline.run_comparison` from a script.

## Database migrations

The schema is managed by Alembic (`backend/migrations`) and upgraded automatically at startup. An existing v0.1
or v0.2 SQLite database is stamped at revision 0001 and then upgraded; no rows are changed. Back up
`data/stm.sqlite` before upgrading if you want to be able to roll back.

## Tests and checks

```bash
cd backend
../.venv/bin/pytest                    # 66 offline tests
../.venv/bin/pytest -m network         # 8 live-archive tests
../.venv/bin/ruff check stm tests && ../.venv/bin/ruff format --check stm tests && ../.venv/bin/mypy stm

cd frontend
npm test && npm run lint && npm run typecheck && npm run build
```

Do not run `next build` while `next dev` is running from the same directory: both use `.next/`.
