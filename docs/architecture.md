# Architecture

```
[Browser: React + Vite + TS SPA, PWA]
   ├─ Text mode: chord-sheet parser + transform engine   (fully client-side)
   ├─ Chord diagrams (svguitar), tab render/playback (alphaTab)
   ├─ Audio player + waveform (wavesurfer.js), i18n (react-i18next: tr, en)
   └─ REST + SSE (job progress)
            │
[Analyzer: Python 3.12 + FastAPI]  ── one Docker image, two processes
   ├─ api:    HTTP API + serves the built SPA
   ├─ worker: SQLite job queue (no Redis), runs the pipeline
   ├─ Pipeline: decode → (optional) separation → beats → key → chords → (optional) notes
   └─ Output: raw analysis JSON (versioned schema, Harte chord labels)
```

## Key decisions

### 1. The backend returns raw analysis only; all music theory runs in the browser

The analyzer outputs timed chord labels, beats, key and notes. It never does capo, transposition,
simplification or voicing choice. `packages/theory` does all of those.

- **Instant mode switches.** Changing the difficulty mode or the fidelity slider needs no server
  round-trip.
- **One engine for text and audio input.** A pasted chord sheet and an analyzed recording go
  through the same code, so there is a single source of truth.
- **Pure functions.** The engine is deterministic and has no I/O, so it is easy to test, including
  with property-based tests (fast-check).

### 2. Vite + React SPA instead of Next.js or SvelteKit

| Option           | Pros                                                                                                                       | Cons                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Vite + React** | Static build that FastAPI can serve; single container; simple PWA; largest ecosystem for svguitar, alphaTab and wavesurfer | No SSR (not needed)                                                                      |
| Next.js          | SSR/SSG, file routing                                                                                                      | Needs a Node server or a static-export subset; heavier PWA setup; SEO is irrelevant here |
| SvelteKit        | Smaller bundles                                                                                                            | Smaller ecosystem for the music libraries we need; the team knows React better           |

There is no SEO or SSR requirement: the app is a personal practice tool. A static build that
FastAPI serves keeps deployment to one image.

### 3. The analyzer's Pydantic models are the contract

`services/analyzer/src/barrefree_analyzer/schema.py` → `barrefree-export-schema` →
`packages/contracts/schema/analysis.schema.json` (committed) → `pnpm gen:contracts` →
`packages/contracts/src/analysis.gen.ts` (committed).

CI fails if either generated file is stale. `packages/theory` does **not** depend on the contract.
It takes a minimal `{label, start?, end?}[]` progression, and the web app adapts analysis results
to it.

### 4. SQLite job queue instead of Redis

A single-user, self-hosted app does not need a broker. A SQLite table in WAL mode holds the jobs,
and a separate worker process claims them, so there is one less service to run on a small VPS.
The data must live on a Docker volume, never on a Windows-mounted path, because SQLite locking
over DrvFs/NTFS is unreliable.

### 5. Python 3.12 (not 3.11)

Python 3.11 reaches end of life in October 2027. librosa 1.0 and numpy 2.5 already require ≥ 3.12.
The only dependency capped below 3.12 was `chord-extractor`, which we do not use: we call the
Chordino vamp plugin directly instead.

## Conventions

- **Strings and frets.** Inside `packages/theory` and `data/voicings`, fret arrays are indexed
  from the **low E string**: index 0 = string 6. Fret numbers are relative to the nut or capo,
  `null` means muted and `0` means open. svguitar and alphaTex number strings the other way
  (string 1 = high E), so convert only at the rendering boundary.
- **Chord labels on the wire** use Harte et al. (2005) syntax (`C:maj`, `A:min7`, `G:7/3`, `N`).
- **URL space.** Everything the server answers lives under `/api/`, including the FastAPI docs
  (`/api/docs`, `/api/openapi.json`). Every other path belongs to the web app, whose service
  worker answers navigations with `index.html` (its denylist is `/^\/api\//`).
- **Language.** Code, comments, commit messages and docs are in English. The UI is fully
  localized (`tr`, `en`). Hardcoded JSX strings are a lint error (`i18next/no-literal-string`).
