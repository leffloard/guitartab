"""Deterministic synthetic songs with exact ground truth, for tests and evaluation.

No recordings are needed (and none may be committed): each song is rendered from a chord
progression with a small additive synthesizer, so the reference chord labels, beats and key are
known exactly. A song has

- a chord pad: root-position chord tones around middle C plus the root an octave lower, struck
  on every beat (guitar-like attacks give the beat tracker onsets);
- a bass: the root (or the slash bass) in the second octave, on beats 1 and 3;
- optional drums (kick, snare, hi-hat) and a vibrato "vocal" lead playing chord tones, which
  make source separation meaningful. The "busy" variants (``BUSY``) turn both up and give the
  lead a passing note on every off-beat, as a sung melody would: the hard case for chroma-based
  recognizers, and the one separation is meant to help with.

Partials fall off as 1/n, which is enough for chroma-based recognizers.
"""

from dataclasses import dataclass, field, replace
from pathlib import Path

import mir_eval
import numpy as np
import numpy.typing as npt
import soundfile as sf

RATE = 22050


@dataclass(frozen=True)
class SongSpec:
    name: str
    progression: list[str]  # Harte labels, one per bar
    bpm: float
    key: str  # reference key in mir_eval syntax, e.g. "A minor"
    beats_per_bar: int = 4
    drums: bool = False
    lead: bool = False
    seed: int = 0
    drum_gain: float = 1.0
    lead_gain: float = 1.0
    #: The lead moves a whole tone up for the second half of each beat (usually off the chord).
    passing: bool = False


@dataclass(frozen=True)
class SyntheticSong:
    spec: SongSpec
    audio: npt.NDArray[np.float32]
    rate: int
    chords: list[tuple[float, float, str]]
    beats: list[float]
    downbeats: list[float] = field(default_factory=list)

    def lab(self) -> str:
        """The reference annotation in .lab format (start end label, tab-separated)."""
        return "".join(f"{s:.6f}\t{e:.6f}\t{label}\n" for s, e, label in self.chords)


def midi_to_hz(midi: float) -> float:
    return float(440.0 * 2 ** ((midi - 69) / 12))


def chord_midis(label: str) -> tuple[list[int], int]:
    """(pad notes, bass note) for a Harte label: tones from C4 up, bass in octave 2."""
    root, bitmap, bass = mir_eval.chord.encode(label)
    if root < 0:
        return [], -1
    base = 48 + root  # C3..B3: the doubled root
    pad = [base] + [60 + root + i for i in range(12) if bitmap[i]]
    bass_note = 36 + (root + (bass if bass >= 0 else 0)) % 12
    return pad, bass_note


def _tone(
    freq: float, dur: float, rate: int, amp: float, partials: int = 8
) -> npt.NDArray[np.float64]:
    t = np.arange(int(dur * rate)) / rate
    out = np.zeros_like(t)
    for n in range(1, partials + 1):
        if freq * n >= rate / 2:
            break
        out += np.sin(2 * np.pi * freq * n * t) / n
    # Plucked envelope: 5 ms attack, exponential decay, short release.
    env = np.minimum(t / 0.005, 1.0) * np.exp(-t * 1.6)
    tail = int(0.03 * rate)
    if len(env) > tail:
        env[-tail:] *= np.linspace(1.0, 0.0, tail)
    return np.asarray(amp * out * env, dtype=np.float64)


def _noise(
    dur: float, rate: int, rng: np.random.Generator, decay: float
) -> npt.NDArray[np.float64]:
    n = int(dur * rate)
    t = np.arange(n) / rate
    return rng.standard_normal(n) * np.exp(-t * decay)


def _add(buf: npt.NDArray[np.float64], at: float, sig: npt.NDArray[np.float64], rate: int) -> None:
    i = round(at * rate)
    j = min(len(buf), i + len(sig))
    if i < j:
        buf[i:j] += sig[: j - i]


def _voice(midi: int, seconds: float, rate: int) -> npt.NDArray[np.float64]:
    """A sung-like tone: three harmonics, 5.5 Hz vibrato, 40 ms attack."""
    t = np.arange(int(seconds * rate)) / rate
    vib = 0.004 * np.sin(2 * np.pi * 5.5 * t)
    phase = 2 * np.pi * np.cumsum(midi_to_hz(midi) * (1 + vib)) / rate
    voice = (np.sin(phase) + 0.3 * np.sin(2 * phase) + 0.15 * np.sin(3 * phase)) * np.minimum(
        t / 0.04, 1.0
    )
    return np.asarray(voice, dtype=np.float64)


