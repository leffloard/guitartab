# BarreFree

Turn songs into **barre-free** acoustic guitar chords (and, experimentally, tabs).

Give BarreFree an audio file or a pasted chord sheet. It suggests the best capo position, swaps
any remaining barre chords for the musically closest open shapes (F → Fmaj7, Bm → Bm7, B → B7…),
draws the finger diagrams and keeps the chords in sync with the music while you play.

> **Status:** early development. The transform engine (`packages/theory`, milestone M1) works;
> the web UI comes next (M2).

## Repository layout

| Path                 | What                                                                    | License          |
| -------------------- | ----------------------------------------------------------------------- | ---------------- |
| `apps/web`           | React + Vite + TypeScript single-page app (PWA, `tr` + `en`)            | MIT              |
| `packages/theory`    | Pure TypeScript transform engine: parsing, transposition, capo, voicing | MIT              |
| `packages/contracts` | TypeScript types generated from the analyzer's JSON Schema              | MIT              |
| `data/voicings`      | Chord-shape library (JSON + JSON Schema), seeded from chords-db         | MIT              |
| `services/analyzer`  | Python 3.12 + FastAPI audio analysis service and job worker             | GPL-3.0-or-later |
| `docs/`              | Architecture, algorithms and license notes                              |                  |

See [docs/architecture.md](docs/architecture.md) for the design and
[docs/licenses.md](docs/licenses.md) for why the analyzer is GPL.

## Development

Requirements: Node 24.15+ (or 22.22.2+) with Corepack, [uv](https://docs.astral.sh/uv/),
and Docker for the full stack.

```bash
corepack enable          # uses the pnpm version pinned in package.json
pnpm install
pnpm dev                 # web app on http://localhost:5173 (proxies /api to :8000)
pnpm lint && pnpm typecheck && pnpm test

cd services/analyzer
uv sync
uv run uvicorn barrefree_analyzer.app:create_app --factory --reload   # API on :8000
uv run pytest
```

Full stack in Docker (API + built web app on http://localhost:8000, plus the worker):

```bash
cp .env.example .env
docker compose up --build
```

## Legal

The repository contains no copyrighted audio, lyrics or third-party tabs. Test audio is
synthesized. Importing songs from YouTube/Spotify links is an optional, disabled-by-default
module, and using it is **your responsibility** under those platforms' terms of service.

## License

MIT, except `services/analyzer`, which is GPL-3.0-or-later. See [LICENSE](LICENSE).
