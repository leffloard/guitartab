"""CPU time and memory of each analysis step, on synthetic songs, for sizing a server.

    uv run barrefree-benchmark --minutes 1,3,15 --out ../../docs/benchmarks.md
    docker compose run --rm --no-deps worker barrefree-benchmark --minutes 3,15   # on a server

On a server, run it while no song is being analyzed: its own container keeps it inside its own
memory limit, but it shares the CPUs and the machine's memory with the worker.

Every step runs in its own process, after its models are loaded, so its peak memory is its own
and not the leftover of an earlier step. The input is a synthetic "busy" song (drums and a sung
lead over chords) repeated to the requested length: timing depends on the length and the
hardware, not on the music. Steps whose models are missing are skipped and listed.
"""

import argparse
import json
import os
import platform
import resource
import shutil
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from importlib import metadata
from pathlib import Path
from statistics import median
from typing import Any

import numpy as np

from barrefree_analyzer.config import Settings, get_settings
from barrefree_analyzer.pipeline.interfaces import Audio

RATE = 22050


@dataclass(frozen=True)
class Stage:
    key: str
    title: str
    #: Model files the stage needs (keys of models.MODELS); "chordino" means the Vamp plugin.
    needs: tuple[str, ...] = ()


STAGES = [
    Stage("decode", "Decode upload + playback MP3 (ffmpeg)"),
    Stage("beats_librosa", "Beats: librosa"),
    Stage("beats_beat_this", "Beats: beat_this", ("beat_this",)),
    Stage("chroma_key", "Chroma + key"),
    Stage("chordino", "Chords: Chordino", ("chordino",)),
    Stage("btc", "Chords: BTC", ("btc",)),
    Stage("separation", "Separation: Demucs (no cache)", ("htdemucs",)),
    Stage("notes", "Notes: Basic Pitch", ("basic_pitch",)),
    Stage("job_default", "Analysis of the decoded song: defaults", ("chordino", "beat_this")),
    Stage(
        "job_everything",
        "Analysis of the decoded song: BTC + separation + notes",
        ("beat_this", "btc", "htdemucs", "basic_pitch"),
    ),
]
BY_KEY = {s.key: s for s in STAGES}


def synthetic_audio(minutes: float) -> Audio:
    """A busy synthetic song looped to ``minutes``."""
    from barrefree_analyzer.synth import BUSY, render

    song = render(BUSY[5], rate=RATE)
    n = max(1, int(minutes * 60 * RATE))
    reps = int(np.ceil(n / len(song.audio)))
    return np.tile(song.audio, reps)[:n].astype(np.float32)


def _rss_mb() -> float:
    try:
        pages = int(Path("/proc/self/statm").read_text().split()[1])
        return pages * os.sysconf("SC_PAGE_SIZE") / 2**20
    except (OSError, ValueError, IndexError):
        return float("nan")


def _peak_mb() -> float:
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return peak / 1024 if sys.platform != "darwin" else peak / 2**20


def _cpu(who: int = resource.RUSAGE_SELF) -> float:
    usage = resource.getrusage(who)
    return usage.ru_utime + usage.ru_stime


def _prepare(key: str, settings: Settings, workdir: Path) -> Callable[[Audio], object]:
    """Loads what the stage needs and returns the step to time."""
    from barrefree_analyzer.models import verified_model_path

    if key == "decode":
        from barrefree_analyzer.audio import decode, make_playback_copy, probe

        upload = workdir / "upload.mp3"

        def run_decode(_audio: Audio) -> object:
            info = probe(upload, "mp3")
            decoded = decode(upload, RATE, kind="mp3")
            make_playback_copy(upload, workdir / "audio.mp3", kind="mp3")
            return info, len(decoded)

        return run_decode
    if key == "beats_librosa":
        from barrefree_analyzer.pipeline.beats import LibrosaBeatTracker

        tracker = LibrosaBeatTracker()
        return lambda audio: tracker.track(audio, RATE)
    if key == "beats_beat_this":
        from barrefree_analyzer.pipeline.beats import BeatThisTracker

        beat_this = BeatThisTracker(verified_model_path(settings, "beat_this"))
        return lambda audio: beat_this.track(audio, RATE)
    if key == "chroma_key":
        from barrefree_analyzer.pipeline.key import CqtChroma, KrumhanslKeyEstimator

        chroma, keys = CqtChroma(), KrumhanslKeyEstimator()
        return lambda audio: keys.estimate(chroma.chroma(audio, RATE))
    if key in ("chordino", "btc"):
        from barrefree_analyzer.pipeline.factory import build_recognizer

        recognizer = build_recognizer(key, settings)
        return lambda audio: recognizer.recognize(audio, RATE)
    if key == "separation":
        from barrefree_analyzer.pipeline.separation import DemucsSeparator

        separator = DemucsSeparator(verified_model_path(settings, "htdemucs"))
        return lambda audio: separator.separate(audio, RATE)
    if key == "notes":
        from barrefree_analyzer.pipeline.factory import build_transcriber

        transcriber = build_transcriber(settings)
        return lambda audio: transcriber.transcribe(audio, RATE)
    if key in ("job_default", "job_everything"):
        from barrefree_analyzer.pipeline.factory import build_pipeline
        from barrefree_analyzer.pipeline.separation import CachedSeparator
        from barrefree_analyzer.schema import JobOptions

        # Loaded like the worker loads it (every part this server offers), so the peak memory is
        # the worker's; the stems cache is bypassed so nothing is written to the data folder.
        # The full job turns its parts on even where the server leaves them off: a job asking
        # for a missing part would silently run without it and time something else.
        everything = key == "job_everything"
        if everything:
            recognizers = list(dict.fromkeys(["btc", *settings.recognizers]))
            settings = settings.model_copy(
                update={"recognizers": recognizers, "separation": True, "transcription": True}
            )
        pipeline = build_pipeline(settings)
        if everything:
            missing = [
                name
                for name, part in (
                    ("BTC", pipeline.recognizers.get("btc")),
                    ("separation", pipeline.separator),
                    ("notes", pipeline.transcriber),
                )
                if part is None
            ]
            if missing:
                raise RuntimeError(f"could not load {', '.join(missing)} (see the log above)")
        if isinstance(pipeline.separator, CachedSeparator):
            pipeline.separator = pipeline.separator.inner
        options = (
            JobOptions(recognizer="btc", separate=True, transcribe=True)
            if everything
            else JobOptions()
        )
        return lambda audio: pipeline.run(audio, RATE, options)
    raise ValueError(f"unknown stage {key}")


