# CLAUDE.md

Guidance for AI assistants and contributors working in this repository. Keep it current: update it
whenever an architectural decision, command or convention changes.

## Project

BarreFree turns songs (an audio file, a pasted chord sheet, or optionally a YouTube/Spotify link)
into **barre-free acoustic guitar chords**: it suggests a capo, substitutes barre chords with the
closest open shapes, and shows diagrams synchronized with the music. The primary user is a guitarist
who cannot play barre chords.

- The owner chats in **Turkish**. Code, comments, commit messages, README and docs are in **English**.
- For every significant technical decision (library, algorithm, data model, performance change),
  explain to the owner in Turkish: why this option, the fine technical details, the alternatives
  with their pros and cons, and sources.
- Work milestone by milestone, and stop for approval after each one (see the table below).
- Never use a library API from memory without verifying it: read the docs or source, or write a
  small probe script first.

## Architecture (details in docs/architecture.md)

- `apps/web`: React 19 + Vite 8 SPA (PWA, i18n `tr`/`en`). All music theory runs client-side.
  `src/App.tsx` is the shell and route switch (`lib/router.ts`: History API +
  `useSyncExternalStore`); pages live in `src/pages/` (Home = upload + `TextMode`, Job = SSE
  progress, Song = player + chart, Library). `hooks/useArrangement.ts` wires the transform
  engine to the controls for both text mode and songs; `lib/arrangement.ts` applies preferred
  voicings and names chords; `lib/diagram.ts` converts voicings to svguitar (string 1 = high
  E); `lib/library.ts` is the IndexedDB song store (`idb`); `lib/api.ts` the analyzer client.
- `packages/theory`: pure, deterministic TypeScript transform engine (chord sheets, parse, transpose, capo
  search, voicing selection, difficulty modes, `timeline.ts`: timed chords → bars, sync lookups,
  text/ChordPro charts). No framework or I/O dependencies. Coverage ≥ 90%.
  Algorithms, formulas and the worked F example: docs/algorithms/transform-engine.md.
- `packages/contracts`: TS types **generated** from the analyzer's JSON Schema. Never edit
  `*.gen.ts` or `schema/*.json` by hand.
- `data/voicings`: chord-shape library (JSON + JSON Schema): `standard/curated.json` (hand-checked,
  wins on duplicates) and `standard/chords-db.json` (generated from tombatossals/chords-db, MIT,
  pinned commit; never edit by hand).
- `services/analyzer`: Python 3.12 + FastAPI + a SQLite-queue worker. It returns **raw analysis
  only** (beats, key, Harte chord labels, notes). It must never implement capo, transposition or
  voicing logic: those belong in `packages/theory`. `api.py` (jobs API + SSE), `jobs.py` (queue),
  `worker.py`, `audio.py` (ffmpeg), `pipeline/` (one interface per step: beats, chords, key,
  separation, notes; `postprocess.py` is recognizer-independent; `btc.py` is a typed port of the
  BTC model; `separation.py` wraps Demucs), `synth.py` (synthetic songs with exact ground truth,
  plus a "busy" variant), `models.py` (weight URLs + SHA-256), `eval/evaluate.py` (mir_eval;
  `eval/report.md` is generated, its discussion is `eval/report-notes.md`).

Decisions already made, with their rationale in docs/architecture.md and docs/licenses.md:

- Vite SPA rather than Next.js/SvelteKit.
- The backend returns raw analysis; theory runs client-side.
- SQLite job queue rather than Redis.
- Python 3.12 rather than 3.11.
- Licensing: MIT for everything except `services/analyzer`, which is GPL-3.0-or-later.
- Do not use: madmom (non-commercial model weights), Essentia (AGPL), chord-extractor,
  ChordSheetJS (GPL-2.0-only).

## Commands

