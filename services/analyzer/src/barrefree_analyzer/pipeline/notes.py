"""Note transcription with Basic Pitch, run through ONNX Runtime (no TensorFlow).

Bittner, Bosch, Rubinstein, Meseguer-Brocal & Ewert (2022), "A Lightweight Instrument-Agnostic
Model for Polyphonic Note Transcription and Multipitch Estimation", ICASSP. Code and model:
https://github.com/spotify/basic-pitch, Apache License 2.0, Copyright 2022 Spotify AB ("This
product includes software developed at Spotify AB (http://www.spotify.com/)").

The ``basic-pitch`` package cannot be installed here: on Python 3.11+ Linux it requires
TensorFlow < 2.15.1, which has no Python 3.12 wheels. The model itself ships as ONNX
(``nmp.onnx``, 230 KB, downloaded from the v0.4.0 tag with its SHA-256 checked), so this module
ports what surrounds it, changed as follows: the windowing and unwrapping of
``basic_pitch/inference.py`` and the note decoding of ``basic_pitch/note_creation.py``
(``output_to_notes_polyphonic`` with inferred onsets and the "melodia trick") are kept, with
types, and pitch bends and MIDI writing are left out: a tab needs notes, not bends.

The model hears 22.05 kHz mono in 2 s windows (hop 256 samples, 86 frames per second) and
answers, per frame, the activation of each of the 88 piano keys and of note onsets.
"""

from dataclasses import dataclass
from pathlib import Path

import librosa
import numpy as np
import numpy.typing as npt
import scipy.signal

from barrefree_analyzer.pipeline.interfaces import Audio, NoteEvent

RATE = 22050
FFT_HOP = 256
FPS = RATE // FFT_HOP  # 86 frames per second
WINDOW_SEC = 2
FRAMES_PER_WINDOW = FPS * WINDOW_SEC  # 172
WINDOW_SAMPLES = RATE * WINDOW_SEC - FFT_HOP  # 43844
OVERLAP_FRAMES = 30
OVERLAP_SAMPLES = OVERLAP_FRAMES * FFT_HOP
HOP_SAMPLES = WINDOW_SAMPLES - OVERLAP_SAMPLES
MIDI_OFFSET = 21  # the lowest piano key, A0
N_KEYS = 88
_INPUT = "serving_default_input_2:0"
_OUTPUTS = ["StatefulPartitionedCall:1", "StatefulPartitionedCall:2"]  # note, onset


@dataclass(frozen=True)
class NoteSettings:
    """Decoding settings, tuned for guitar on synthetic plucked strings (see the tests).

    Stricter than Basic Pitch's defaults (onset 0.5, frame 0.3): on plucked strings those turn
    one ringing note into several and add harmonics, which a tab cannot show. The range ends at
    C6, above anything played in open position with a capo.
    """

    onset_threshold: float = 0.7
    frame_threshold: float = 0.4
    min_note_ms: float = 127.7
    #: E2 (82 Hz) is the lowest open string; C6 (1047 Hz) is fret 20 on the high E string.
    min_hz: float | None = 75.0
    max_hz: float | None = 1050.0
    energy_tolerance: int = 11
    #: Add onsets where the note activation jumps (Basic Pitch's default).
    infer_onsets: bool = True
    #: Merge a note into the previous one of the same pitch when it starts at most this many
    #: frames after it ends and shows no new attack: one ringing string read as two notes.
    merge_gap_frames: int = 3


