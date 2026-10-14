# BarreFree

Turn songs into **barre-free** acoustic guitar chords (and, experimentally, tabs).

Give BarreFree an audio file or a pasted chord sheet. It suggests the best capo position, swaps
any remaining barre chords for the musically closest open shapes (F → Fmaj7, Bm → Bm7, B → B7…),
draws the finger diagrams and keeps the chords in sync with the music while you play.

## What it does

- **Chord sheets** (chords over lyrics, or ChordPro): a barre-free version with capo, diagrams
  and alternatives, in Turkish or English. Runs entirely in the browser, offline too.
- **Recordings** (MP3, WAV, FLAC, Ogg, M4A up to 15 minutes): the analyzer finds the beats, key
  and chords. The song page plays the recording with the barre-free chords in sync: current
  and next chord, a beat countdown, slower playback without changing the pitch, an A-B loop,
  marks on uncertain chords and fixes you can make. Songs stay in a library in your browser.
- **Difficulty modes and capo search**: from "exact chords" to "easiest shapes", with every
  capo position ranked by how playable and how faithful it is
  ([how](docs/algorithms/transform-engine.md)).
- **Optional** (switched per upload): source separation, which removes drums and vocals before
  chord recognition and helps busy mixes, and a second chord recognizer (BTC).
- **Experimental**: a tab of the transcribed notes in open position (frets 0–5 above the capo),
  drawn in the page, copyable as text and downloadable as MusicXML; and import from a YouTube
  or Spotify link (off by default, see [Legal](#legal)).

How well the analysis works, measured on synthetic songs with exact answers:
[services/analyzer/eval/report.md](services/analyzer/eval/report.md) (Chordino: 99.7 %
major/minor, 97.0 % with sevenths; real recordings score lower).

## Run it

Docker is the simplest way: one image with the web app, the API and the analysis worker.

```bash
cp .env.example .env      # optional: every setting has a default
docker compose up -d --build
# http://localhost:8000; the first start downloads about 180 MB of model weights
```

- **On a Windows Server VPS** (WSL 2 + Docker Engine, published through a Cloudflare Tunnel,
  no open ports): [docs/deploy-windows.md](docs/deploy-windows.md).
- **Sizing**: [docs/benchmarks.md](docs/benchmarks.md) gives the time and memory of each
  step. Run `docker compose exec worker barrefree-benchmark` to measure your own server.
- **Settings**: [.env.example](.env.example) and
  [services/analyzer/src/barrefree_analyzer/config.py](services/analyzer/src/barrefree_analyzer/config.py).

**Privacy.** There are no accounts. An upload is deleted as soon as it is decoded. The
playback copy, the result and any separated stems are deleted when the song is saved in your
browser's library, and in any case after six hours (`TEMP_FILE_TTL_SEC`).

## Development

Requirements: Node 24.15+ (or 22.22.2+) with Corepack, [uv](https://docs.astral.sh/uv/),
ffmpeg (with ffprobe), g++, make and the Boost headers for the analyzer (Debian/Ubuntu:
`apt install ffmpeg g++ make libboost-dev`), and Docker for the full stack.

```bash
corepack enable          # uses the pnpm version pinned in package.json
pnpm install
pnpm dev                 # web app on http://localhost:5173 (proxies /api to :8000)
pnpm lint && pnpm typecheck && pnpm test

cd services/analyzer
uv sync --extra url                       # --extra url: link import (optional)
scripts/build-vamp-plugins.sh             # Chordino (needs g++, make, libboost-dev)
uv run barrefree-download-models          # beat tracker, BTC, Demucs, Basic Pitch (~180 MB)
uv run uvicorn barrefree_analyzer.app:create_app --factory --reload   # API on :8000
uv run barrefree-worker                   # analysis worker
uv run pytest
```

`pnpm check` runs everything the quality gate runs (format, lint, types, tests with coverage,
contract drift and the analyzer's checks).

## Repository layout

| Path                 | What                                                                    | License          |
| -------------------- | ----------------------------------------------------------------------- | ---------------- |
| `apps/web`           | React + Vite + TypeScript single-page app (PWA, `tr` + `en`)            | MIT              |
| `packages/theory`    | Pure TypeScript transform engine: parsing, transposition, capo, voicing | MIT              |
| `packages/contracts` | TypeScript types generated from the analyzer's JSON Schema              | MIT              |
| `data/voicings`      | Chord-shape library (JSON + JSON Schema), seeded from chords-db         | MIT              |
| `services/analyzer`  | Python 3.12 + FastAPI audio analysis service and job worker             | GPL-3.0-or-later |
| `docs/`              | Architecture, algorithms, deployment, benchmarks and license notes      |                  |

See [docs/architecture.md](docs/architecture.md) for the design and
[docs/licenses.md](docs/licenses.md) for every dependency's license and why the analyzer is GPL.

## Legal

The repository contains no copyrighted audio, lyrics or third-party tabs. Test audio is
synthesized.

Importing songs from YouTube/Spotify links is an optional, **disabled-by-default** module
(`ENABLE_URL_IMPORT=true` turns it on). Spotify provides only the title and artist; the audio
comes from a YouTube video the user picks. Downloading from YouTube may violate its terms of
service: whoever runs the server decides whether to enable it, and using it is **your
responsibility**, for songs you have the right to use. YouTube often refuses data-center
servers, so the feature is best effort (see [docs/architecture.md](docs/architecture.md) §4c).

## License

MIT, except `services/analyzer`, which is GPL-3.0-or-later. See [LICENSE](LICENSE). The web
app links the third-party licenses it bundles (alphaTab is MPL-2.0) from its footer.
