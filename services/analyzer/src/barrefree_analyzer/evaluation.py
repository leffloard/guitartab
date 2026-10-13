"""Chord-recognition evaluation with ``mir_eval`` (root, majmin, sevenths, key).

Scores are weighted chord symbol recall (WCSR), as in MIREX: the duration where the estimate
matches the reference, divided by the duration where the comparison applies (``majmin`` skips
reference chords that are neither major nor minor, ``sevenths`` those outside the seventh
vocabulary). Song scores are pooled by duration, so long songs count more.

Sources: Harte (2010), "Towards automatic extraction of harmony information from music
signals", PhD thesis; Raffel et al. (2014), "mir_eval: A Transparent Implementation of Common
MIR Metrics", ISMIR.
"""

from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path

import mir_eval
import numpy as np
import numpy.typing as npt

Labeled = tuple[npt.NDArray[np.float64], list[str]]

METRICS: dict[str, Callable[[list[str], list[str]], npt.NDArray[np.float64]]] = {
    "root": mir_eval.chord.root,
    "majmin": mir_eval.chord.majmin,
    "sevenths": mir_eval.chord.sevenths,
}


@dataclass
class Tally:
    """Correct and comparable seconds per metric."""

    correct: dict[str, float] = field(default_factory=lambda: dict.fromkeys(METRICS, 0.0))
    total: dict[str, float] = field(default_factory=lambda: dict.fromkeys(METRICS, 0.0))

    def add(self, other: "Tally") -> None:
        for m in METRICS:
            self.correct[m] += other.correct[m]
            self.total[m] += other.total[m]

    def score(self, metric: str) -> float | None:
        total = self.total[metric]
        return self.correct[metric] / total if total > 0 else None


def to_labeled(segments: Iterable[tuple[float, float, str]]) -> Labeled:
    rows = [(s, e, label) for s, e, label in segments if e > s]
    intervals = np.asarray([[s, e] for s, e, _ in rows], dtype=np.float64).reshape(-1, 2)
    return intervals, [label for _, _, label in rows]


def load_lab(path: Path) -> Labeled:
    intervals, labels = mir_eval.io.load_labeled_intervals(str(path))
    return np.asarray(intervals, dtype=np.float64), list(labels)


def compare(reference: Labeled, estimate: Labeled) -> Tally:
    ref_i, ref_l = reference
    est_i, est_l = estimate
    if len(est_l) == 0:
        est_i, est_l = np.asarray([[ref_i.min(), ref_i.max()]]), [mir_eval.chord.NO_CHORD]
    # Pad or trim the estimate to the reference's time span, as mir_eval.chord.evaluate does.
    est_i, est_l = mir_eval.util.adjust_intervals(
        est_i,
        est_l,
        ref_i.min(),
        ref_i.max(),
        mir_eval.chord.NO_CHORD,
        mir_eval.chord.NO_CHORD,
    )
    intervals, ref_m, est_m = mir_eval.util.merge_labeled_intervals(ref_i, ref_l, est_i, est_l)
    durations = mir_eval.util.intervals_to_durations(intervals)
    tally = Tally()
    for name, comparator in METRICS.items():
        comparison = np.asarray(comparator(ref_m, est_m), dtype=np.float64)
        valid = comparison >= 0
        tally.correct[name] = float(np.sum(durations[valid] * comparison[valid]))
        tally.total[name] = float(np.sum(durations[valid]))
    return tally


def key_score(reference: str, estimate: str | None) -> float:
    """MIREX key score: 1 same key, 0.5 fifth, 0.3 relative, 0.2 parallel, else 0."""
    if estimate is None:
        return 0.0
    return float(mir_eval.key.weighted_score(reference, estimate))


def markdown_table(rows: list[dict[str, object]], columns: list[str]) -> str:
    def cell(value: object) -> str:
        if isinstance(value, float):
            return f"{value * 100:.1f}%"
        return "-" if value is None else str(value)

    lines = ["| " + " | ".join(columns) + " |", "|" + "|".join("---" for _ in columns) + "|"]
    lines += ["| " + " | ".join(cell(r.get(c)) for c in columns) + " |" for r in rows]
    return "\n".join(lines) + "\n"
