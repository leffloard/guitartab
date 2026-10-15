import subprocess
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from barrefree_analyzer import benchmark
from barrefree_analyzer.benchmark import main
from barrefree_analyzer.config import Settings
from barrefree_analyzer.pipeline import factory


def test_benchmark_writes_a_report(tmp_path: Path) -> None:
    out = tmp_path / "benchmarks.md"
    main(["--minutes", "0.1", "--stages", "decode,beats_librosa,chroma_key", "--out", str(out)])
    text = out.read_text()
    assert "## 0.1-minute song" in text
    for title in ("Decode upload", "Beats: librosa", "Chroma + key"):
        row = next(line for line in text.splitlines() if line.startswith(f"| {title}"))
        cells = [c.strip() for c in row.strip("|").split("|")]
        assert len(cells) == 6
        assert float(cells[2]) >= 0  # run time
        assert float(cells[5]) > 100  # peak memory (MB), Python and NumPy included


def test_a_failing_step_keeps_the_others(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    real_run = subprocess.run

    def run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        if "chroma_key" in cmd:  # as if the kernel killed it at the memory limit
            return subprocess.CompletedProcess(cmd, -9, "", "Traceback ...\nKilled")
        return real_run(cmd, **kwargs)

    monkeypatch.setattr(subprocess, "run", run)
    out = tmp_path / "benchmarks.md"
    with pytest.raises(SystemExit, match="1 step"):
        main(["--minutes", "0.1", "--stages", "beats_librosa,chroma_key", "--out", str(out)])
    text = out.read_text()
    assert "| Beats: librosa |" in text
    assert "Failed: Chroma + key, 0.1 min (Killed)." in text


def test_the_full_job_turns_on_what_the_server_leaves_off(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    loaded: list[Settings] = []

    def build_pipeline(settings: Settings) -> SimpleNamespace:
        loaded.append(settings)
        return SimpleNamespace(
            recognizers={name: object() for name in settings.recognizers},
            separator=object() if settings.separation else None,
            transcriber=None,  # e.g. its weights failed to load
        )

    monkeypatch.setattr(factory, "build_pipeline", build_pipeline)
    settings = Settings(
        data_dir=tmp_path, recognizers=["chordino"], separation=False, transcription=False
    )
    benchmark._prepare("job_default", settings, tmp_path)
    assert loaded[-1] is settings  # the default job measures the server as configured
    with pytest.raises(RuntimeError, match="could not load notes"):
        benchmark._prepare("job_everything", settings, tmp_path)
    assert loaded[-1].recognizers == ["btc", "chordino"]
    assert loaded[-1].separation
    assert loaded[-1].transcription
