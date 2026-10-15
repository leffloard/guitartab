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
claims the oldest queued job atomically (SQLite ≥ 3.35), so any number of workers can run. Each
records its `WORKER_ID` on the jobs it claims; the id is made exclusive by a lock file on the
data volume (a second worker started with the same id runs as `<id>-2`), so a restarting worker
can fail its own unfinished jobs without touching another worker's, and a job failed meanwhile
is never written back as done. The API streams progress with Server-Sent Events by polling the job row every 0.5 s: no pub/sub is
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

**Missing models degrade, they do not break.** The worker downloads missing or damaged weights
when it starts (SHA-256 checked; a file that fails the check is deleted, even if the new
download fails). Each loader takes its file only through `models.verified_model_path`, which
checks size and SHA-256, so a damaged or replaced file is never handed to torch, ONNX Runtime
or Demucs. A part that fails to load is left out and logged: beat_this falls back to librosa,
and BTC, separation and notes disappear from `/api/health` (`models.availability` reports what
is installed), so the web app stops offering them and the API refuses jobs that ask for them.
Chordino jobs keep working. Only a server without any chord recognizer refuses uploads
(503, health status `degraded`). The worker reloads its models when a model file changes.

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

- _Loading._ Safetensors alone is not enough: Demucs' loader imports and calls the class named
  in the file's metadata, so a crafted file would run code. `load_htdemucs` builds
  `HTDemucs` itself from the file's JSON arguments and requires an exact match of the tensors.
- _Memory._ Demucs' own `apply_model` keeps the four stereo sources of the whole song at
  44.1 kHz (1.3 GB for 15 minutes), and julius resamples a whole song in one pass (another
  1.3 GB of temporaries). The separator runs the same overlap-add loop but reduces each
  segment to the two mono mixes it needs, and resamples in 30 s blocks with 4096 samples of
  context (bit-identical to one pass). For a 15-minute song this lowers the extra memory of
  separation from about 3.9 GB to 0.5 GB, with the same output (to 2·10⁻⁷).
- _Cache._ Entries are written to a hidden temporary file and renamed, so concurrent workers
  never read partial files; a damaged entry is discarded and computed again; a failed write
  only costs the cache.

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
as soon as it is decoded, and every file of an analysis that fails (or is interrupted, or times
out) is deleted at once; only its row with the error stays. The playback copy, the result and
the separated stems (recorded per job in `jobs/<id>/stems.ref`) are deleted after the TTL,
counted from when the analysis finished, and a `DELETE` removes them at once.
The web app keeps its own copy in the browser (see 4b) and sends that `DELETE` as soon as the
song is saved, so a finished song normally stays on the server only for seconds.

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

### 4d. Tab mode (M7, experimental)

```
upload with "write out the notes" ─▶ worker: Basic Pitch (ONNX Runtime) on the mix, or on
the "other" stem after separation ─▶ notes {start, end, midi, velocity} in AnalysisResult
browser: assignTab (string + fret per note, Viterbi) ─▶ MusicXML (alphaTab draws it, download)
                                                   └─▶ text tab (copy)
```

- **Why Basic Pitch through ONNX.** It is small (230 KB), instrument-agnostic, Apache-2.0, and
  trained partly on guitar (GuitarSet). Its package cannot be installed on Python 3.12 (it pins
  TensorFlow < 2.15.1), so `pipeline/notes.py` ports its pre- and post-processing and runs the
  published `nmp.onnx` with ONNX Runtime; on the same activations its notes match the original
  code's exactly, except for one upstream defect it fixes: the original keeps 86 frames per
  second of audio while its windows hold 86.6, so the last 0.7 % of every song (6 s of a
  15-minute one) was never transcribed. Alternatives: MT3 or other transformer transcribers
  (far larger, GPU-minded), CREPE/pYIN (monophonic only).
- **Decoding tuned for plucked strings.** With Basic Pitch's default thresholds a plucked
  string comes back as several notes plus harmonics (F1 0.59 on the synthetic Karplus–Strong
  arpeggio). Stricter onset/frame thresholds (0.7/0.4), a range ending at C6, and merging a
  split note back into one raise it to 0.90 (precision 0.81, recall 1.0). A split is merged
  only where it is a misreading: another string was plucked at that moment (the onset head
  fires on every string that sounds) and the note's own activation shows no new attack. A
  string plucked again on its own, such as an alternating bass, keeps its plucks (repeated
  bass notes: F1 0.84 on average over ten renderings, 0.69–0.94; merging on the attack alone
  scored 0.43). The tests assert recall
  ≥ 0.9 and F1 ≥ 0.8 on the arpeggio, and mean recall ≥ 0.75 and F1 ≥ 0.8 over six renderings
  of repeated notes (recall 0.66–0.91 among them). Known limit: a bass note plucked together
  with a treble note (Travis-style pinches) still looks like a misreading and can be merged.
