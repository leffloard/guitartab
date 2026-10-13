"""Recognizer-independent clean-up of timed chord labels.

1. Merge consecutive repeats of a label.
2. Snap each chord change to the nearest beat (chords change on beats in nearly all music).
3. Drop segments shorter than a minimum (one beat, or ``min_sec`` without beats): they are
   almost always passing notes or recognizer jitter, and unplayable at a glance anyway.
4. Mark silence as no-chord: the lead-in, the tail, and every pause of a second or more in
   between. Window-based recognizers smear the neighboring chords over it (Chordino's window is
   0.37 s, and its HMM prefers staying in a chord to switching to "N").
5. Merge repeats again, and give every segment a confidence in [0, 1].

The confidence, when the recognizer gives none, compares the segment's mean chroma with chord
templates: a softmax over cosine similarities between the label's template and the 24 major and
minor triads of other roots. A clear match scores near 1; a tie with another chord about 0.5 or
less. The web app marks low-confidence chords for review.
"""

import itertools
from dataclasses import dataclass, replace
from functools import lru_cache

import mir_eval
import numpy as np
import numpy.typing as npt

from barrefree_analyzer.pipeline.interfaces import Chromagram, RawChord

NO_CHORD = "N"
#: Softmax temperature over cosine similarities (which mostly range 0.5-1 between triads).
_TEMPERATURE = 0.05


@dataclass(frozen=True)
class Segment:
    start: float
    end: float
    label: str
    confidence: float


def _canonical(label: str) -> str:
    label = label.strip()
    return NO_CHORD if label in ("", "N", "X") else label


def merge_repeats(chords: list[RawChord]) -> list[RawChord]:
    out: list[RawChord] = []
    for c in chords:
        if c.end <= c.start:
            continue
        prev = out[-1] if out else None
        if prev is not None and prev.label == c.label and abs(prev.end - c.start) < 1e-6:
            conf = _weighted_confidence(prev, c)
            out[-1] = RawChord(prev.start, c.end, prev.label, conf)
        else:
            out.append(c)
    return out


def _weighted_confidence(a: RawChord, b: RawChord) -> float | None:
    if a.confidence is None or b.confidence is None:
        return None
    da, db = a.end - a.start, b.end - b.start
    return (a.confidence * da + b.confidence * db) / max(da + db, 1e-9)


def snap_to_beats(
    chords: list[RawChord], beats: list[float], max_shift: float = 0.3
) -> list[RawChord]:
    """Moves each chord change to the nearest beat if one is close enough.

    The tolerance is half a beat, at most ``max_shift`` seconds: a recognizer's change times are
    usually within a tenth of a second, so a farther beat means the beat grid is wrong there
    (a missed beat, half tempo) and snapping would make things worse. Segments that collapse are
    removed.
    """
    if len(chords) < 2 or len(beats) == 0:
        return chords
    grid = np.asarray(beats, dtype=np.float64)
    tolerance = max_shift
    if len(grid) >= 2:
        tolerance = min(max_shift, 0.5 * float(np.median(np.diff(grid))))
    snapped = [chords[0].start]
    for c in chords[1:]:
        i = int(np.argmin(np.abs(grid - c.start)))
        near = abs(float(grid[i]) - c.start) <= tolerance
        snapped.append(float(grid[i]) if near else c.start)
    snapped.append(chords[-1].end)
    # Keep boundaries monotonic: a change can never move before the previous one.
    for k in range(1, len(snapped)):
        snapped[k] = max(snapped[k], snapped[k - 1])
    out = [
        RawChord(snapped[k], snapped[k + 1], c.label, c.confidence)
        for k, c in enumerate(chords)
        if snapped[k + 1] - snapped[k] > 1e-6
    ]
    return merge_repeats(out)


def drop_short(chords: list[RawChord], min_sec: float) -> list[RawChord]:
    """Absorbs segments shorter than ``min_sec`` into a neighbor, shortest first."""
    out = list(chords)
    while len(out) > 1:
        lengths = [c.end - c.start for c in out]
        k = int(np.argmin(lengths))
        if lengths[k] >= min_sec:
            break
        short = out.pop(k)
        prev = out[k - 1] if k > 0 else None
        nxt = out[k] if k < len(out) else None
        # Extend the neighbor that already plays this label if any, else the longer one.
        use_prev = prev is not None and (
            nxt is None
            or prev.label == short.label
            or (nxt.label != short.label and prev.end - prev.start >= nxt.end - nxt.start)
        )
        if use_prev and prev is not None:
            out[k - 1] = replace(prev, end=short.end)
        elif nxt is not None:
            out[k] = replace(nxt, start=short.start)
        out = merge_repeats(out)
    return out