```bash
# JS (repo root). pnpm comes from Corepack (version pinned in package.json).
corepack enable
pnpm install
pnpm dev                    # web on :5173, proxies /api to :8000
pnpm build && pnpm --filter @barrefree/web preview   # production build incl. service worker
pnpm lint                   # ESLint 10 flat config (type-aware, i18n literal-string rule)
pnpm format / format:check  # Prettier
pnpm typecheck              # tsc --noEmit for root *.ts and every package
pnpm test                   # Vitest 5 projects (apps/*, packages/*, data/*)
pnpm test:coverage          # coverage thresholds live in the root vitest.config.ts
pnpm gen:contracts          # regenerate packages/contracts/src/analysis.gen.ts from the schema
pnpm check                  # everything CI runs (JS + analyzer); run before every push
pnpm --filter @barrefree/theory import:chords-db /path/to/guitar.json  # regenerate the chord library

# Python (services/analyzer)
uv sync
uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest
uv run uvicorn barrefree_analyzer.app:create_app --factory --reload
uv run barrefree-worker
uv run barrefree-export-schema   # after changing schema.py; then run `pnpm gen:contracts`
scripts/build-vamp-plugins.sh    # Chordino plugin into .vamp/ (git, g++, make, libboost-dev)
uv run barrefree-download-models # model weights into local-data/models (SHA-256 checked)
uv run python eval/evaluate.py --synthetic   # chord/key scores on synthetic songs
uv run barrefree-benchmark --minutes 1,3,15 --out ../../docs/benchmarks.md   # time + memory per step

# Docker (one image: api + worker; deploy guide: docs/deploy-windows.md)
docker compose up -d --build
docker compose --profile tunnel up -d   # + Cloudflare Tunnel (CLOUDFLARE_TUNNEL_TOKEN in .env)
docker compose run --rm --no-deps worker barrefree-benchmark --minutes 3,15   # sizing, when idle
```

## Conventions and gotchas

- **Node version:** `^22.22.2 || ^24.15.0 || >=26` (jsdom 30 is the strictest dependency; pnpm 11
  needs ≥ 22.13, and `node scripts/*.ts` needs type stripping, which is on by default from 22.18).
- **Compose does not pass `.env` into containers** (no `env_file`): `.env` is only for
  interpolation, and analyzer settings are listed explicitly in the `x-env` anchor. This keeps
  secrets such as the tunnel token out of the processes that handle uploads. YAML merge (`<<`)
  is shallow: a service that sets `environment:` must merge `*env` itself. A new setting goes
  in `config.py`, `x-env` and `.env.example`.
- **Workers** have a `WORKER_ID` (compose: `worker-1`), made exclusive by a lock file in
  `DATA_DIR/workers/`: a second worker with the same id runs as `worker-1-2` (so
  `--scale worker=N` is safe). At start a worker fails the jobs it was running when it died (OOM,
  kill), instead of leaving them for `JOB_TIMEOUT_SEC`; job writes are guarded by `claimed_by`,
  so a failed job is never brought back. A failed analysis keeps no files (only its row). The API stops within 5 s (`--timeout-graceful-shutdown`); a stopping
  worker finishes its job within `stop_grace_period`.
- **Static files**: `SpaStaticFiles` sends `immutable` for Vite's hashed `/assets/*` and
  `no-cache` for everything else (index.html, sw.js, manifest), so a caching proxy such as
  Cloudflare never pins an old service worker.

- **Chord model:** `Chord = { root, intervals (12-bit set), bass }`; names (third, seventh,
  tensions) are derived by `describe()`. Never add a second representation of a chord.