def run_stage(key: str, audio_path: Path, workdir: Path, repeat: int) -> dict[str, Any]:
    """Child process: load, warm up on 5 s, then time ``repeat`` runs on the whole input."""
    settings = get_settings()
    audio = np.load(audio_path)
    started = time.perf_counter()
    step = _prepare(key, settings, workdir)
    load_sec = time.perf_counter() - started
    step(audio[: 5 * RATE])  # warm-up: lazy initialisation, caches, thread pools
    base_mb = _rss_mb()
    walls, cpus = [], []
    for _ in range(repeat):
        cpu0, children0 = _cpu(), _cpu(resource.RUSAGE_CHILDREN)
        t0 = time.perf_counter()
        step(audio)
        walls.append(time.perf_counter() - t0)
        cpus.append(_cpu() - cpu0 + _cpu(resource.RUSAGE_CHILDREN) - children0)
    return {
        "load_sec": load_sec,
        "wall_sec": median(walls),
        "cpu_sec": median(cpus),
        "base_mb": base_mb,
        "peak_mb": _peak_mb(),
    }


def _missing(stage: Stage, settings: Settings) -> list[str]:
    from barrefree_analyzer.models import model_path
    from barrefree_analyzer.pipeline.chordino import PLUGIN_FILE

    out = []
    for need in stage.needs:
        if need == "chordino":
            if not (settings.vamp_path / PLUGIN_FILE).is_file():
                out.append("Chordino plugin")
        elif not model_path(settings, need).is_file():
            out.append(f"{need} weights")
    return out


def environment() -> dict[str, str]:
    def version(name: str) -> str:
        try:
            return metadata.version(name)
        except metadata.PackageNotFoundError:
            return "-"

    cpu = platform.processor() or platform.machine()
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.startswith("model name"):
                cpu = line.split(":", 1)[1].strip()
                break
    except OSError:
        pass
    usable = len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else os.cpu_count()
    limits = {}
    for name in ("cpu.max", "memory.max"):
        try:
            limits[name] = Path(f"/sys/fs/cgroup/{name}").read_text().strip()
        except OSError:
            limits[name] = "-"
    try:
        import torch

        threads = str(torch.get_num_threads())
    except ImportError:
        threads = "-"
    load = f"{os.getloadavg()[0]:.1f}" if hasattr(os, "getloadavg") else "-"
    return {
        "CPU": cpu,
        "Usable cores": str(usable),
        "Load average at the end (1 min)": load,
        "torch threads": threads,
        "cgroup cpu.max / memory.max": f"{limits['cpu.max']} / {limits['memory.max']}",
        "OS": f"{platform.system()} {platform.release()}",
        "Python": platform.python_version(),
        "Versions": ", ".join(
            f"{p} {version(p)}"
            for p in ("barrefree-analyzer", "torch", "onnxruntime", "demucs", "librosa")
        ),
    }


