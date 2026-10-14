from pathlib import Path

from barrefree_analyzer.benchmark import main


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
