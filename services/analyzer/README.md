# BarreFree analyzer

Python service that turns an audio file into **raw** analysis: beats, tempo, key and timed
chord labels in Harte syntax (and, for the experimental tab mode, transcribed notes).
It does no music-theory transforms. Capo search, transposition and voicing selection
live in [`packages/theory`](../../packages/theory).

Licensed under **GPL-3.0-or-later** (see [LICENSE](LICENSE)). The rest of the monorepo is MIT,
see [docs/licenses.md](../../docs/licenses.md) for why.

```bash
uv sync                                   # create .venv with dev tools
uv run pytest                             # tests
uv run ruff check && uv run ruff format --check && uv run mypy
uv run uvicorn barrefree_analyzer.app:create_app --factory --reload   # API on :8000
uv run barrefree-worker                   # job worker
uv run barrefree-export-schema            # refresh packages/contracts/schema/analysis.schema.json
```
