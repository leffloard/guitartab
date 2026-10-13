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

A single `UPDATE jobs SET status='running' ... WHERE id = (SELECT ... LIMIT 1) RETURNING *`
claims the oldest queued job atomically (SQLite ≥ 3.35), so any number of workers can run. The
API streams progress with Server-Sent Events by polling the job row every 0.5 s: no pub/sub is
needed, and a reconnecting browser simply gets the current state.

### 4a. Analysis pipeline (M3)

```
upload ─▶ magic bytes + size cap (413 while streaming) ─▶ ffprobe duration (1 s … 15 min) ─▶ queue
worker ─▶ ffmpeg: mono 22.05 kHz float32 (analysis) + mono 128 kbit/s CBR MP3 (player), upload deleted
       ─▶ separation (opt-in) Demucs htdemucs: chords hear bass + other (no drums, no vocals)
       ─▶ beats + downbeats   beat_this (CPJKU, MIT weights, no DBN); librosa fallback
       ─▶ chords              Chordino (default; NNLS chroma + HMM, block 8192 / step 1024) or
                              BTC (bi-directional transformer, 170 classes), Harte labels
       ─▶ clean-up            snap changes to beats (≤ ½ beat, ≤ 0.3 s), drop sub-beat segments,
                              lead-in, tail and pauses ≥ 1 s → N, chroma-template confidence
       ─▶ key                 Krumhansl–Kessler on CQT chroma; relative major/minor decided by
                              the tonic chord's share and the first/last chord
       ─▶ AnalysisResult JSON in the job row; everything deleted after the TTL (6 h)
```

Every step sits behind an interface (`pipeline/interfaces.py`), so recognizers, beat trackers
and separators can be swapped and compared by `eval/evaluate.py` (results:
`services/analyzer/eval/report.md`).

**Why Chordino stays the default (M5).** On the synthetic sets both recognizers get root and
major/minor right, and Chordino is clearly better on sevenths: BTC tends to answer the triad.
BTC is offered per upload because it was trained on real recordings and may do better on them;
the eval CLI measures that on personal files (`--data`, never committed). lv-chordia was measured
too and not adopted (no more accurate here, much slower, file-path API, unrestricted pickle
loading).

**BTC as a typed port.** The paper's code is a research script (YAML config, `np.float`, a
training-only LSTM in the output layer, pickled checkpoint). `pipeline/btc.py` re-implements the
inference path with the same module names, so the published weights load with strict key
checks after dropping the unused LSTM, and `torch.load(weights_only=True)` with an allow-list of
the two NumPy types the checkpoint stores its statistics as. Its frame predictions match the
original code exactly (checked frame by frame on the synthetic songs).

**Why separation is opt-in.** Demucs costs about the length of the song on a 4-core CPU and
changes nothing on clean mixes; it helps when a loud voice or drums mislead the recognizer.
Weights come as safetensors from a pinned commit (no pickle), the run is deterministic
(`shifts=0`), and the stems are cached by the SHA-256 of the input samples for the job TTL. The
analysis signal is mono, so separation runs without stereo cues; a stereo decode for separation
is a possible improvement.

**Why snap with a tolerance?** Recognizers report changes within ~0.1 s, but a beat tracker can
miss beats or lock to half tempo. Snapping only to a beat within half a beat (at most 0.3 s) keeps
the benefit without letting a wrong grid move chords; without the tolerance the synthetic majmin
score drops from 99.7 % to 97 %. Segments shorter than 0.9 beat are absorbed into a neighbor; the
threshold is clamped to 0.25–1 s so that a half- or double-tempo grid can neither erase real
chords nor let jitter through (0.5 s without a beat grid).

**Why the silence gate?** Chordino's 0.37 s analysis window smears the first and last chord over
the silence around the music (about 7 % of each synthetic song), and its HMM carries a chord
straight across a silent break. Every 23 ms block more than 45 dB below the loudest one is
silent; the lead-in, the tail and every pause of 1 s or more are marked as no-chord.

**Untrusted media.** ffmpeg probes content to choose a demuxer, and its playlist demuxers (HLS,
DASH, concat) open the URLs and paths a playlist lists. An upload that starts with an ID3 header
passes the MP3 magic-byte check, yet ffmpeg skips the tag and would read a DASH manifest behind it,
fetching from the server's network (SSRF) or reading local files. So every ffprobe/ffmpeg call
forces the demuxer that matches the accepted magic bytes (`-f mp3|wav|flac|ogg|mov`) and adds
`-protocol_whitelist file`; a regression test serves real audio on a local HTTP server and checks
that such uploads are rejected without a single request. Commands are argument lists (no shell),
inputs carry the `file:` prefix, and each call has a timeout.

**Privacy.** No accounts: an unguessable job id is the only key. The original upload is deleted
as soon as it is decoded; the playback copy and the result are deleted after the TTL, and a
`DELETE` removes them at once. The web app keeps its own copy in the browser (see 4b).

### 4b. Web app: routes, library and the synced player (M4)