def render(spec: SongSpec, rate: int = RATE) -> SyntheticSong:
    rng = np.random.default_rng(spec.seed)
    beat = 60.0 / spec.bpm
    bar = beat * spec.beats_per_bar
    lead_in = 0.5  # half a second of silence, as real recordings have
    total = lead_in + bar * len(spec.progression) + 1.0
    buf = np.zeros(int(total * rate))
    chords: list[tuple[float, float, str]] = []
    beats: list[float] = []
    downbeats: list[float] = []
    if lead_in > 0:
        chords.append((0.0, lead_in, "N"))
    for b, label in enumerate(spec.progression):
        start = lead_in + b * bar
        chords.append((start, start + bar, label))
        pad, bass = chord_midis(label)
        for k in range(spec.beats_per_bar):
            at = start + k * beat
            beats.append(at)
            if k == 0:
                downbeats.append(at)
            accent = 1.0 if k == 0 else 0.75
            for m in pad:
                _add(buf, at, _tone(midi_to_hz(m), beat * 0.98, rate, 0.12 * accent), rate)
            if bass >= 0 and k % 2 == 0:
                _add(buf, at, _tone(midi_to_hz(bass), beat * 1.9, rate, 0.30, partials=6), rate)
            if spec.drums:
                if k % 2 == 0:
                    t = np.arange(int(0.12 * rate)) / rate
                    kick = np.sin(2 * np.pi * (50 + 70 * np.exp(-t * 40)) * t) * np.exp(-t * 25)
                    _add(buf, at, 0.6 * spec.drum_gain * kick, rate)
                else:
                    _add(buf, at, 0.25 * spec.drum_gain * _noise(0.15, rate, rng, 30), rate)
                for half in (0.0, 0.5):
                    _add(
                        buf,
                        at + half * beat,
                        0.06 * spec.drum_gain * np.diff(_noise(0.04, rate, rng, 120), prepend=0),
                        rate,
                    )
            if spec.lead and pad:
                note = pad[1 + (k % (len(pad) - 1))] + 12
                parts = [(0.0, note, 0.95)] if not spec.passing else [(0.0, note, 0.48)]
                if spec.passing:
                    parts.append((0.5, note + 2, 0.45))
                for offset, midi, length in parts:
                    _add(
                        buf,
                        at + offset * beat,
                        0.10 * spec.lead_gain * _voice(midi, beat * length, rate),
                        rate,
                    )
    end = lead_in + bar * len(spec.progression)
    chords.append((end, total, "N"))
    # Stop the sound at the end of the last bar (50 ms fade), so the closing "N" is true silence.
    fade = int(0.05 * rate)
    i = round(end * rate)
    buf[i - fade : i] *= np.linspace(1.0, 0.0, fade)
    buf[i:] = 0.0
    peak = float(np.max(np.abs(buf))) or 1.0
    audio = (0.9 * buf / peak).astype(np.float32)
    return SyntheticSong(spec, audio, rate, chords, beats, downbeats)


#: The evaluation set: keys across the circle of fifths, major and minor, sevenths, slash
#: chords, 3/4 time, and a range of tempos. Progressions are common harmonic formulas.
SONGS: list[SongSpec] = [
    SongSpec(
        "c-major-pop", ["C:maj", "G:maj", "A:min", "F:maj"] * 2, key="C major", bpm=100, seed=1
    ),
    SongSpec(
        "a-minor-ballad", ["A:min", "F:maj", "C:maj", "G:maj"] * 2, key="A minor", bpm=72, seed=2
    ),
    SongSpec(
        "bm-barre-test", ["B:min", "G:maj", "D:maj", "A:maj"] * 2, key="B minor", bpm=120, seed=3
    ),
    SongSpec(
        "f-major-sevenths", ["F:maj7", "D:min7", "G:min7", "C:7"] * 2, key="F major", bpm=90, seed=4
    ),
    SongSpec(
        "e-minor-waltz",
        ["E:min", "C:maj", "G:maj", "D:maj"] * 2,
        key="E minor",
        bpm=132,
        beats_per_bar=3,
        seed=5,
    ),
    SongSpec(
        "eb-major-drums",
        ["Eb:maj", "Bb:maj", "C:min", "Ab:maj"] * 2,
        key="Eb major",
        bpm=110,
        drums=True,
        seed=6,
    ),
    SongSpec(
        "d-major-lead",
        ["D:maj", "B:min", "G:maj", "A:7"] * 2,
        key="D major",
        bpm=96,
        lead=True,
        seed=7,
    ),
    SongSpec(
        "g-major-slash",
        ["G:maj", "D:maj/3", "E:min", "C:maj", "G:maj/5", "D:maj", "G:maj", "G:maj"],
        key="G major",
        bpm=84,
        seed=8,
    ),
    SongSpec(
        "f-sharp-minor-full",
        ["F#:min", "D:maj", "A:maj", "E:maj"] * 2,
        key="F# minor",
        bpm=126,
        drums=True,
        lead=True,
        seed=9,
    ),
    SongSpec(
        "bb-blues",
        ["Bb:7", "Eb:7", "Bb:7", "F:7", "Eb:7", "Bb:7", "F:7", "Bb:7"],
        key="Bb major",
        bpm=104,
        seed=10,
    ),
]


#: The same songs with loud drums and a loud lead that sings passing notes.
BUSY: list[SongSpec] = [
    replace(
        spec,
        name=f"{spec.name}-busy",
        drums=True,
        lead=True,
        drum_gain=2.5,
        lead_gain=4.0,
        passing=True,
    )
    for spec in SONGS
]


def write_dataset(
    out_dir: Path, songs: list[SongSpec] | None = None, rate: int = RATE
) -> list[Path]:
    """Writes <name>.wav and <name>.lab for every song; returns the wav paths."""
    out_dir.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    for spec in songs or SONGS:
        song = render(spec, rate)
        wav = out_dir / f"{spec.name}.wav"
        sf.write(wav, song.audio, rate, subtype="PCM_16")
        (out_dir / f"{spec.name}.lab").write_text(song.lab(), encoding="utf-8")
        paths.append(wav)
    return paths
