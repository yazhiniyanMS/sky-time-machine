# Contributing

## Ground rules

1. **Scientific integrity first.** Never fabricate observations, metadata, detections or confidence values.
   Synthetic data belong only in tests; label them (`SYNTHET = T`, `SYNTHETIC-` ids).
2. **Explainable outputs.** New measurements, checks or ranking rules must be documented in
   `docs/SCIENTIFIC_METHODOLOGY.md` and stored with the candidate.
3. **Reproducibility.** Any change that can alter numerical results bumps `PIPELINE_VERSION` in
   `backend/stm/__init__.py`.
4. **No secrets in Git.** Use `.env` (ignored) and `.env.example` for documentation.

## Workflow

- Branch from `main` (`feat/...`, `fix/...`) and open a pull request. Do not push to `main` directly.
- Keep commits focused, with a descriptive message.
- Before opening a PR:

```bash
cd backend && ../.venv/bin/pytest && ../.venv/bin/ruff check stm tests && ../.venv/bin/mypy stm
cd frontend && npm test && npm run lint && npm run typecheck && npm run build
```

- Run `pytest -m network` when touching the adapter or pipeline. It needs IRSA access.

## Adding a survey

Implement `stm.adapters.base.SurveyAdapter` and a reader returning `stm.science.fitsio.ImageProduct` (image,
variance, flags with named bits, celestial WCS, mid-exposure time; optional per-pixel wavelength). Add fixtures
and tests, and document the data source in `docs/DATA_SOURCES.md`.

## Code style

- Python: ruff (lint and format, line length 120), mypy.
- TypeScript: ESLint (Next.js config), strict `tsc`.
- UI: use the tokens in `frontend/src/app/globals.css`. Label original and derived products.
