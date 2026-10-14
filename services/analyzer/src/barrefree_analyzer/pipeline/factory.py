"""Builds the pipeline from the settings: which recognizers, beat tracker and extras to load.

Optional parts degrade instead of failing the service: a part whose weights are missing,
damaged or unloadable is left out (and logged), so Chordino jobs keep working when, say, the
Demucs download failed. Only a pipeline without any chord recognizer is refused.
"""

import logging
from collections.abc import Callable
from functools import partial

from barrefree_analyzer.config import Settings
from barrefree_analyzer.models import ChecksumError, verified_model_path
from barrefree_analyzer.pipeline.beats import BeatThisTracker, LibrosaBeatTracker
from barrefree_analyzer.pipeline.chordino import ChordinoRecognizer
from barrefree_analyzer.pipeline.interfaces import (
    BeatTracker,
    ChordRecognizer,
    NoteTranscriber,
    Separator,
)
from barrefree_analyzer.pipeline.key import CqtChroma, KrumhanslKeyEstimator
from barrefree_analyzer.pipeline.run import NoRecognizerError, Pipeline

log = logging.getLogger("barrefree.pipeline")


def _load[T](what: str, build: Callable[[], T], *, strict: bool) -> T | None:
    try:
        return build()
    except (FileNotFoundError, ChecksumError) as exc:
        # Expected when a download failed: the message says what to do.
        if strict:
            raise
        log.warning("%s is unavailable: %s", what, exc)
        return None
    except Exception:
        # Anything else (a plugin or runtime that will not load) also only removes this part.
        if strict:
            raise
        log.exception("%s is unavailable", what)
        return None


def build_beat_tracker(settings: Settings, *, strict: bool = False) -> BeatTracker:
    if settings.beat_tracker == "beat_this":
        tracker = _load(
            "beat_this",
            lambda: BeatThisTracker(verified_model_path(settings, "beat_this")),
            strict=strict,
        )
        if tracker is not None:
            return tracker
        log.warning("using librosa beats instead of beat_this")
    return LibrosaBeatTracker()


def build_recognizer(name: str, settings: Settings) -> ChordRecognizer:
    if name == "chordino":
        return ChordinoRecognizer(settings.vamp_path)
    if name == "btc":
        from barrefree_analyzer.pipeline.btc import BTCRecognizer

        return BTCRecognizer(verified_model_path(settings, "btc"))
    raise ValueError(f"unknown chord recognizer '{name}'")


def build_separator(settings: Settings) -> Separator:
    from barrefree_analyzer.pipeline.separation import CachedSeparator, DemucsSeparator

    separator = DemucsSeparator(verified_model_path(settings, "htdemucs"))
    return CachedSeparator(separator, settings.stems_path, ttl_sec=settings.temp_file_ttl_sec)


def build_transcriber(settings: Settings) -> NoteTranscriber:
    from barrefree_analyzer.pipeline.notes import BasicPitchTranscriber

    return BasicPitchTranscriber(verified_model_path(settings, "basic_pitch"))


def build_pipeline(
    settings: Settings, *, separation: bool | None = None, strict: bool = False
) -> Pipeline:
    """Loads every enabled model; ``separation`` overrides ``settings.separation``.

    ``strict`` raises on the first part that fails to load (evaluation wants exactly what it
    asked for); otherwise failed parts are left out and only a missing recognizer raises.
    """
    recognizers: dict[str, ChordRecognizer] = {}
    for name in settings.recognizers:
        recognizer = _load(
            f"chord recognizer '{name}'", partial(build_recognizer, name, settings), strict=strict
        )
        if recognizer is not None:
            recognizers[name] = recognizer
    if not recognizers:
        raise NoRecognizerError(
            f"none of the chord recognizers ({', '.join(settings.recognizers)}) could be loaded"
        )
    separate = settings.separation if separation is None else separation
    return Pipeline(
        beat_tracker=build_beat_tracker(settings, strict=strict),
        chroma=CqtChroma(),
        key_estimator=KrumhanslKeyEstimator(),
        recognizers=recognizers,
        separator=_load("source separation", lambda: build_separator(settings), strict=strict)
        if separate
        else None,
        transcriber=_load("note transcription", lambda: build_transcriber(settings), strict=strict)
        if settings.transcription
        else None,
    )
