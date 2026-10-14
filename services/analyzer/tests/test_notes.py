import mir_eval
import numpy as np
import numpy.typing as npt
import pytest

from barrefree_analyzer.config import Settings
from barrefree_analyzer.pipeline.notes import (
    FPS,
    MIDI_OFFSET,
    WINDOW_SAMPLES,
    BasicPitchTranscriber,
    NoteSettings,
    decode_notes,
    frame_times,
    merge_splits,
    unwrap,
    windows,
)
from barrefree_analyzer.synth import ARPEGGIO, RATE, ArpeggioSpec, render_arpeggio
from tests.conftest import need_model


def test_windows_cover_the_audio_and_unwrap_back_to_its_length() -> None:
    audio = np.ones(RATE * 5, dtype=np.float32)
    batch = windows(audio)
    assert batch.shape[1:] == (WINDOW_SAMPLES, 1)
    frames = np.ones((len(batch), 172, 88), dtype=np.float32)
    rows = unwrap(frames, len(audio)).shape[0]
    assert rows >= 5 * FPS
    # The frames reach the end of the audio, and no further than one frame past it.
    assert 5 - 1 / FPS <= frame_times(rows)[-1] <= 5 + 1 / FPS


Matrix = npt.NDArray[np.float32]


def activation(
    n_frames: int, notes: list[tuple[int, int, int]], level: float = 0.9
) -> tuple[Matrix, Matrix]:
    frames = np.zeros((n_frames, 88), dtype=np.float32)
    onsets = np.zeros((n_frames, 88), dtype=np.float32)
    for start, end, midi in notes:
        frames[start:end, midi - MIDI_OFFSET] = level
        onsets[start, midi - MIDI_OFFSET] = level
    return frames, onsets


def test_decode_finds_notes_and_keeps_to_the_guitar_range() -> None:
    frames, onsets = activation(200, [(10, 60, 48), (30, 90, 64), (100, 140, 100), (150, 154, 52)])
    found = decode_notes(frames, onsets)
    # The 100 (above C6) is out of range; the 4-frame note is shorter than the minimum.
    assert [(s, p) for s, _e, p, _a in found] == [(10, 48), (30, 64)]
    assert decode_notes(np.zeros((0, 88), np.float32), np.zeros((0, 88), np.float32)) == []


def test_merge_joins_a_ringing_note_read_twice_but_keeps_a_new_pluck() -> None:
    frames = np.zeros((100, 88))
    frames[10:60, 48 - MIDI_OFFSET] = 0.5
    # C3 rings while E3 is plucked at frame 31: the onset head fires on both strings.
    split = [(10, 30, 48, 0.5), (31, 60, 48, 0.5), (32, 60, 52, 0.5)]
    assert merge_splits(split, 3, frames) == [(10, 60, 48, 0.5), (32, 60, 52, 0.5)]
    assert merge_splits(split, 0, None) == split
    frames[31:35, 48 - MIDI_OFFSET] = 0.9  # a new attack on the C3 string itself
    assert merge_splits(split, 3, frames) == split
    # The same string plucked again with nothing else starting: two notes, attack or not.
    frames[31:35, 48 - MIDI_OFFSET] = 0.5
    assert merge_splits(split[:2], 3, frames) == split[:2]


@pytest.fixture(scope="module")
def transcriber() -> BasicPitchTranscriber:
    return BasicPitchTranscriber(need_model(Settings(), "basic_pitch"))


def hz(midis: list[int]) -> npt.NDArray[np.float64]:
    return np.asarray(440.0 * 2 ** ((np.asarray(midis, dtype=np.float64) - 69) / 12))


def score(
    reference: list[tuple[float, float, int]], estimate: list[tuple[float, float, int]]
) -> tuple[float, float, float]:
    ref_i = np.array([[s, e] for s, e, _ in reference])
    est_i = np.array([[s, max(e, s + 0.01)] for s, e, _ in estimate]).reshape(-1, 2)
    p, r, f, _ = mir_eval.transcription.precision_recall_f1_overlap(
        ref_i,
        hz([m for *_, m in reference]),
        est_i,
        hz([m for *_, m in estimate]),
        offset_ratio=None,
    )
    return float(p), float(r), float(f)


def test_transcribes_a_plucked_arpeggio(transcriber: BasicPitchTranscriber) -> None:
    """M7 acceptance (notes): a finger-picked arpeggio comes back nearly note for note."""
    audio, reference = render_arpeggio(ARPEGGIO)
    notes = transcriber.transcribe(audio, RATE)
    precision, recall, f1 = score(reference, [(n.start, n.end, n.midi) for n in notes])
    assert recall >= 0.9, (precision, recall, f1)
    assert f1 >= 0.8, (precision, recall, f1)
    # Basic Pitch's own thresholds read the same strings as far more notes.
    loose = BasicPitchTranscriber(
        need_model(Settings(), "basic_pitch"),
        NoteSettings(onset_threshold=0.5, frame_threshold=0.3, merge_gap_frames=0),
    ).transcribe(audio, RATE)
    assert len(loose) > len(notes)


def test_repeated_notes_on_a_ringing_string_stay_separate(
    transcriber: BasicPitchTranscriber,
) -> None:
    """A bass note plucked again and again while it rings (alternating-bass style).

    Scores vary with the synthetic plucks, so the mean over six renderings is asserted (recall
    0.66-0.91 across them; merging on the attack alone found a third to half of the plucks).
    """
    shapes = [[45] * 8, [52] * 8, [57] * 8, [40] * 8]
    scores = []
    for seed in range(1, 7):
        spec = ArpeggioSpec("repeated", shapes, bpm=100, steps_per_beat=2, ring=1.0, seed=seed)
        audio, reference = render_arpeggio(spec)
        notes = transcriber.transcribe(audio, RATE)
        scores.append(score(reference, [(n.start, n.end, n.midi) for n in notes]))
    recall = float(np.mean([r for _, r, _ in scores]))
    f1 = float(np.mean([f for _, _, f in scores]))
    assert recall >= 0.75, scores
    assert f1 >= 0.8, scores


def test_the_end_of_a_long_song_is_transcribed(transcriber: BasicPitchTranscriber) -> None:
    from barrefree_analyzer.synth import pluck

    seconds = 240
    audio = np.zeros(seconds * RATE, dtype=np.float32)
    rng = np.random.default_rng(0)
    for at in (seconds - 4.0, seconds - 1.4, seconds - 0.8):
        tone = pluck(64, 0.6, RATE, rng).astype(np.float32)
        i = int(at * RATE)
        audio[i : i + len(tone)] += tone[: len(audio) - i]
    starts = sorted(n.start for n in transcriber.transcribe(audio, RATE) if n.midi == 64)
    # Upstream's frame count stopped at 238.4 s and lost the last two.
    assert len(starts) == 3, starts
    assert abs(starts[-1] - (seconds - 0.8)) < 0.05, starts


def test_silence_has_no_notes(transcriber: BasicPitchTranscriber) -> None:
    assert transcriber.transcribe(np.zeros(RATE * 3, dtype=np.float32), RATE) == []
    assert transcriber.transcribe(np.zeros(0, dtype=np.float32), RATE) == []
