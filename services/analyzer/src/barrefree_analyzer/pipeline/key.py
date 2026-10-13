"""Chroma extraction and key estimation (Krumhansl-Schmuckler).

The song's chroma, summed over time, is correlated with the Krumhansl-Kessler key profiles
rotated to all 12 tonics, for major and minor: 24 candidates. The best correlation wins.

Relative keys (C major / A minor) share all their notes, so the profiles alone often pick the
wrong one of the pair. When the recognized chords are known, the pair is decided by which tonic
triad the song dwells on, opens and ends with: on the synthetic set this lifts the MIREX key score
from 0.67 to 0.95. (Temperley's, Aarden's and Bellman's profiles did much worse on CQT chroma, at
0.15-0.25: their near-zero weights for non-scale tones over-react to the fifths that every
harmonic tone adds.)

Confidence: a softmax over the 24 correlations (temperature 0.1), so a key that clearly beats
its neighbors (the relative and the dominant keys usually come next) gets close to 1. When the
chords decide between relative keys, it is the pair's probability times the chords' margin.

Profiles: C. L. Krumhansl and E. J. Kessler (1982), "Tracing the dynamic changes in perceived
tonal organization in a spatial representation of musical keys", Psychological Review 89(4);
tabulated in C. L. Krumhansl (1990), Cognitive Foundations of Musical Pitch, p. 30. Values
checked against music21's ``analysis.discrete.KrumhanslSchmuckler``.
"""

from collections.abc import Sequence

import librosa
import mir_eval
import numpy as np
import numpy.typing as npt

from barrefree_analyzer.pipeline.interfaces import Audio, Chromagram, KeyEstimate

KK_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KK_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
_TEMPERATURE = 0.1
#: Hop of the chroma frames: 2048 samples at 22.05 kHz is about 93 ms.
CHROMA_HOP = 2048


class CqtChroma:
    """Constant-Q chroma from librosa (36 bins per octave folded to 12, tuning-corrected)."""

    def chroma(self, audio: Audio, rate: int) -> Chromagram:
        values = librosa.feature.chroma_cqt(y=audio, sr=rate, hop_length=CHROMA_HOP)
        times = librosa.frames_to_time(np.arange(values.shape[1]), sr=rate, hop_length=CHROMA_HOP)
        return Chromagram(
            times=np.asarray(times, dtype=np.float64), values=values.T.astype(np.float64)
        )


def key_scores(profile_input: npt.NDArray[np.float64]) -> npt.NDArray[np.float64]:
    """Pearson correlations of a 12-bin chroma with the 24 keys: rows 0-11 major, 12-23 minor."""
    scores = np.empty(24)
    for tonic in range(12):
        scores[tonic] = np.corrcoef(profile_input, np.roll(KK_MAJOR, tonic))[0, 1]
        scores[12 + tonic] = np.corrcoef(profile_input, np.roll(KK_MINOR, tonic))[0, 1]
    return np.nan_to_num(scores, nan=-1.0)


def tonic_evidence(chords: Sequence[tuple[float, float, str]], tonic: int, mode: str) -> float:
    """How much the chords point at a tonic: duration share of its triad, plus 0.25 each when the
    song opens or ends on it."""
    real = [(s, e, label) for s, e, label in chords if label not in ("N", "X") and e > s]
    if not real:
        return 0.0

    def is_tonic(label: str) -> bool:
        try:
            root, bitmap, _bass = mir_eval.chord.encode(label)
        except mir_eval.chord.InvalidChordException:
            return False
        third = "major" if bitmap[4] else "minor" if bitmap[3] else None
        return bool(root == tonic and third == mode)

    total = sum(e - s for s, e, _ in real)
    share = sum(e - s for s, e, label in real if is_tonic(label)) / total
    return share + 0.25 * is_tonic(real[0][2]) + 0.25 * is_tonic(real[-1][2])


#: Below this (max - min) / mean, the summed chroma is too flat to name a key.
_FLATNESS = 0.1


class KrumhanslKeyEstimator:
    def estimate(
        self, chroma: Chromagram, chords: Sequence[tuple[float, float, str]] = ()
    ) -> KeyEstimate | None:
        if chroma.values.size == 0:
            return None
        if chords and not any(label not in ("N", "X") and e > s for s, e, label in chords):
            return None  # the recognizer heard no chord: no key either
        total = np.asarray(chroma.values, dtype=np.float64).sum(axis=0)
        mean = float(total.mean())
        # Silence or noise: every pitch class about equally present. chroma_cqt scales each
        # frame to a maximum of 1, so noise is never exactly flat; white noise varies by about
        # 5 % around the mean, music by well over half of it.
        if mean <= 1e-9 or float(total.max() - total.min()) / mean < _FLATNESS:
            return None
        scores = key_scores(total)
        best = int(np.argmax(scores))
        probs = np.exp((scores - scores.max()) / _TEMPERATURE)
        probs /= probs.sum()
        confidence = float(probs[best])
        if chords:
            first = best
            tonic, major = first % 12, first < 12
            relative = 12 + (tonic + 9) % 12 if major else (tonic + 3) % 12
            own = tonic_evidence(chords, tonic, "major" if major else "minor")
            other = tonic_evidence(chords, relative % 12, "minor" if major else "major")
            if other > own:
                best = relative
            # The chroma decides the pair, the chords decide within it: confidence is the
            # pair's probability times how clearly the chords separate the two.
            pair = float(probs[first] + probs[relative])
            decided = max(own, other) / (own + other) if own + other > 0 else 0.5
            confidence = pair * decided
        return KeyEstimate(
            tonic=best % 12, mode="major" if best < 12 else "minor", confidence=confidence
        )