def silent_runs(
    audio: npt.NDArray[np.float32],
    rate: int,
    threshold_db: float = -45.0,
    hop: int = 512,
    min_gap: float = 1.0,
) -> list[tuple[float, float]]:
    """Silent stretches, in seconds: the lead-in, the tail, and inner pauses of ``min_gap`` or more.

    A 23 ms block (``hop`` samples at 22.05 kHz) is silent when its RMS is more than
    ``threshold_db`` below the loudest block's. The final block may be shorter than ``hop``; its
    RMS is taken over the samples it has. Entirely silent audio is one run.
    """
    n = len(audio)
    if n == 0:
        return []
    duration = n / rate
    frames = -(-n // hop)
    padded = np.zeros(frames * hop, dtype=np.float64)
    padded[:n] = audio
    counts = np.full(frames, hop, dtype=np.float64)
    counts[-1] = n - (frames - 1) * hop
    rms = np.sqrt((padded.reshape(frames, hop) ** 2).sum(axis=1) / counts)
    peak = float(rms.max())
    if peak <= 1e-8:
        return [(0.0, duration)]
    active = rms >= peak * 10 ** (threshold_db / 20)
    # Boundaries of runs of equal activity: run k covers blocks edges[k] .. edges[k + 1] - 1.
    edges = [0, *(np.nonzero(np.diff(active.astype(np.int8)))[0] + 1).tolist(), frames]
    runs: list[tuple[float, float]] = []
    for a, b in itertools.pairwise(edges):
        if active[a]:
            continue
        start, end = a * hop / rate, min(b * hop / rate, duration)
        if a == 0 or b == frames or end - start >= min_gap:
            runs.append((start, end))
    return runs


def mark_silence(chords: list[RawChord], runs: list[tuple[float, float]]) -> list[RawChord]:
    """Relabels the parts of the chords that lie in a silent run as no-chord."""
    out = chords
    for start, end in runs:
        split: list[RawChord] = []
        for c in out:
            if c.end <= start or c.start >= end:
                split.append(c)
                continue
            if c.start < start:
                split.append(replace(c, end=start))
            split.append(RawChord(max(c.start, start), min(c.end, end), NO_CHORD))
            if c.end > end:
                split.append(replace(c, start=end))
        out = split
    # merge_repeats also drops the zero-length pieces a split can leave.
    return merge_repeats(out)


@lru_cache(maxsize=512)
def chord_template(label: str) -> tuple[float, ...] | None:
    """Pitch-class template (index 0 = C) of a Harte label; None for no-chord or bad labels."""
    try:
        root, bitmap, bass = mir_eval.chord.encode(label)
    except mir_eval.chord.InvalidChordException:
        return None
    if root < 0:
        return None
    template = np.roll(np.asarray(bitmap, dtype=np.float64), root)
    if bass >= 0:
        template[(root + bass) % 12] = 1.0
    norm = float(np.linalg.norm(template))
    return tuple(template / norm) if norm > 0 else None


_TRIADS = [
    (root, quality, np.asarray(chord_template(f"{name}:{quality}")))
    for root, name in enumerate(["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"])
    for quality in ("maj", "min")
]


def _unit(v: npt.NDArray[np.float64]) -> npt.NDArray[np.float64] | None:
    n = float(np.linalg.norm(v))
    return v / n if n > 1e-9 else None


def chroma_confidence(label: str, chroma_mean: npt.NDArray[np.float64]) -> float:
    """How clearly the chroma supports ``label`` against chords on other roots."""
    c = _unit(np.clip(chroma_mean, 0, None))
    if c is None:
        return 1.0 if label == NO_CHORD else 0.0
    best_triad = max(float(np.dot(c, t)) for _, _, t in _TRIADS)
    if label == NO_CHORD:
        # Silence or noise: no chord template fits well.
        return float(np.clip((0.85 - best_triad) / 0.35, 0.0, 1.0))
    template = chord_template(label)
    if template is None:
        return 0.0
    own = float(np.dot(c, np.asarray(template)))
    root = int(mir_eval.chord.encode(label)[0])
    rivals = [float(np.dot(c, t)) for r, _, t in _TRIADS if r != root]
    scores = np.asarray([own, *rivals]) / _TEMPERATURE
    scores -= scores.max()
    probs = np.exp(scores)
    return float(probs[0] / probs.sum())


def _segment_chroma(chroma: Chromagram, start: float, end: float) -> npt.NDArray[np.float64]:
    mask = (chroma.times >= start) & (chroma.times < end)
    if not mask.any():
        i = int(np.argmin(np.abs(chroma.times - (start + end) / 2)))
        return np.asarray(chroma.values[i], dtype=np.float64)
    return np.asarray(chroma.values[mask].mean(axis=0), dtype=np.float64)


def postprocess(
    raw: list[RawChord],
    beats: list[float],
    chroma: Chromagram | None,
    *,
    silences: list[tuple[float, float]] | None = None,
    min_sec: float = 0.5,
) -> list[Segment]:
    """Runs steps 1-5. ``min_sec`` applies only without a beat grid."""
    chords = merge_repeats([replace(c, label=_canonical(c.label)) for c in raw])
    chords = snap_to_beats(chords, beats)
    if len(beats) >= 2:
        # Just under one beat, but never more than a second (a wrong, half-tempo grid must not
        # erase real chords) and never under a quarter second (240 bpm), so that a double-tempo
        # grid does not let jitter through.
        min_sec = float(np.clip(0.9 * float(np.median(np.diff(beats))), 0.25, 1.0))
    chords = merge_repeats(drop_short(chords, min_sec))
    if silences:
        chords = mark_silence(chords, silences)
    out: list[Segment] = []
    for c in chords:
        if c.confidence is not None:
            conf = c.confidence
        elif chroma is not None and len(chroma.times) > 0:
            conf = chroma_confidence(c.label, _segment_chroma(chroma, c.start, c.end))
        else:
            conf = 0.5
        out.append(Segment(c.start, c.end, c.label, float(np.clip(conf, 0.0, 1.0))))
    return out
