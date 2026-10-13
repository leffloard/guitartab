"""Evaluate the analysis pipeline against reference chord annotations.

Synthetic songs (rendered on the fly, exact ground truth; nothing to download):

    uv run python eval/evaluate.py --synthetic

Your own recordings (never commit them): put <name>.<mp3|wav|flac|ogg|m4a> next to a
<name>.lab file (one "start end label" line per chord, Harte labels) in a git-ignored folder:

    uv run python eval/evaluate.py --data ../../local-data/eval

Compare recognizers and source separation (when they are installed), and write a Markdown
report:

    uv run python eval/evaluate.py --synthetic --recognizers chordino --separate off \\
        --report eval/report.md
"""

import argparse
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from barrefree_analyzer.audio import ANALYSIS_RATE, decode
from barrefree_analyzer.config import Settings
from barrefree_analyzer.evaluation import (
    Labeled,
    Tally,
    compare,
    key_score,
    load_lab,
    markdown_table,
    to_labeled,
)
from barrefree_analyzer.pipeline.factory import build_pipeline
from barrefree_analyzer.pipeline.interfaces import Audio
from barrefree_analyzer.schema import JobOptions
from barrefree_analyzer.synth import SONGS, render

AUDIO_SUFFIXES = (".mp3", ".wav", ".flac", ".ogg", ".m4a")


@dataclass
class Item:
    name: str
    audio: Audio
    reference: Labeled
    key: str | None


def synthetic_items() -> list[Item]:
    items = []
    for spec in SONGS:
        song = render(spec, ANALYSIS_RATE)
        items.append(Item(spec.name, song.audio, to_labeled(song.chords), spec.key))
    return items


def folder_items(folder: Path) -> list[Item]:
    items = []
    for lab in sorted(folder.glob("*.lab")):
        audio = next(
            (lab.with_suffix(s) for s in AUDIO_SUFFIXES if lab.with_suffix(s).is_file()), None
        )
        if audio is None:
            print(f"skip {lab.name}: no audio file next to it", file=sys.stderr)
            continue
        key_file = lab.with_suffix(".key")
        key = key_file.read_text(encoding="utf-8").strip() if key_file.is_file() else None
        items.append(Item(lab.stem, decode(audio, ANALYSIS_RATE), load_lab(lab), key))
    return items


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--synthetic", action="store_true", help="evaluate the synthetic songs")
    parser.add_argument("--data", type=Path, help="folder with audio + .lab pairs")
    parser.add_argument("--recognizers", default="chordino", help="comma-separated")
    parser.add_argument("--separate", default="off", help="off, on, or off,on")
    parser.add_argument("--report", type=Path, help="write a Markdown report here")
    args = parser.parse_args(argv)
    if not args.synthetic and args.data is None:
        parser.error("give --synthetic and/or --data")

    recognizers = [r.strip() for r in args.recognizers.split(",") if r.strip()]
    flags = [s.strip() for s in args.separate.split(",") if s.strip()]
    if not recognizers or not flags or any(f not in ("on", "off") for f in flags):
        parser.error("--recognizers needs names; --separate takes off, on, or off,on")
    separations = [f == "on" for f in flags]
    settings = Settings(recognizers=recognizers)
    try:
        pipeline = build_pipeline(settings, separation=any(separations))
    except ValueError as exc:
        parser.error(str(exc))
    if any(separations) and pipeline.separator is None:
        parser.error("source separation is not available in this installation")

    datasets: list[tuple[str, list[Item]]] = []
    if args.synthetic:
        datasets.append(("synthetic", synthetic_items()))
    if args.data is not None:
        datasets.append((args.data.name, folder_items(args.data)))

    summary: list[dict[str, object]] = []
    details: list[str] = []
    for dataset, items in datasets:
        for recognizer in recognizers:
            for separate in separations:
                pooled, keys, seconds = Tally(), [], 0.0
                rows: list[dict[str, object]] = []
                for item in items:
                    started = time.monotonic()
                    result = pipeline.run(
                        item.audio,
                        ANALYSIS_RATE,
                        JobOptions(recognizer=recognizer, separate=separate),
                    )
                    seconds += time.monotonic() - started
                    estimate = to_labeled((c.start, c.end, c.label) for c in result.chords)
                    tally = compare(item.reference, estimate)
                    pooled.add(tally)
                    est_key = f"{result.key.tonic} {result.key.mode}" if result.key else None
                    if item.key:
                        keys.append(key_score(item.key, est_key))
                    if result.meta.separated != separate:
                        raise RuntimeError(f"{item.name}: separation did not run as requested")
                    rows.append(
                        {
                            "song": item.name,
                            **{m: tally.score(m) for m in ("root", "majmin", "sevenths")},
                            "key": f"{est_key} (ref {item.key})" if item.key else est_key,
                        }
                    )
                label = f"{dataset} · {recognizer} · separation {'on' if separate else 'off'}"
                summary.append(
                    {
                        "setup": label,
                        "songs": len(items),
                        **{m: pooled.score(m) for m in ("root", "majmin", "sevenths")},
                        "key": sum(keys) / len(keys) if keys else None,
                        "time": f"{seconds:.1f} s",
                    }
                )
                details.append(
                    f"### {label}\n\n"
                    + markdown_table(rows, ["song", "root", "majmin", "sevenths", "key"])
                )

    table = markdown_table(summary, ["setup", "songs", "root", "majmin", "sevenths", "key", "time"])
    print(table)
    if args.report:
        args.report.write_text(
            "# Chord recognition evaluation\n\n"
            "Weighted chord symbol recall (mir_eval), pooled over songs by duration. Key: MIREX "
            "weighted score (1 same, 0.5 fifth, 0.3 relative, 0.2 parallel).\n\n"
            f"{table}\n## Per song\n\n" + "\n".join(details),
            encoding="utf-8",
        )
        print(f"wrote {args.report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
