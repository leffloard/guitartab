import hashlib
import os
import time
from pathlib import Path

import pytest

from barrefree_analyzer import models
from barrefree_analyzer.config import Settings
from barrefree_analyzer.models import ChecksumError, ModelFile, ensure_model


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