def windows(audio: npt.NDArray[np.float32]) -> npt.NDArray[np.float32]:
    """The model's input: overlapping windows, shape (n, WINDOW_SAMPLES, 1)."""
    padded = np.concatenate([np.zeros(OVERLAP_SAMPLES // 2, dtype=np.float32), audio])
    out = []
    for start in range(0, len(padded), HOP_SAMPLES):
        window = padded[start : start + WINDOW_SAMPLES]
        if len(window) < WINDOW_SAMPLES:
            window = np.pad(window, (0, WINDOW_SAMPLES - len(window)))
        out.append(window)
    return np.stack(out)[:, :, None].astype(np.float32)


def unwrap(output: npt.NDArray[np.float32], n_samples: int) -> npt.NDArray[np.float32]:
    """Windowed model output (n, frames, keys) back to one (frames, keys) matrix."""
    half = OVERLAP_FRAMES // 2
    trimmed = output[:, half:-half, :]
    frames = int(np.floor(n_samples * (FPS / RATE)))
    return trimmed.reshape(-1, trimmed.shape[2])[:frames]


def frame_times(n_frames: int) -> npt.NDArray[np.float64]:
    """Frame index to seconds, with Basic Pitch's per-window correction."""
    times = np.arange(n_frames) * FFT_HOP / RATE
    window = np.floor(np.arange(n_frames) / FRAMES_PER_WINDOW)
    offset = (FFT_HOP / RATE) * (FRAMES_PER_WINDOW - WINDOW_SAMPLES / FFT_HOP) + 0.0018
    return np.asarray(times - offset * window, dtype=np.float64)


def _inferred_onsets(
    onsets: npt.NDArray[np.float64], frames: npt.NDArray[np.float64], n_diff: int = 2
) -> npt.NDArray[np.float64]:
    """Onsets plus large rises in frame activation (a re-struck note the onset head missed)."""
    diffs = []
    for n in range(1, n_diff + 1):
        shifted = np.concatenate([np.zeros((n, frames.shape[1])), frames])
        diffs.append(shifted[n:, :] - shifted[:-n, :])
    rise = np.min(diffs, axis=0)
    rise[rise < 0] = 0
    rise[:n_diff, :] = 0
    top = float(np.max(rise))
    if top > 0:
        rise = float(np.max(onsets)) * rise / top
    return np.asarray(np.max([onsets, rise], axis=0), dtype=np.float64)


def _key(hz: float) -> int:
    return int(np.round(librosa.hz_to_midi(hz) - MIDI_OFFSET))


def decode_notes(
    frames_in: npt.NDArray[np.float32],
    onsets_in: npt.NDArray[np.float32],
    settings: NoteSettings = NoteSettings(),  # noqa: B008 - frozen dataclass
) -> list[tuple[int, int, int, float]]:
    """Note events (start frame, end frame, MIDI pitch, amplitude) from the activations."""
    frames = np.asarray(frames_in, dtype=np.float64).copy()
    onsets = np.asarray(onsets_in, dtype=np.float64).copy()
    n_frames = frames.shape[0]
    if n_frames == 0:
        return []
    if settings.max_hz is not None:
        frames[:, _key(settings.max_hz) :] = 0
        onsets[:, _key(settings.max_hz) :] = 0
    if settings.min_hz is not None:
        frames[:, : _key(settings.min_hz)] = 0
        onsets[:, : _key(settings.min_hz)] = 0
    if settings.infer_onsets:
        onsets = _inferred_onsets(onsets, frames)
    min_len = int(np.round(settings.min_note_ms / 1000 * FPS))
    tol, thresh = settings.energy_tolerance, settings.frame_threshold

    peaks = np.zeros(onsets.shape)
    where = scipy.signal.argrelmax(onsets, axis=0)
    peaks[where] = onsets[where]
    starts_t, starts_f = np.where(peaks >= settings.onset_threshold)
    remaining = frames.copy()
    notes: list[tuple[int, int, int, float]] = []

    def clear(t0: int, t1: int, f: int) -> None:
        remaining[t0:t1, f] = 0
        if f < N_KEYS - 1:
            remaining[t0:t1, f + 1] = 0
        if f > 0:
            remaining[t0:t1, f - 1] = 0

    # Latest onsets first, as in Basic Pitch: a later note cannot swallow an earlier one.
    for start, f in zip(starts_t[::-1], starts_f[::-1], strict=True):
        if start >= n_frames - 1:
            continue
        i, k = start + 1, 0
        while i < n_frames - 1 and k < tol:
            k = k + 1 if remaining[i, f] < thresh else 0
            i += 1
        i -= k
        if i - start <= min_len:
            continue
        clear(start, i, f)
        notes.append((int(start), int(i), int(f) + MIDI_OFFSET, float(np.mean(frames[start:i, f]))))

    # "Melodia trick": notes whose onsets were too soft, grown from the strongest frames left.
    while np.max(remaining) > thresh:
        mid, f = (int(v) for v in np.unravel_index(np.argmax(remaining), remaining.shape))
        remaining[mid, f] = 0
        i, k = mid + 1, 0
        while i < n_frames - 1 and k < tol:
            k = k + 1 if remaining[i, f] < thresh else 0
            clear(i, i + 1, f)
            i += 1
        end = i - 1 - k
        i, k = mid - 1, 0
        while i > 0 and k < tol:
            k = k + 1 if remaining[i, f] < thresh else 0
            clear(i, i + 1, f)
            i -= 1
        start = i + 1 + k
        if start < 0 or end >= n_frames:
            continue
        if end - start <= min_len:
            continue
        notes.append((start, end, f + MIDI_OFFSET, float(np.mean(frames[start:end, f]))))
    notes.sort(key=lambda n: (n[0], n[2]))
    if not settings.merge_gap_frames:
        return notes
    return merge_splits(notes, settings.merge_gap_frames, np.asarray(frames_in, dtype=np.float64))


def merge_splits(
    notes: list[tuple[int, int, int, float]],
    gap: int,
    frames: npt.NDArray[np.float64] | None = None,
    attack: float = 1.15,
) -> list[tuple[int, int, int, float]]:
    """Joins back-to-back notes of the same pitch (sorted by start) into one.

    With ``frames``, only when the note activation does not rise at the boundary: a string
    plucked again while it still rings shows a new attack, a ringing note read twice does not.
    """
    last: dict[int, int] = {}  # pitch -> index in out
    out: list[tuple[int, int, int, float]] = []
    for start, end, pitch, amp in notes:
        k = last.get(pitch)
        if k is not None and 0 <= start - out[k][1] <= gap:
            s0, e0, _, a0 = out[k]
            key = pitch - MIDI_OFFSET
            replucked = False
            if frames is not None:
                before = float(np.mean(frames[max(s0, e0 - 3) : e0, key])) if e0 > s0 else 0.0
                after = float(np.max(frames[start : start + 4, key]))
                replucked = after > attack * max(before, 1e-6)
            if not replucked:
                weight = (e0 - s0) / max(e0 - s0 + end - start, 1)
                out[k] = (s0, max(e0, end), pitch, a0 * weight + amp * (1 - weight))
                continue
        last[pitch] = len(out)
        out.append((start, end, pitch, amp))
    return out


class BasicPitchTranscriber:
    name = "basic_pitch"

    def __init__(self, model: Path, settings: NoteSettings | None = None) -> None:
        if not model.is_file():
            raise FileNotFoundError(
                f"Basic Pitch model {model} is missing; run barrefree-download-models"
            )
        import onnxruntime

        self._session = onnxruntime.InferenceSession(str(model), providers=["CPUExecutionProvider"])
        self.settings = settings or NoteSettings()

    def activations(
        self, audio: Audio, rate: int
    ) -> tuple[npt.NDArray[np.float32], npt.NDArray[np.float32]]:
        """Per-frame note and onset activations, shape (frames, 88) each."""
        if rate != RATE:
            audio = librosa.resample(audio, orig_sr=rate, target_sr=RATE)
        batch = windows(np.asarray(audio, dtype=np.float32))
        outputs = [
            self._session.run(_OUTPUTS, {_INPUT: batch[i : i + 1]}) for i in range(len(batch))
        ]
        note = np.concatenate([np.asarray(o[0]) for o in outputs])
        onset = np.concatenate([np.asarray(o[1]) for o in outputs])
        return unwrap(note, len(audio)), unwrap(onset, len(audio))

    def transcribe(self, audio: Audio, rate: int) -> list[NoteEvent]:
        if len(audio) == 0:
            return []
        note, onset = self.activations(audio, rate)
        times = frame_times(note.shape[0] + 1)
        return [
            NoteEvent(
                start=round(float(times[s]), 3),
                end=round(float(times[min(e, len(times) - 1)]), 3),
                midi=pitch,
                velocity=round(min(1.0, max(0.0, amp)), 3),
            )
            for s, e, pitch, amp in decode_notes(note, onset, self.settings)
        ]
