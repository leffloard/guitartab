"""Runs the analysis steps in order and assembles the raw-analysis result."""

import time
from collections.abc import Callable
from dataclasses import dataclass, field

import numpy as np

from barrefree_analyzer.pipeline.interfaces import (
    Audio,
    BeatGrid,
    BeatTracker,
    ChordRecognizer,
    ChromaExtractor,
    KeyEstimator,
    NoteTranscriber,
    Separator,
)
from barrefree_analyzer.pipeline.postprocess import postprocess, silent_runs
from barrefree_analyzer.schema import (
    AnalysisMeta,
    AnalysisResult,
    ChordSegment,
    JobOptions,
    JobStage,
    Key,
    Note,
)

#: Called with the stage that starts now and the overall progress in [0, 1].
Progress = Callable[[JobStage, float], None]

#: Tonic names as key signatures spell them: Eb major (3 flats), not D# major (9 sharps).
_MAJOR_TONICS = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
_MINOR_TONICS = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"]


class NoRecognizerError(RuntimeError):
    """None of the configured chord recognizers could be loaded."""


def tempo_from_beats(beats: list[float]) -> float | None:
    """Tempo from the median inter-beat interval (robust to a few missed or extra beats)."""
    if len(beats) < 4:
        return None
    ibi = float(np.median(np.diff(beats)))
    return round(60.0 / ibi, 1) if ibi > 0 else None


def time_signature(grid: BeatGrid) -> str | None:
    """Beats per bar from the downbeats: the most common count of beats between two of them."""
    if len(grid.downbeats) < 3 or len(grid.beats) < 6:
        return None
    beats = np.asarray(grid.beats)
    counts = [
        int(np.sum((beats >= a - 1e-3) & (beats < b - 1e-3)))
        for a, b in zip(grid.downbeats[:-1], grid.downbeats[1:], strict=True)
    ]
    values, freq = np.unique([c for c in counts if 2 <= c <= 7], return_counts=True)
    if values.size == 0:
        return None
    return f"{int(values[int(np.argmax(freq))])}/4"


@dataclass
class Pipeline:
    beat_tracker: BeatTracker
    chroma: ChromaExtractor
    key_estimator: KeyEstimator
    recognizers: dict[str, ChordRecognizer]
    separator: Separator | None = None
    transcriber: NoteTranscriber | None = None
    clock: Callable[[], float] = field(default=time.monotonic)

    def run(
        self, audio: Audio, rate: int, options: JobOptions, progress: Progress | None = None
    ) -> AnalysisResult:
        started = self.clock()
        report = progress or (lambda _stage, _fraction: None)
        recognizer = self.recognizers.get(options.recognizer)
        if recognizer is None:
            raise ValueError(f"recognizer '{options.recognizer}' is not available")

        harmonic, other, separated = audio, audio, False
        if options.separate and self.separator is not None:
            report("separating", 0.10)
            stems = self.separator.separate(audio, rate)
            if stems.rate != rate:
                raise ValueError("the separator must return stems at the input rate")
            harmonic, other, separated = stems.harmonic, stems.other, True

        report("beats", 0.40 if separated else 0.15)
        grid = self.beat_tracker.track(audio, rate)

        report("chords", 0.50 if separated else 0.35)
        chroma = self.chroma.chroma(harmonic, rate)
        segments = postprocess(
            recognizer.recognize(harmonic, rate),
            grid.beats,
            chroma,
            silences=silent_runs(audio, rate),
        )

        report("key", 0.70 if separated else 0.80)
        key = self.key_estimator.estimate(chroma, [(s.start, s.end, s.label) for s in segments])

        notes: list[Note] = []
        if options.transcribe and self.transcriber is not None:
            report("notes", 0.80)
            notes = [
                Note(start=n.start, end=n.end, midi=n.midi, velocity=n.velocity)
                for n in self.transcriber.transcribe(other, rate)
            ]

        return AnalysisResult(
            duration_sec=round(len(audio) / rate, 3),
            tempo_bpm=tempo_from_beats(grid.beats),
            time_signature=time_signature(grid),
            key=Key(
                tonic=(_MAJOR_TONICS if key.mode == "major" else _MINOR_TONICS)[key.tonic],
                mode=key.mode,
                confidence=round(key.confidence, 3),
            )
            if key
            else None,
            beats=[round(b, 3) for b in grid.beats],
            downbeats=[round(b, 3) for b in grid.downbeats],
            chords=[
                ChordSegment(
                    start=round(s.start, 3),
                    end=round(s.end, 3),
                    label=s.label,
                    confidence=round(s.confidence, 3),
                )
                for s in segments
            ],
            notes=notes,
            meta=AnalysisMeta(
                recognizer=recognizer.name,
                separated=separated,
                processing_sec=round(self.clock() - started, 2),
            ),
        )
