from pathlib import Path

import pytest

from barrefree_analyzer.config import Settings
from barrefree_analyzer.models import ChecksumError
from barrefree_analyzer.pipeline import factory
from barrefree_analyzer.pipeline.beats import LibrosaBeatTracker
from barrefree_analyzer.pipeline.interfaces import ChordRecognizer
from barrefree_analyzer.pipeline.run import NoRecognizerError
from tests.conftest import fake_install
from tests.test_jobs_api import FakeChords


def test_parts_that_fail_to_load_are_left_out(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def build(name: str, settings: Settings) -> ChordRecognizer:
        if name == "btc":
            raise RuntimeError("BTC will not load")
        return FakeChords()

    monkeypatch.setattr(factory, "build_recognizer", build)
    # Every weights file is present with the right size, but none passes its checksum.
    vamp, models = fake_install(tmp_path)
    settings = Settings(data_dir=tmp_path, vamp_path=vamp, model_dir=models)
    pipeline = factory.build_pipeline(settings)
    assert list(pipeline.recognizers) == ["chordino"]
    assert pipeline.separator is None
    assert pipeline.transcriber is None
    assert isinstance(pipeline.beat_tracker, LibrosaBeatTracker)


def test_no_recognizer_at_all_is_an_error(tmp_path: Path) -> None:
    vamp, models = fake_install(tmp_path, models=["btc"], plugin=False)
    settings = Settings(data_dir=tmp_path, vamp_path=vamp, model_dir=models, recognizers=["btc"])
    with pytest.raises(NoRecognizerError):
        factory.build_pipeline(settings)
    # Strict (evaluation): the first failure itself, here the checksum of the fake weights.
    with pytest.raises(ChecksumError):
        factory.build_pipeline(settings, strict=True)


def test_weights_are_checked_before_they_are_loaded(tmp_path: Path) -> None:
    vamp, models = fake_install(tmp_path)
    settings = Settings(data_dir=tmp_path, vamp_path=vamp, model_dir=models)
    for build in (factory.build_separator, factory.build_transcriber):
        with pytest.raises(ChecksumError):
            build(settings)