def report(
    results: dict[float, dict[str, dict[str, Any]]],
    skipped: Sequence[str],
    failed: Sequence[str] = (),
) -> str:
    env = environment()
    lines = [
        "# Benchmarks",
        "",
        "Generated by `barrefree-benchmark` "
        f"({datetime.now(UTC).strftime('%Y-%m-%d')}). Every step ran alone in its own process "
        "on a synthetic busy song (drums, a sung lead and chords) repeated to the length shown, "
        "after its models were loaded and a 5-second warm-up. *Real-time factor* is run time "
        "divided by the song length (below 1 is faster than real time). *Peak memory* is the "
        "process's peak resident memory, models included: what the worker needs for that step. "
        "A job's time is its Decode row plus its Analysis row. Numbers depend on the hardware: "
        "run `barrefree-benchmark` on your own server.",
        "",
        "| Machine | |",
        "| --- | --- |",
        *[f"| {k} | {v} |" for k, v in env.items()],
        "",
    ]
    for minutes, stages in results.items():
        lines += [
            f"## {minutes:g}-minute song",
            "",
            "| Step | Load (s) | Run (s) | CPU (s) | Real-time factor | Peak memory (MB) |",
            "| --- | ---: | ---: | ---: | ---: | ---: |",
        ]
        for key, r in stages.items():
            rtf = r["wall_sec"] / (minutes * 60)
            lines.append(
                f"| {BY_KEY[key].title} | {r['load_sec']:.2f} | {r['wall_sec']:.2f} | "
                f"{r['cpu_sec']:.2f} | {rtf:.3f} | {r['peak_mb']:.0f} |"
            )
        lines.append("")
    if skipped:
        lines += ["Skipped (not installed): " + "; ".join(skipped) + ".", ""]
    if failed:
        lines += ["Failed: " + "; ".join(failed) + ".", ""]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--minutes", default="1,3", help="comma-separated song lengths")
    parser.add_argument("--stages", default="all", help=f"comma-separated: {', '.join(BY_KEY)}")
    parser.add_argument("--repeat", type=int, default=1, help="runs per step (median)")
    parser.add_argument("--out", type=Path, help="write the Markdown report here")
    parser.add_argument("--stage", help=argparse.SUPPRESS)  # child process
    parser.add_argument("--audio", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--workdir", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    if args.stage:
        print(json.dumps(run_stage(args.stage, args.audio, args.workdir, args.repeat)))
        return

    keys = list(BY_KEY) if args.stages == "all" else [s.strip() for s in args.stages.split(",")]
    unknown = [k for k in keys if k not in BY_KEY]
    if unknown:
        parser.error(f"unknown stage(s): {', '.join(unknown)}")
    try:
        lengths = [float(m) for m in args.minutes.split(",") if m.strip()]
    except ValueError:
        parser.error("--minutes takes numbers, e.g. 1,3")
    settings = get_settings()
    skipped = []
    for key in list(keys):
        missing = _missing(BY_KEY[key], settings)
        if missing:
            keys.remove(key)
            skipped.append(f"{BY_KEY[key].title} ({', '.join(missing)})")

    results: dict[float, dict[str, dict[str, Any]]] = {}
    failed: list[str] = []
    with tempfile.TemporaryDirectory(prefix="barrefree-bench-") as tmp:
        work = Path(tmp)
        for minutes in lengths:
            audio_path = work / f"song-{minutes:g}.npy"
            audio = synthetic_audio(minutes)
            np.save(audio_path, audio)
            _write_mp3(audio, work / "upload.mp3")
            results[minutes] = {}
            for key in keys:
                print(f"{minutes:g} min: {BY_KEY[key].title} ...", file=sys.stderr, flush=True)
                cmd = [sys.executable, "-m", "barrefree_analyzer.benchmark", "--stage", key]
                cmd += ["--audio", str(audio_path), "--workdir", str(work)]
                cmd += ["--repeat", str(args.repeat)]
                done = subprocess.run(cmd, capture_output=True, text=True)  # noqa: S603
                if done.returncode != 0:
                    # One failing step (e.g. killed at the memory limit) must not lose the rest.
                    error = (done.stderr.strip().splitlines() or [f"exit {done.returncode}"])[-1]
                    print(done.stderr, file=sys.stderr)
                    failed.append(f"{BY_KEY[key].title}, {minutes:g} min ({error})")
                    continue
                results[minutes][key] = json.loads(done.stdout.strip().splitlines()[-1])
    text = report(results, skipped, failed)
    if args.out:
        args.out.write_text(text + "\n")
        print(f"wrote {args.out}", file=sys.stderr)
    else:
        print(text)
    if failed:
        raise SystemExit(f"{len(failed)} step(s) failed: " + "; ".join(failed))


def _write_mp3(audio: Audio, path: Path) -> None:
    """The decode step's input: a 44.1 kHz stereo MP3, like a typical upload (not timed)."""
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise SystemExit("ffmpeg is needed")
    cmd = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y"]
    cmd += ["-f", "f32le", "-ar", str(RATE), "-ac", "1", "-i", "pipe:0"]
    cmd += ["-ar", "44100", "-ac", "2", "-b:a", "192k", str(path)]
    subprocess.run(cmd, input=audio.tobytes(), check=True)  # noqa: S603


if __name__ == "__main__":
    main()
