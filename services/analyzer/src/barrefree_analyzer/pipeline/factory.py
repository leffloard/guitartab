"""Builds the pipeline from the settings: which recognizers, beat tracker and extras to load."""

import logging

from barrefree_analyzer.config import Settings
from barrefree_analyzer.models import model_path
from barrefree_analyzer.pipeline.beats import BeatThisTracker, LibrosaBeatTracker
from barrefree_analyzer.pipeline.chordino import ChordinoRecognizer
from barrefree_analyzer.pipeline.interfaces import BeatTracker, ChordRecognizer
from barrefree_analyzer.pipeline.key import CqtChroma, KrumhanslKeyEstimator
from barrefree_analyzer.pipeline.run import Pipeline

log = logging.getLogger("barrefree.pipeline")


def build_beat_tracker(settings: Settings) -> BeatTracker:
    if settings.beat_tracker == "beat_this":
        try:
            return BeatThisTracker(model_path(settings, "beat_this"))
        except (ImportError, FileNotFoundError) as exc:
            log.warning("beat_this unavailable (%s); using librosa beats", exc)
    return LibrosaBeatTracker()


def build_recognizer(name: str, settings: Settings) -> ChordRecognizer:
    if name == "chordino":
        return ChordinoRecognizer(settings.vamp_path)
    raise ValueError(f"unknown chord recognizer '{name}'")


def build_pipeline(settings: Settings, *, separation: bool = False) -> Pipeline:
    del separation  # source separation arrives with Demucs (M5)
    return Pipeline(
        beat_tracker=build_beat_tracker(settings),
        chroma=CqtChroma(),
        key_estimator=KrumhanslKeyEstimator(),
        recognizers={name: build_recognizer(name, settings) for name in settings.recognizers},
    )
