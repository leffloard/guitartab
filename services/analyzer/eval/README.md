# Evaluation

`evaluate.py` runs the full pipeline and scores it with
[mir_eval](https://github.com/mir-evaluation/mir_eval): weighted chord symbol recall for
`root`, `majmin` and `sevenths` (pooled over songs by duration, as in MIREX), and the MIREX
key score (1 same key, 0.5 fifth, 0.3 relative, 0.2 parallel).

## Synthetic songs (default, nothing to download)

```bash
uv run python eval/evaluate.py --synthetic
```

The songs come from [`synth.py`](../src/barrefree_analyzer/synth.py): ten progressions across
keys, modes, sevenths, slash chords, 3/4 time and 72–132 BPM, some with drums and a vibrato
"vocal" line. Being synthetic, their ground truth is exact; real music is harder.

## Your own recordings

Never commit audio or annotations of copyrighted songs. Keep them in the git-ignored
`local-data/` folder:

```
local-data/eval/
  my-song.mp3        # or .wav .flac .ogg .m4a
  my-song.lab        # "start end label" per line, Harte labels (C:maj, A:min7, G:7/3, N)
  my-song.key        # optional: "A minor"
```

```bash
uv run python eval/evaluate.py --data ../../local-data/eval --report ../../local-data/eval/report.md
```