```
/            upload card (+ recognizer) and text mode
/jobs/:id    live stages over SSE ─▶ on "done": GET result + GET audio ─▶ IndexedDB ─▶ /songs/:id
/songs/:id   player, chord strip, controls, bar chart, diagrams, exports (text, ChordPro, print)
/library     songs saved in this browser; delete
```

- **Router.** Four routes do not justify a router library: `lib/router.ts` wraps the History API
  in `useSyncExternalStore`. FastAPI already answers every non-`/api/` path with `index.html`.
- **Library (IndexedDB via `idb`).** A song is the analysis, the playback MP3 as a Blob, the
  user's chord fixes (`edits`, index → Harte label) and the controls' state (`view`). The server
  deletes everything after its TTL, so the browser copy is the only one that lasts; the app asks
  for persistent storage (`navigator.storage.persist`). No account, nothing leaves the device.
  Together with the precached bundle, a saved song opens and plays offline.
- **Player (wavesurfer.js v8).** wavesurfer drives a detached `<audio>` element (`media`), so
  speed changes use the browser's own time stretching with `preservesPitch` (0.5–1×): the
  chords stay in tune with a guitar. An A-B loop seeks back on `timeupdate`; the regions
  plugin only draws it. The MP3 is constant bitrate so seeking is exact.
- **Sync without re-rendering at frame rate.** `timeupdate` fires about every frame while
  playing. The song page maps the time to a position (current chord, next change, beats to
  go, bar; binary search in `packages/theory/src/timeline.ts`) and only sets state when that
  position changes, about once per beat. The countdown counts beats on the beat grid and falls
  back to seconds without one.
- **Bars.** `barsFromBeats` builds bars from the downbeats (or every N beats; music before the
  first downbeat is a pickup bar); `layoutBars` puts each chord at the beat it starts on.
  The same layout feeds the chart, the plain-text export and ChordPro (`{tempo}`, `{time}`).
- **Confidence and fixes.** Chords under 0.5 confidence get a dashed outline and a count. A fix
  is typed the way the chart writes chords (capo shapes or transposed names) and stored as
  canonical Harte at the recording's pitch (`lib/edits.ts`), so it keeps meaning the same chord
  when the capo or transposition changes. Breaks show as N.C. cells, so a missed chord can be
  added and a fix to "no chord" undone. Edits are stored per segment, the analysis itself stays
  untouched, and re-opening a job page never replaces a saved song (`saveSong` only adds).
- **Leaving a page.** The player stops its audio element itself (wavesurfer leaves media it did
  not create alone), an upload in progress is aborted, and the controls' state is flushed.
- **One arrangement hook.** `useArrangement` wires the transform engine to the controls for
  both text mode and the song page, so capo, mode, λ and voicing preferences behave the same.

### 4c. Link import (M6, off by default)

```
POST /api/import/resolve {url}
  Spotify track  ─▶ oEmbed (title) + track page meta (artist) ─▶ yt-dlp "ytsearch5: artist title"
  YouTube video  ─▶ yt-dlp metadata (no download)
  ─▶ candidates; the user checks title, channel and length and picks one
POST /api/import/jobs {videoId}  ─▶ queued like an upload
worker: "downloading" (yt-dlp, bestaudio m4a, size and length limits) ─▶ the normal pipeline
```

- **Off unless the operator enables it** (`ENABLE_URL_IMPORT=true`): with the flag off the
  routes do not exist (404), the worker refuses link jobs, and the web app hides the card. The
  card always shows the terms-of-service and responsibility notice, and nothing is downloaded
  before the user confirms one exact video.
- **No server-side request to a user-typed URL.** `parse_link` accepts only exact hosts
  (`open.spotify.com`, `youtube.com` and its `www`/`m`/`music` subdomains, `youtu.be`) without
  user-info or ports, and reduces the link to an id; every request is rebuilt from that id on a
  fixed host. Spotify pages are read with a 2 MB cap and a timeout; yt-dlp runs with
  `allowed_extractors` limited to YouTube (its generic extractor, which would fetch any URL, is
  excluded), no playlists, a size limit and a length check.
- **YouTube and data-center servers.** YouTube asks many server addresses to sign in ("confirm
  you're not a bot"): search keeps working but metadata and downloads fail. The worker reports
  "YouTube refused this server", and the operator can provide a cookies file of a signed-in
  session (`URL_IMPORT_COOKIES`, Netscape `cookies.txt` format). Risks: whoever holds the file
  can use that Google account, and YouTube may flag or block an account used this way. Use a
  separate account made for this, keep the file in the data volume readable only by the server
  (`chmod 600`), and expect to replace it when the session expires. yt-dlp gets a private
  in-memory copy for each call, so the file is never rewritten. This is why the feature is
  optional and best effort.
- **Why yt-dlp with Deno.** YouTube's player now needs JavaScript to be run to get stream URLs;
  yt-dlp delegates that to an external runtime (`yt-dlp-ejs` scripts run by Deno). Both come
  from PyPI through the optional `url` extra (`yt-dlp[default,deno]`), so the Docker image needs
  no separate install. Alternatives: Invidious/Piped instances (third parties, unstable),
  YouTube Data API (search only, no audio).

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
