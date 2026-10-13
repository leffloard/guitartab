## What was compared

- **Recognizers.** Chordino (NNLS chroma + HMM, Mauch & Dixon 2010; the default) and BTC
  (bi-directional transformer, large vocabulary, Park et al. 2019; `pipeline/btc.py`). Both run
  through the same post-processing (beat snapping, short-segment removal, silence as no-chord).
- **Source separation.** Demucs `htdemucs` (Rouard et al. 2023): drums and vocals are removed
  and the recognizer hears bass + other. Off by default; a job asks for it.
- **Data.** Only synthetic songs with exact ground truth (no recordings may be committed):
  - `synthetic`: ten songs across keys, major and minor, sevenths, slash chords, 3/4, 72 to 132
    bpm; some with quiet drums or a quiet lead.
  - `synthetic-busy`: the same ten with loud drums and a loud vibrato lead that moves to a
    passing note (a whole tone up) on every off-beat, as a sung melody does. This is the case
    separation is meant to help with.

## Reading the results

- **Chordino stays the default.** On both sets it matches BTC on root and major/minor (99.7 %
  and 99.6 %) and is clearly better on sevenths (97.0 % against 77.7 % on the plain set): BTC
  tends to answer the triad where the chord has a seventh. On real recordings the picture may
  differ (BTC was trained on real music, the synthetic timbres are closer to Chordino's
  templates), so BTC remains selectable per upload, and the same command evaluates personal
  recordings with `--data` (never committed).
- **The busy mix** costs Chordino sevenths, not chords: a lead singing passing notes makes it
  hear extensions (84.8 % sevenths), while root and major/minor stay at 99.6 %.
- **Separation** recovers part of that (84.8 → 87.2 % sevenths) and changes nothing on the plain
  set (97.0 → 97.1 %). It costs about half the song's length on this 4-core CPU (about 10 s per
  20 s song, see the time column), which is why it is an opt-in per job. BTC's answers do not
  change with separation at all.
- **lv-chordia** (Jiang et al. 2019, PyPI `lv-chordia` 1.1.0, MIT) was measured with the same
  data and scoring outside the project: root 97.8 %, majmin 97.8 %, sevenths 83.1 % on
  `synthetic`, and 97.7 / 97.7 / 85.5 % on `synthetic-busy`, at roughly 45 s per 20 s song (a
  five-model ensemble; measured while other jobs shared the CPU). It is not adopted: it is no
  more accurate than Chordino here, an order of magnitude slower than BTC, takes a file path
  (or downloads a URL) instead of samples, and loads its bundled weights with an unrestricted
  `torch.load` pickle.
- **Limits.** Synthetic songs have one timbre per part, exact tuning and no reverb. They check
  that the pipeline is correct and catch regressions; they do not rank recognizers for real
  music. The time column is wall-clock time on the machine below, including model inference
  but not model loading.
