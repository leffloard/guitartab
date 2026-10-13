"""Interfaces of the swappable pipeline steps.

Every step takes mono float32 audio at a known sample rate and returns plain data. Steps never
apply music theory (capo, transposition, voicings): that is the web app's job.
"""

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Protocol

import numpy as np
import numpy.typing as npt

Audio = npt.NDArray[np.float32]


@dataclass(frozen=True)
class BeatGrid:
    beats: list[float]
    downbeats: list[float] = field(default_factory=list)


@dataclass(frozen=True)
class KeyEstimate:
    tonic: int  # pitch class, 0 = C
    mode: str  # "major" | "minor"
    confidence: float


@dataclass(frozen=True)
class RawChord:
    start: float
    end: float
    label: str  # Harte syntax
    confidence: float | None = None  # None: the post-processor estimates it from chroma


@dataclass(frozen=True)
class Chromagram:
    """12-bin chroma (row 0 = C) sampled at ``times`` (frame centers, seconds)."""

    times: npt.NDArray[np.float64]
    values: npt.NDArray[np.float64]  # shape (frames, 12)


@dataclass(frozen=True)
class Stems:
    """Separated sources at ``rate`` Hz (mono)."""

    rate: int
    harmonic: Audio  # everything but drums and vocals: what chords are heard in
    other: Audio  # the "other" stem: guitars, keys (input for note transcription)


@dataclass(frozen=True)
class NoteEvent:
    start: float
    end: float
    midi: int
    velocity: float


class BeatTracker(Protocol):
    name: str

    def track(self, audio: Audio, rate: int) -> BeatGrid: ...


class ChromaExtractor(Protocol):
    def chroma(self, audio: Audio, rate: int) -> Chromagram: ...


class KeyEstimator(Protocol):
    def estimate(
        self, chroma: Chromagram, chords: Sequence[tuple[float, float, str]] = ()
    ) -> KeyEstimate | None: ...


class ChordRecognizer(Protocol):
    name: str

    def recognize(self, audio: Audio, rate: int) -> list[RawChord]: ...


class Separator(Protocol):
    name: str

    def separate(self, audio: Audio, rate: int) -> Stems: ...


class NoteTranscriber(Protocol):
    name: str

    def transcribe(self, audio: Audio, rate: int) -> list[NoteEvent]: ...
