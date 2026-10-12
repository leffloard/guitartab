# Licenses

## Project licensing

| Part                                                     | License              |
| -------------------------------------------------------- | -------------------- |
| `apps/web`, `packages/*`, `data/voicings`, docs, tooling | **MIT**              |
| `services/analyzer`                                      | **GPL-3.0-or-later** |

**Why split?**

The transform engine (`packages/theory`) and the voicing library are the parts most worth reusing
in other projects, so they stay permissive (MIT).

The analyzer is planned to use Chordino/NNLS-Chroma, a vamp plugin loaded into the analyzer
process. That plugin is **GPL-2.0-or-later**. GPL-3.0-or-later lets us combine it with
Apache-2.0 code such as basic-pitch, which GPL-2.0-only would not allow.

The browser app talks to the analyzer only over HTTP. It neither links nor bundles analyzer
code, so its MIT license is unaffected.

**Alternatives considered:**

- **GPL-3.0 for the whole repo.** Simpler, but it would force copyleft on anyone embedding the
  theory engine.
- **AGPL-3.0.** It would also oblige anyone running a modified analyzer as a network service to
  publish their changes. That protection adds friction for a personal tool, and nothing we use
  requires it. Essentia is AGPL and would have forced it, so we do not use Essentia (see below).

## Dependencies and model weights

The status column describes this repository today: "in use" means currently a dependency;
the others are planned for later milestones. The weights license of every ML model is listed
separately from its code license, because weights trained on restricted datasets can carry
their own terms.

### Runtime and tooling (in use)

| Component                               | License          | Notes                 |
| --------------------------------------- | ---------------- | --------------------- |
| React, Vite, Vitest, TypeScript, ESLint | MIT / Apache-2.0 | build and dev tooling |
| i18next, react-i18next                  | MIT              |                       |
| FastAPI, Starlette, Pydantic, uvicorn   | MIT / BSD-3      |                       |

### Planned: web

| Component                        | License      | Notes                                                                  |
| -------------------------------- | ------------ | ---------------------------------------------------------------------- |
| svguitar                         | MIT          | chord diagrams (M2)                                                    |
| wavesurfer.js v8                 | BSD-3-Clause | player and waveform (M4)                                               |
| alphaTab (`@coderline/alphatab`) | MPL-2.0      | tab rendering (M7); file-level copyleft, OK to bundle                  |
| idb                              | ISC          | IndexedDB library (M4)                                                 |
| tombatossals/chords-db data      | MIT          | seed for `data/voicings` (M1); notice kept in `data/voicings/LICENSES` |

### Planned: analyzer

| Component                   | Code license     | Weights / data license                                                                        | Decision                                                                    |
| --------------------------- | ---------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| beat_this (CPJKU)           | MIT              | MIT (README). Training data partly copyrighted or CC-restricted.                              | **Use** as the beat and downbeat tracker (M3), with `dbn=False`             |
| librosa                     | ISC              | n/a                                                                                           | fallback beat tracker, chroma features                                      |
| NNLS-Chroma / Chordino      | GPL-2.0-or-later | n/a (DSP, no learned weights)                                                                 | **Use** (M3). Call vamp directly; the GPL is why the analyzer is GPL-3.0+   |
| BTC (jayg996/BTC-ISMIR19)   | MIT              | No explicit license. Trained on Isophonics, Billboard and other annotations of unclear terms. | Evaluate (M5). Download at setup with a pinned SHA-256; do not redistribute |
| lv-chordia                  | MIT              | No separate statement. Same training-data caveat.                                             | Evaluate (M5)                                                               |
| Demucs (`adefossez/demucs`) | MIT              | **Unspecified** on the model card. Trained partly on MUSDB18 (non-commercial research data).  | Optional (M5). Download at first run; do not bake into images               |
| basic-pitch (Spotify)       | Apache-2.0       | Ships in the Apache-2.0 package                                                               | Use the ONNX model (M7); keep Spotify's NOTICE                              |
| yt-dlp                      | Unlicense        | n/a                                                                                           | Optional URL import (M6), disabled by default                               |
| ffmpeg (Debian package)     | LGPL/GPL         | n/a                                                                                           | CLI decode only; a GPL source offer applies to published images             |

### Rejected

| Component                     | Why                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| madmom                        | Its model files are **CC BY-NC-SA 4.0** (non-commercial). The PyPI release does not install on Python ≥ 3.10. |
| Essentia                      | AGPL-3.0, which would force AGPL on the analyzer.                                                             |
| chord-extractor               | GPL-2.0 wrapper; uses `pkg_resources` (removed from setuptools ≥ 82); capped at Python < 3.12.                |
| ChordSheetJS                  | GPL-2.0-only, which is incompatible with the MIT web bundle and with Apache-2.0/GPL-3 code.                   |
| ChordPro built-in chord table | Artistic-2.0 attaches conditions to modified redistribution; we do not merge it into MIT data.                |

## Content policy

The repository must never contain copyrighted audio, lyrics or third-party tabs.

- Test audio is synthesized at test time.
- Your own recordings and `.lab` annotations belong in `local-data/`, which is git-ignored.
