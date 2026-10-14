import hashlib
import os
import time
import urllib.error
from pathlib import Path

import pytest
from pydantic import ValidationError

from barrefree_analyzer import models
from barrefree_analyzer.config import Settings
from barrefree_analyzer.models import (
    ChecksumError,
    ModelFile,
    availability,
    ensure_model,
    verified_model_path,
)
from tests.conftest import fake_install


def register(monkeypatch: pytest.MonkeyPatch, source: Path, **override: object) -> None:
    data = source.read_bytes()
    spec = ModelFile(
        key="toy",
        path="toy/weights.bin",
        url=source.as_uri(),
        sha256=hashlib.sha256(data).hexdigest(),
        size=len(data),
        license="MIT",
    )
    monkeypatch.setitem(models.MODELS, "toy", ModelFile(**{**spec.__dict__, **override}))


def test_downloads_verifies_and_clears_abandoned_partials(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    source = tmp_path / "source.bin"
    source.write_bytes(os.urandom(3000))
    register(monkeypatch, source)
    settings = Settings(data_dir=tmp_path / "data", model_dir=tmp_path / "models")
    folder = tmp_path / "models" / "toy"
    folder.mkdir(parents=True)
    old, fresh = folder / ".weights.bin.old1", folder / ".weights.bin.new1"
    old.write_bytes(b"x")
    fresh.write_bytes(b"x")
    hour_ago = time.time() - 2 * 3600
    os.utime(old, (hour_ago, hour_ago))

    path = ensure_model(settings, "toy")
    assert path.read_bytes() == source.read_bytes()
    # An abandoned partial goes; one that may belong to a running download stays.
    assert not old.exists()
    assert fresh.exists()


@pytest.mark.parametrize("field", ["sha256", "size"])
def test_rejects_a_wrong_or_oversized_download(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, field: str
) -> None:
    source = tmp_path / "source.bin"
    source.write_bytes(os.urandom(3000))
    register(monkeypatch, source, **({"sha256": "0" * 64} if field == "sha256" else {"size": 10}))
    settings = Settings(data_dir=tmp_path / "data", model_dir=tmp_path / "models")
    with pytest.raises(ChecksumError):
        ensure_model(settings, "toy")
    assert list((tmp_path / "models" / "toy").iterdir()) == []


def test_loaders_get_a_path_only_for_an_intact_file(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    source = tmp_path / "source.bin"
    source.write_bytes(os.urandom(3000))
    register(monkeypatch, source)
    settings = Settings(data_dir=tmp_path / "data", model_dir=tmp_path / "models")
    with pytest.raises(FileNotFoundError):
        verified_model_path(settings, "toy")
    dest = tmp_path / "models" / "toy" / "weights.bin"
    dest.parent.mkdir(parents=True)
    with dest.open("wb") as f:
        f.truncate(3000)  # right size, wrong content
    with pytest.raises(ChecksumError):
        verified_model_path(settings, "toy")
    dest.write_bytes(b"short")
    with pytest.raises(ChecksumError):
        verified_model_path(settings, "toy")
    dest.write_bytes(source.read_bytes())
    assert verified_model_path(settings, "toy") == dest


def test_a_damaged_file_is_removed_even_when_the_new_download_fails(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    source = tmp_path / "source.bin"
    source.write_bytes(os.urandom(3000))
    register(monkeypatch, source, url=(tmp_path / "gone.bin").as_uri())
    settings = Settings(data_dir=tmp_path / "data", model_dir=tmp_path / "models")
    dest = tmp_path / "models" / "toy" / "weights.bin"
    dest.parent.mkdir(parents=True)
    dest.write_bytes(b"tampered")
    with pytest.raises(urllib.error.URLError):
        ensure_model(settings, "toy")
    assert not dest.exists()


def test_availability_follows_the_installed_files(tmp_path: Path) -> None:
    vamp, model_dir = fake_install(tmp_path)
    settings = Settings(data_dir=tmp_path, vamp_path=vamp, model_dir=model_dir)
    everything = availability(settings)
    assert everything.recognizers == ("chordino", "btc")
    assert everything.separation
    assert everything.transcription
    (model_dir / "demucs" / "955717e8.safetensors").unlink()
    (model_dir / "basic_pitch" / "nmp.onnx").write_bytes(b"cut short")
    (vamp / "nnls-chroma.so").unlink()
    some = availability(settings)
    assert some.recognizers == ("btc",)
    assert not some.separation
    assert not some.transcription
    # BTC is offered only when it is switched on, installed or not.
    off = Settings(data_dir=tmp_path, vamp_path=vamp, model_dir=model_dir, recognizers=["chordino"])
    assert availability(off).recognizers == ()


def test_recognizers_are_validated_when_the_settings_load(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("RECOGNIZERS", " btc, chordino,btc ")
    assert Settings().recognizers == ["btc", "chordino"]
    monkeypatch.setenv("RECOGNIZERS", '["chordino"]')
    assert Settings().recognizers == ["chordino"]
    for bad in ("chordino,nope", "", " , "):
        monkeypatch.setenv("RECOGNIZERS", bad)
        with pytest.raises(ValidationError):
            Settings()
    monkeypatch.delenv("RECOGNIZERS")
    with pytest.raises(ValidationError):
        Settings(beat_tracker="madmom")
