# Contributing

Thanks for helping. The product is the browser app in `web/`; the Python package in `src/gts/` is the
reference implementation it is tested against, plus a few command‑line tools.

## Setup

Web app (Node 22 or newer):

```sh
cd web
npm ci
npm run dev                  # http://localhost:5173
```

Python reference (3.11 or newer, in a virtual environment):

```sh
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt ruff
```

## Running the tests

| What | Command | Notes |
|---|---|---|
| Web unit tests | `cd web && npm test` | The model tests download IS‑Net (~88 MB) once to `web/.cache/` and skip when offline |
| Type check | `cd web && npm run typecheck` | `tsc --noEmit`, strict mode |
| Build | `cd web && npm run build` | No file in `web/dist` may exceed 25 MiB (the Cloudflare Pages limit) |
| End‑to‑end | `cd web && npm run e2e` | Builds, serves with `vite preview` on port 4175 and drives headless Chrome. Uses the system Google Chrome; set `CHROME_PATH`, or `PW_BUNDLED_CHROMIUM=1` after `npx playwright install chromium`. The upload test needs `web/.cache/model_fp16.onnx` (run `npm test` first) and skips without it |
| Python tests | `python -m pytest -q` | No model download needed |
| Python lint | `python -m ruff check src tests scripts` | |

CI (`.github/workflows/ci.yml`) runs all of these on every push to `main` and every pull request. It caches
`web/.cache` keyed on `web/src/vision/model.ts`, so the model is downloaded from Hugging Face only when that
file changes; if the download fails, the model tests and the upload end‑to‑end test skip. There is no deploy
job: deploys to Cloudflare Pages are manual.

Local `vite dev` and `vite preview` send no cross‑origin isolation (COOP/COEP) headers, so onnxruntime runs
single‑threaded. That is expected; the production headers are set at deploy time.

## Regenerating fixtures and presets

Both scripts are deterministic, so a second run gives no diff.

- **Parity fixtures** (`tests/fixtures/`), after any change to the reference in `src/gts/`:
  `python -I scripts/make_fixtures.py && git status --short tests/fixtures`.
  The fields are documented in [tests/fixtures/README.md](tests/fixtures/README.md).
- **Web presets and sheets** (`web/public/presets/`, `web/public/sheet/`), after changing `src/gts/`,
  `assets/presets/` or `assets/sheet/`: `python -I scripts/build_presets.py`.
- **Calibration sheet** (`assets/sheet/`, tracked): `python -I src/sheetgen.py letter` and `a4`, then
  `scripts/build_presets.py`. The marker layout is shared by every photo and preset, so changing it
  invalidates them.

## Parity expectations

The browser port must match the Python reference on the fixtures: marker corners, homography, outlines,
symmetry, pocket, footprint and bin metrics, within the tolerances in the web tests (mostly 2 to 4
decimals in mm). If you change behavior, change it in `src/gts/` first, regenerate the fixtures, then update
the TypeScript until the parity tests pass. Don't loosen a tolerance to make a test pass without saying why
in the pull request.

## Code style

- TypeScript: `strict` (see `web/tsconfig.json`); `npm run typecheck` must be clean. No new runtime
  dependencies without a note in [NOTICE](NOTICE).
- Python: `ruff` with the `F` rules (`pyproject.toml`); open text files with `encoding="utf-8"`.
- Keep the UI consistent with [docs/design-spec.md](docs/design-spec.md).
- Write user‑facing text and docs in sentence case.
- Photos never leave the device: don't add network requests that send user data, analytics or trackers.
  New third‑party fetches must be listed in [web/privacy.html](web/privacy.html).

## Pull request checklist

- [ ] `npm test`, `npm run typecheck`, `npm run build` and `npm run e2e` pass in `web/`
- [ ] `python -m pytest -q` and `python -m ruff check src tests scripts` pass
- [ ] Fixtures and presets regenerated if the reference or assets changed, with no unexpected diff
- [ ] README, NOTICE and the privacy page updated if behavior, dependencies or network use changed
- [ ] Screenshots for visible UI changes
