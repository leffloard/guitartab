"""Beat and downbeat tracking.

``beat_this`` (Foscarin, Schlüter & Widmer, 2024, "Beat this! Accurate beat tracking without DBN
postprocessing", ISMIR; code and weights MIT, https://github.com/CPJKU/beat_this) is a small
transformer that finds beats and downbeats directly, without the madmom DBN (whose weights are
non-commercial). librosa's dynamic-programming tracker (Ellis, 2007) is the light fallback: no
torch and no weights, but no downbeats either.
"""

from pathlib import Path

import librosa
import numpy as np

from barrefree_analyzer.pipeline.interfaces import Audio, BeatGrid


class LibrosaBeatTracker:
    name = "librosa"

    def track(self, audio: Audio, rate: int) -> BeatGrid:
        _tempo, beats = librosa.beat.beat_track(y=audio, sr=rate, units="time")
        return BeatGrid(beats=[round(float(b), 4) for b in np.atleast_1d(beats)])


class BeatThisTracker:
    name = "beat_this"

    def __init__(self, checkpoint: Path) -> None:
        if not checkpoint.is_file():
            raise FileNotFoundError(
                f"beat_this checkpoint {checkpoint} is missing; run barrefree-download-models"
            )
        from beat_this.inference import Audio2Beats

        # No DBN: beat_this is trained to work without it, and madmom is not a dependency.
        self._model = Audio2Beats(
            checkpoint_path=str(checkpoint), device="cpu", float16=False, dbn=False
        )

    def track(self, audio: Audio, rate: int) -> BeatGrid:
        # Under a second there is no beat to find, and a few hundred samples are shorter than
        # the model's STFT padding (torch raises).
        if len(audio) < rate:
            return BeatGrid(beats=[])
        beats, downbeats = self._model(audio, rate)
        return BeatGrid(
            beats=[round(float(b), 4) for b in beats],
            downbeats=[round(float(d), 4) for d in downbeats],
        )
