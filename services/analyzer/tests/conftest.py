import os
from collections.abc import Iterable
from pathlib import Path

import pytest

from barrefree_analyzer.config import Settings
from barrefree_analyzer.models import MODELS, model_path, required_models
from barrefree_analyzer.pipeline.chordino import PLUGIN_FILE

#: `pnpm check` sets this so that a missing plugin or model fails instead of skipping.
REQUIRE = os.environ.get("BARREFREE_REQUIRE_MODELS") == "1"


def _need(ok: bool, what: str) -> None:
    if ok:
        return
    if REQUIRE:
        pytest.fail(f"{what} is missing (BARREFREE_REQUIRE_MODELS=1)")
    pytest.skip(f"{what} is missing")


@pytest.fixture(scope="session")
def vamp_dir() -> Path:
    path = Settings().vamp_path
    _need((path / "nnls-chroma.so").is_file(), "nnls-chroma.so (scripts/build-vamp-plugins.sh)")
    return path


def need_model(settings: Settings, key: str) -> Path:
    path = model_path(settings, key)
    _need(path.is_file(), f"{key} weights (barrefree-download-models)")
    return path


def fake_install(
    root: Path, models: Iterable[str] = tuple(MODELS), *, plugin: bool = True
) -> tuple[Path, Path]:
    """A pretend installation for API tests: (vamp_path, model_dir).

    The Chordino plugin is an empty file and each weights file has the right size but no
    content (sparse): enough for ``models.availability``, never loadable.
    """
    vamp, model_dir = root / "install" / "vamp", root / "install" / "models"
    vamp.mkdir(parents=True, exist_ok=True)
    if plugin:
        (vamp / PLUGIN_FILE).touch()
    for key in models:
        path = model_dir / MODELS[key].path
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("wb") as f:
            f.truncate(MODELS[key].size)
    return vamp, model_dir


@pytest.fixture(scope="session")
def pipeline_settings(vamp_dir: Path) -> Settings:
    """Default settings (every recognizer, separation on) with all their weights present."""
    settings = Settings(vamp_path=vamp_dir)
    for key in required_models(settings):
        need_model(settings, key)
    return settings
