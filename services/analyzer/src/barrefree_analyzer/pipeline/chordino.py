"""Chordino (Mauch & Dixon, 2010): NNLS chroma + chord-profile matching + HMM/Viterbi smoothing.

A classic DSP recognizer: no GPU, no model weights, about 100 times faster than real time on a CPU.
It runs as a Vamp plugin (``nnls-chroma.so``, GPL-2.0-or-later, built by
``scripts/build-vamp-plugins.sh``) through the ``vamp`` Python host (MIT).

Its vocabulary covers major, minor, 7, maj7, min7, 6, min6, dim, aug, hdim7 and dim7 chords and
their inversions. With ``usehartesyntax=1`` labels are Harte, except that major chords come out as
a bare root ("C", "C/3"); ``to_harte`` spells them "C:maj", "C:maj/3".

M. Mauch and S. Dixon (2010), "Approximate note transcription for the improved identification of
difficult chords", ISMIR. Plugin: https://github.com/c4dm/nnls-chroma
"""

import os
from pathlib import Path

import numpy as np

from barrefree_analyzer.pipeline.interfaces import Audio, RawChord

PLUGIN_KEY = "nnls-chroma:chordino"
#: The plugin library inside ``Settings.vamp_path``.
PLUGIN_FILE = "nnls-chroma.so"


def to_harte(label: str) -> str:
    """Makes Chordino's major shorthand explicit: "C" → "C:maj", "C/3" → "C:maj/3"."""
    label = label.strip()
    if label in ("", "N", "X"):
        return "N"
    head, slash, bass = label.partition("/")
    if ":" not in head:
        head += ":maj"
    return head + slash + bass


class ChordinoRecognizer:
    name = "chordino"

    def __init__(self, plugin_dir: Path) -> None:
        if not (plugin_dir / PLUGIN_FILE).is_file():
            raise FileNotFoundError(
                f"{PLUGIN_FILE} not found in {plugin_dir}; run scripts/build-vamp-plugins.sh"
            )
        # The host reads VAMP_PATH when it first scans for plugins.
        os.environ["VAMP_PATH"] = str(plugin_dir)
        import vamp
        import vampyhost

        if PLUGIN_KEY not in vamp.list_plugins():
            raise RuntimeError(f"{PLUGIN_KEY} is not loadable from {plugin_dir}")
        self._vamp = vamp
        self._shift_data = vampyhost.SHIFT_DATA

    def recognize(self, audio: Audio, rate: int) -> list[RawChord]:
        duration = len(audio) / rate
        result = self._vamp.collect(
            np.ascontiguousarray(audio, dtype=np.float32),
            rate,
            PLUGIN_KEY,
            "simplechord",
            {"usehartesyntax": 1},
            # Let the host pad the signal so the first frame is centred at 0 s. With the default
            # (shifted timestamps) the first and last labels come out ~0.37 s late, half of the
            # plugin's 16384-sample block.
            process_timestamp_method=self._shift_data,
            # The plugin's defaults (block 16384, step 2048) are tuned for 44.1 kHz. At 22.05 kHz
            # half of each keeps the same time and frequency resolution: on synthetic songs this
            # halves the boundary error (mean -74 ms → -33 ms) at about the same cost.
            step_size=1024,
            block_size=8192,
        )
        events = result.get("list", [])
        times = [min(max(e["timestamp"].to_float(), 0.0), duration) for e in events]
        chords: list[RawChord] = []
        for i, event in enumerate(events):
            start = times[i]
            end = times[i + 1] if i + 1 < len(times) else duration
            if end > start:
                chords.append(RawChord(start, end, to_harte(str(event["label"]))))
        if chords and chords[0].start > 0:
            chords.insert(0, RawChord(0.0, chords[0].start, "N"))
        return chords
