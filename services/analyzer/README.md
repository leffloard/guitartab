# BarreFree analyzer

Python service that turns an audio file into **raw** analysis: beats, tempo, time signature, key
and timed chord labels in Harte syntax (and, for the experimental tab mode, transcribed notes).
It does no music-theory transforms. Capo search, transposition and voicing selection
live in [`packages/theory`](../../packages/theory).

Licensed under **GPL-3.0-or-later** (see [LICENSE](LICENSE)). The rest of the monorepo is MIT,
see [docs/licenses.md](../../docs/licenses.md) for why.

## Setup

Needs ffmpeg (with ffprobe) at run time, and git, g++, make and the Boost headers to build the
Chordino plugin (Debian/Ubuntu: `apt install ffmpeg git g++ make libboost-dev`).

```bash
uv sync                               # .venv with dev tools (torch comes from the CPU index)
scripts/build-vamp-plugins.sh         # builds Chordino into .vamp/ (needs g++, make, libboost-dev)
uv run barrefree-download-models      # beat_this, BTC, Demucs and Basic Pitch weights into
                                      # local-data/models (pinned URLs, SHA-256 checked; ~180 MB)
```

## Run

```bash
uv run uvicorn barrefree_analyzer.app:create_app --factory --reload   # API on :8000
uv run barrefree-worker                                              # job worker (one or more)
```

The API and the worker share `DATA_DIR` (default `local-data/`): the SQLite queue, uploads and
results live there and are deleted after `TEMP_FILE_TTL_SEC` (6 h). Settings are environment
variables, see [`config.py`](src/barrefree_analyzer/config.py).

| Endpoint                       | What                                                        |
| ------------------------------ | ----------------------------------------------------------- |
| `POST /api/jobs`               | multipart `file` (+ `recognizer`, `separate`, `transcribe`) |
| `GET /api/jobs/{id}`           | job state; `result` once done                               |
| `GET /api/jobs/{id}/events`    | Server-Sent Events: `job` on every change, then `end`       |
| `GET /api/jobs/{id}/audio`     | normalized mono MP3 for the player (HTTP Range)             |
| `DELETE /api/jobs/{id}`        | delete the job and its files now                            |
| `GET /api/health`, `/api/docs` | health/features, OpenAPI docs                               |

## Pipeline

decode (ffmpeg, mono 22.05 kHz) → optional separation (Demucs: drums and vocals removed) →
beats + downbeats (beat_this, librosa fallback) → chords (Chordino by default, or BTC) → clean-up
(snap changes to beats, drop sub-beat segments, mark silence, confidence) → key
(Krumhansl–Kessler on CQT chroma, relative major/minor decided by the tonic chord) → optional
notes (Basic Pitch on ONNX Runtime, on the "other" stem when separated). Each step is an interface in
[`pipeline/interfaces.py`](src/barrefree_analyzer/pipeline/interfaces.py).

## Quality

```bash
uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest
uv run python eval/evaluate.py --synthetic        # mir_eval scores on synthetic songs
uv run barrefree-export-schema                    # after changing schema.py, then pnpm gen:contracts
```

On the synthetic set (10 songs, rendered with an additive synth, exact ground truth) Chordino
scores majmin 99.7 %, sevenths 97.0 %, MIREX key score 0.95. The comparison with BTC and source
separation, on this set and on a "busy" variant with loud drums and a singing lead, is in
[eval/report.md](eval/report.md). Real recordings score lower; evaluate your own with
`eval/evaluate.py --data` (see [eval/README.md](eval/README.md)).
