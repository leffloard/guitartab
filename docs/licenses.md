# Licenses

## Project licensing

| Part                                                     | License              |
| -------------------------------------------------------- | -------------------- |
| `apps/web`, `packages/*`, `data/voicings`, docs, tooling | **MIT**              |
| `services/analyzer`                                      | **GPL-3.0-or-later** |

**Why split?**

The transform engine (`packages/theory`) and the voicing library are the parts most worth reusing
in other projects, so they stay permissive (MIT).

The analyzer uses Chordino/NNLS-Chroma, a Vamp plugin loaded into the analyzer process. That plugin is **GPL-2.0-or-later**. GPL-3.0-or-later lets us combine it with
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

### Analyzer (in use since M3)

| Component                                            | License                                                                                                                                                                                     | Notes                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| NNLS-Chroma / Chordino (`c4dm/nnls-chroma`)          | GPL-2.0-or-later                                                                                                                                                                            | built from a pinned commit by `scripts/build-vamp-plugins.sh`; credit M. Mauch (QMUL), ISMIR 2010 |
| Vamp plugin SDK (`c4dm/vamp-plugin-sdk`)             | MIT-style (QMUL no-endorsement clause); KissFFT BSD-3                                                                                                                                       | static library linked into the plugin                                                             |
| `vamp` (vampy-host, PyPI)                            | MIT (no-endorsement clause)                                                                                                                                                                 | Python host for the plugin                                                                        |
| Boost headers                                        | BSL-1.0                                                                                                                                                                                     | build time only (header-only)                                                                     |
| beat_this 1.1.0 (CPJKU) + `final0` weights           | MIT (code and weights)                                                                                                                                                                      | weights downloaded by `barrefree-download-models`, SHA-256 pinned; not in the repo or image       |
| torch / torchaudio (CPU wheels)                      | Apache-2.0 (torch 2.14 metadata) / BSD                                                                                                                                                      | beat_this's model and mel spectrogram; installed from the PyTorch CPU index                       |
| einops, rotary-embedding-torch                       | MIT                                                                                                                                                                                         | beat_this dependencies                                                                            |
| soxr (python-soxr)                                   | LGPL-2.1-or-later                                                                                                                                                                           | resampling inside beat_this                                                                       |
| librosa 1.0                                          | ISC                                                                                                                                                                                         | CQT chroma, fallback beat tracker                                                                 |
| mir_eval 0.8                                         | MIT                                                                                                                                                                                         | Harte label parsing, evaluation                                                                   |
| NumPy, SciPy, scikit-learn, numba, llvmlite          | BSD-3 / BSD-2 (llvmlite also Apache-2.0 + LLVM exception)                                                                                                                                   | numeric stack                                                                                     |
| soundfile                                            | BSD-3 (bundles libsndfile, LGPL-2.1)                                                                                                                                                        | writing the synthetic evaluation set                                                              |
| python-multipart                                     | Apache-2.0                                                                                                                                                                                  | multipart uploads                                                                                 |
| BTC (jayg996/BTC-ISMIR19), ported model code         | MIT (Copyright (c) 2019 Jonggwon Park)                                                                                                                                                      | M5: `pipeline/btc.py` is a typed port of the model code; the notice is kept in its docstring      |
| BTC `btc_model_large_voca.pt` weights                | **no stated license**; trained on Isophonics, Billboard and other annotations                                                                                                               | M5: downloaded from the paper's repository at a pinned commit (SHA-256), never redistributed      |
| demucs 4.1.0 (`adefossez/demucs`)                    | MIT                                                                                                                                                                                         | M5: source separation (optional per job)                                                          |
| htdemucs weights (`adefossez/HTDemucs`, safetensors) | **no stated license** on the model card (the repository says "Demucs is released under the MIT license"); trained partly on MUSDB18-HQ, whose audio is licensed for non-commercial research | M5: downloaded at a pinned commit (SHA-256), never redistributed or baked into images             |
| julius, einops, pyyaml                               | MIT                                                                                                                                                                                         | demucs dependencies (resampling, tensor ops, config)                                              |
| lameenc                                              | LGPL-3.0-or-later                                                                                                                                                                           | demucs dependency (MP3 export, unused here); compatible with the analyzer's GPL                   |
| sphn, safetensors, huggingface-hub, hf-xet           | Apache-2.0                                                                                                                                                                                  | demucs dependencies (audio I/O, weight files, hub client; the hub client is not used at runtime)  |
| tqdm                                                 | MPL-2.0 AND MIT                                                                                                                                                                             | demucs dependency (progress bars)                                                                 |
| ffmpeg (Debian package, CLI)                         | LGPL/GPL                                                                                                                                                                                    | decoding and the playback copy; a GPL source offer applies to published images                    |

All of these are compatible with the analyzer's GPL-3.0-or-later.

### Planned: web

| Component                        | License      | Notes                                                                                                                    |
| -------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| svguitar                         | MIT          | chord diagrams (M2)                                                                                                      |
| wavesurfer.js v8                 | BSD-3-Clause | **in use**: player and waveform (M4)                                                                                     |
| alphaTab (`@coderline/alphatab`) | MPL-2.0      | tab rendering (M7); file-level copyleft, OK to bundle                                                                    |
| idb                              | ISC          | **in use**: IndexedDB wrapper for the song library (M4)                                                                  |
| fake-indexeddb                   | Apache-2.0   | **in use**, tests only (IndexedDB in jsdom); never bundled                                                               |
| tombatossals/chords-db data      | MIT          | **in use**: `data/voicings/standard/chords-db.json` at a pinned commit; notice in `data/voicings/LICENSES/chords-db.txt` |

### Planned: analyzer

| Component             | Code license | Weights / data license                                   | Decision                                                                |
| --------------------- | ------------ | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| lv-chordia            | MIT          | No separate statement. Same training-data caveat as BTC. | Measured in M5 and not adopted (see `services/analyzer/eval/report.md`) |
| basic-pitch (Spotify) | Apache-2.0   | Ships in the Apache-2.0 package                          | Use the ONNX model (M7); keep Spotify's NOTICE                          |
| yt-dlp                | Unlicense    | n/a                                                      | Optional URL import (M6), disabled by default                           |

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