- **Tab assignment in the browser** (`packages/theory/src/tab.ts`), so it follows the capo and
  transposition chosen on the page without a new analysis. Notes starting within 35 ms form an
  event; every way to put an event on distinct strings with frets 0–5 above the capo (open
  position: nothing needs a barre) is a state, and a Viterbi pass minimizes fret height,
  stretches over three frets and the hand's movement between fretted events (`tabCost`).
  Open strings leave the hand where it was, so a cell of the pass is a state _and_ the hand
  position it carries; with one cell per state the pass missed the optimum in about 5 % of
  short melodies. A property test compares it with a brute-force optimum. Notes out of reach
  are listed, not forced onto the neck; a group with more notes than strings keeps the largest
  subset that fits (all subsets are searched, inner voices dropped first on ties).
- **The grid follows the detected beats** (`beatGrid`): a note's sixteenth is interpolated
  between the beats around it, and bars hold the time signature's beats from the first
  downbeat. One fixed tempo drifted by 6 sixteenths within 48 bars on the synthetic songs (the
  reported tempo is a median of beat intervals quantized to 20 ms frames), and a real
  performance drifts more; a fixed tempo is only the fallback without beats. Two notes on one
  string in one sixteenth (a hammer-on, a triplet) cannot both be written: the later one moves
  to the next sixteenth when that is free, otherwise the page says how many were left out
  (`placeOnGrid`, shared by both writers so the text and the MusicXML always agree).
- **Rendering.** MusicXML is the interchange format (MuseScore and Guitar Pro read it), so the
  same file is downloaded and drawn: each note held to the next onset and tied over bar lines;
  it validates against the official MusicXML 4.0 schema, and characters XML forbids are
  dropped from the title (a file name may hold them). The copied text tab starts with the
  title and the capo, since its frets count from the capo. alphaTab (MPL-2.0) draws it in a
  lazily loaded chunk, without its player (the page already plays the recording) and without
  workers; its bundled Vite plugin is deprecated and missing from the 1.8 package.

### 4e. Deployment (M8)

```
Windows Server VPS ─▶ WSL 2 (Ubuntu 24.04, systemd) ─▶ Docker Engine ─▶ docker compose:
   api (uvicorn: API + built web app, 127.0.0.1:8000)   worker (queue, models in a volume)
   cloudflared (optional profile) ─── outbound only ───▶ Cloudflare ◀── visitors (HTTPS)
```

- **Why WSL 2 + Docker Engine.** Docker Desktop is not supported on Windows Server, and the
  image is Linux-only (Chordino, torch CPU wheels). Docker Engine inside a WSL 2 distro runs the
  same compose file as any Linux host. The step-by-step guide is
  [deploy-windows.md](deploy-windows.md).
- **Why Cloudflare Tunnel.** cloudflared opens outbound connections to Cloudflare, so the VPS
  needs no inbound port, no certificate and no reverse proxy; the API stays bound to
  localhost. Behind it every request comes from cloudflared, so the upload rate limit reads
  the visitor's address from `CF-Connecting-IP` (`CLIENT_IP_HEADER`), which is safe only
  because nothing else can reach the API.
- **Compose.** One image, two services: the API only reads the models volume (read-only
  mount, for `availability`), the worker downloads and loads them. Settings are listed once
  (`x-env`) and passed explicitly, so `.env` secrets never reach the containers. Logs rotate
  (json-file, 3 × 10 MB). Memory limits turn a runaway job into a restart of one container
  instead of a frozen VM; the worker then fails the job it was running at once (its
  `WORKER_ID` is recorded when it claims a job), rather than after the one-hour stale-job
  timeout. The API stops within 5 s even with open event streams.
- **Sizing.** [benchmarks.md](benchmarks.md) (`barrefree-benchmark`, also runnable inside the
  worker image) measures every step's time and peak memory on synthetic songs. On 4 cores a
  job with the defaults takes about 10 % of the song's length (about 20 s for 3 minutes, half
  of it decoding the upload and writing the playback copy) and peaks at 2.0 GB for 15 minutes.
  Separation is the expensive step in time, about 40 % of the length; in memory it adds about
  0.4 GB (2.4 GB at 15 minutes with BTC and notes too). Separation is therefore opt-in per
  upload, and the worker's memory limit is 4 GB with or without it.
- **Caching.** Vite's hashed assets are served `immutable`; `index.html`, the service worker
  and the manifest are `no-cache`, so Cloudflare (or a browser) never pins an old app. Only
  paths that can be app routes (no dot, not under `/assets/`) fall back to `index.html`; a
  missing file is a 404. An old tab asking for a chunk that a new build replaced would
  otherwise get the page with status 200, and Workbox, which caches only 200 responses, would
  keep it as the tab renderer or its font.

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