- **Relative imports use `.ts` extensions** (`allowImportingTsExtensions`, `erasableSyntaxOnly`),
  so scripts run with plain `node file.ts` (Node's type stripping) and no build step.
- **GitHub Actions cannot run** (account billing lock). `pnpm check` is the quality gate until
  that is resolved; `.github/workflows/ci.yml` stays in place.
- **Fret arrays:** index 0 = low E (string 6), frets relative to the nut or capo, `null` = muted,
  `0` = open. svguitar and alphaTex number strings the other way (1 = high E); convert only at
  the rendering boundary.
- **Chord labels on the wire:** Harte syntax (`C:maj`, `A:min7`, `G:7/3`, `N`).
- **API JSON is camelCase.** Every Pydantic wire model extends `schema.CamelModel`.
- **TypeScript is pinned to `~6.0.3`** in the pnpm catalog: typescript-eslint 8.x does not support
  TS 7 yet. All shared versions live in the `catalog:` section of `pnpm-workspace.yaml`.
- **pnpm 11** keeps non-auth settings in `pnpm-workspace.yaml`. Its `minimumReleaseAge` (1 day)
  means same-day releases do not resolve; use caret ranges.
- **Vitest 5** uses `test.projects`; `workspace` files are gone. Coverage options are honored
  only in the root config.
- **UI strings** go in `apps/web/src/locales/{en,tr}.json` (same keys in both). A hardcoded JSX
  string is a lint error; symbols such as ‹ › − + live in constants. Machine values (`value`,
  `name` attributes) are exempt.
- **Chord sheets** (`packages/theory/src/sheet.ts`, details in docs/algorithms/transform-engine.md
  §6): a line is a chord line only if it has no ordinary words (one is tolerated next to ≥ 4
  chords); bars, wrapping parentheses, repeats and a leading section label are marks. Header
  fields (`Key:`, `Capo 2`) are `meta` lines, never chords. Rendering keeps every chord at or
  after its original column, keeps attached marks attached and never touches lyrics. A source
  capo is folded into the transposition. Example texts must use original lyrics only.
- **URL space:** the server answers only under `/api/` (FastAPI docs at `/api/docs`); every other
  path is the SPA, and the service worker's navigation denylist is `/^\/api\//`. App routes
  never contain a dot: a missing path with a dot or under `/assets/` is a 404, not index.html.
- **PWA**: `registerType: 'prompt'` (never reload under a player); the chord library is inside
  the precached JS bundle, so text mode works offline. Vitest aliases
  `virtual:pwa-register/react` to `src/test/pwa-register-stub.ts`.
- **Player.** wavesurfer.js v8 on a detached `<audio>` (`media` option, `preservesPitch`), so
  tests mock `components/Player`; real playback is checked in Chromium with Playwright, which
  has no AAC decoder (one reason the playback copy is MP3). Handlers that wavesurfer keeps for
  the instance's lifetime go through `useEffectEvent`; never assign refs during render.
- **Song library** (`lib/library.ts`, IndexedDB `barrefree` v1: `songs` + `audio` Blobs). Bump
  the version and migrate in `upgrade` when the record shape changes. `saveSong` only adds
  (a saved song may carry the user's fixes). Chord fixes are canonical Harte at the recording's
  pitch, typed and shown in the chart's frame (`lib/edits.ts`, `useArrangement().frame`).
  Tests use `fake-indexeddb/auto` (set up in `src/test/setup.ts`).
- **Third-party notices in the web build**: keep `build.license` and the legal comments
  (`rolldownOptions.output.comments.legal`) in `vite.config.ts`; a bundled dependency with
  conditions (MPL, OFL) is named in `public/third-party/NOTICE.txt`, linked from the footer.
  alphaTab and its font are runtime-cached on first use, not precached.
- **svguitar** needs SVG layout APIs that jsdom lacks; `ChordDiagram` swallows draw errors so
  component tests run, and real rendering is checked in Chromium with Playwright.
- **Python:** strict mypy, ruff (incl. bandit `S` rules), pytest. The JSON Schema drift test runs
  in pytest.
- **torch** must come from the CPU wheel index (`download.pytorch.org/whl/cpu`, configured in
  `[tool.uv.sources]`). Otherwise Linux pulls the CUDA wheels, which add several GB.
- **vamp** (PyPI) is sdist-only: `[tool.uv.extra-build-dependencies]` gives its build NumPy and
  setuptools; it needs g++. `VAMP_PATH` must be set before the first plugin call
  (`Settings.vamp_path`, `/opt/vamp` in Docker). Chordino emits major chords as a bare root
  (`C`, `C/3`); `chordino.to_harte` spells them `C:maj`.
- **Tab mode** (M7, experimental): notes from `pipeline/notes.py` (Basic Pitch on ONNX Runtime,
  ported because its package needs TensorFlow), tab assignment and MusicXML in
  `packages/theory/src/tab.ts` (string index 0 = low E, as in fret arrays; MusicXML string 1 =
  high E), drawn by alphaTab in `components/TabView.tsx` (lazy chunk, no workers, no player).
  Ported third-party code keeps its notice in `services/analyzer/NOTICE`.
- **Link import** (`urlimport.py`, M6) is off by default and optional (`uv sync --extra url`;
  the Docker image installs it). Never fetch a URL the user typed: parse it to an id with
  `parse_link` and rebuild the request on a fixed host. yt-dlp stays limited to its YouTube
  extractors. Tests use a fake `VideoSource` and never touch the network.
- **Model weights** are never committed or baked into images: `models.py` lists URL + SHA-256
  (pinned commits), the worker downloads missing ones on start. Loaders get their file only
  from `verified_model_path` (size + SHA-256). Never let a weights file choose code: Demucs is
  built by `load_htdemucs` (fixed class, JSON arguments, strict tensors; never
  `demucs.hf.load_safetensors_model`), BTC uses `torch.load(weights_only=True)` with an
  explicit `safe_globals` allow-list. Optional parts degrade (`pipeline/factory.py` leaves out
  what fails to load; `models.availability` drives health and job validation); only "no
  recognizer at all" refuses jobs. `uv.lock` resolves for Linux, Windows and Apple-silicon macOS
  only (`[tool.uv] environments`): torch has no Intel-macOS wheels. Tests that need the plugin or weights skip, except
  under `BARREFREE_REQUIRE_MODELS=1` (set by `pnpm check`), where they fail.
- **Job files** live in `jobs/<id>/`; remove them only with `jobfiles.remove_job_files`, which
  also deletes the job's cached stems (`stems.ref`). API tests build settings on a pretend
  installation (`tests/conftest.fake_install`: empty plugin file, sparse weights).
- **Analyzer tests use synthetic audio only** (`synth.py`, ffmpeg `lavfi` sine); the M3
  acceptance test runs the full pipeline on the synthetic songs (majmin ≥ 90 %).
- **Docker Hub** may rate-limit anonymous pulls. The Dockerfile takes `NODE_IMAGE` and
  `PYTHON_IMAGE` build args (e.g. `mirror.gcr.io/library/node:24-slim`).
- **Never commit** copyrighted audio, lyrics or tabs. Personal test data goes in `local-data/`
  (git-ignored).
- **Windows deploy target:** Docker Desktop is not supported on Windows Server. Use Docker Engine
  inside a WSL2 Ubuntu distro, keep volumes off `/mnt/c`, and use LF line endings
  (enforced via `.gitattributes`).

## Milestones

| #   | Scope                                                                                           | Status  |
| --- | ----------------------------------------------------------------------------------------------- | ------- |
| M0  | Monorepo skeleton, lint/format, Vitest + pytest, CI, Docker skeleton                            | ✅ done |
| M1  | `packages/theory` + `data/voicings`: parser, transpose, voicings, scoring, capo search, 4 modes | ✅ done |
| M2  | Web: text mode end to end, diagrams, mode/λ/capo UI, i18n, PWA                                  | ✅ done |
| M3  | Analyzer: upload → decode → beats → key → Chordino; job queue + SSE                             | ✅ done |
| M4  | Synced player, speed/A-B loop, confidence marks, manual edits, IndexedDB library                | ✅ done |
| M5  | BTC (+ lv-chordia) recognizers, Demucs, evaluation report                                       | ✅ done |
| M6  | URL import (YouTube + Spotify metadata → search → confirm), feature flag                        | ✅ done |
| M7  | Tab mode (basic-pitch ONNX + tab assignment + alphaTab)                                         | ✅ done |
| M8  | Docker deploy guide (Windows Server/WSL2), Cloudflare Tunnel, benchmarks                        | ✅ done |
