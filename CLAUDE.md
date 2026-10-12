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
- `packages/theory`: pure, deterministic TypeScript transform engine (parse, transpose, capo
  search, voicing selection, difficulty modes). No framework or I/O dependencies. Coverage ≥ 90%.
  Algorithms, formulas and the worked F example: docs/algorithms/transform-engine.md.
- `packages/contracts`: TS types **generated** from the analyzer's JSON Schema. Never edit
  `*.gen.ts` or `schema/*.json` by hand.
- `data/voicings`: chord-shape library (JSON + JSON Schema): `standard/curated.json` (hand-checked,
  wins on duplicates) and `standard/chords-db.json` (generated from tombatossals/chords-db, MIT,
  pinned commit; never edit by hand).
- `services/analyzer`: Python 3.12 + FastAPI + a SQLite-queue worker. It returns **raw analysis
  only** (beats, key, Harte chord labels, notes). It must never implement capo, transposition or
  voicing logic: those belong in `packages/theory`.

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

# Docker (one image: api + worker)
docker compose up --build
docker compose --profile tunnel up -d   # + Cloudflare Tunnel (CLOUDFLARE_TUNNEL_TOKEN in .env)
```

## Conventions and gotchas

- **Node version:** `^22.22.2 || ^24.15.0 || >=26` (jsdom 30 is the strictest dependency; pnpm 11
  needs ≥ 22.13, and `node scripts/*.ts` needs type stripping, which is on by default from 22.18).
- **Compose does not pass `.env` into containers** (no `env_file`): `.env` is only for
  interpolation, and analyzer settings are listed explicitly under `environment:`. This keeps
  secrets such as the tunnel token out of the processes that handle uploads.

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
- **UI strings** go in `apps/web/src/locales/{en,tr}.json`. A hardcoded JSX string is a lint error.
- **Python:** strict mypy, ruff (incl. bandit `S` rules), pytest. The JSON Schema drift test runs
  in pytest.
- **torch** (from M3) must come from the CPU wheel index (`download.pytorch.org/whl/cpu`).
  Otherwise Linux pulls the CUDA wheels, which add several GB.
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
| M2  | Web: text mode end to end, diagrams, mode/λ/capo UI, i18n, PWA                                  | next    |
| M3  | Analyzer: upload → decode → beats → key → Chordino; job queue + SSE                             |         |
| M4  | Synced player, speed/A-B loop, confidence marks, manual edits, IndexedDB library                |         |
| M5  | BTC (+ lv-chordia) recognizers, Demucs, evaluation report                                       |         |
| M6  | URL import (YouTube + Spotify metadata → search → confirm), feature flag                        |         |
| M7  | Tab mode (basic-pitch ONNX + tab assignment + alphaTab)                                         |         |
| M8  | Docker deploy guide (Windows Server/WSL2), Cloudflare Tunnel, benchmarks                        |         |
