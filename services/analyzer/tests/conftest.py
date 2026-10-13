import os
from pathlib import Path

import pytest

from barrefree_analyzer.config import Settings
from barrefree_analyzer.models import model_path, required_models

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


@pytest.fixture(scope="session")
def pipeline_settings(vamp_dir: Path) -> Settings:
    """Default settings (every recognizer, separation on) with all their weights present."""
    settings = Settings(vamp_path=vamp_dir)
    for key in required_models(settings):
        need_model(settings, key)
    return settings
