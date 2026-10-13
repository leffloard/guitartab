import numpy as np
import pytest

from barrefree_analyzer.config import Settings
from barrefree_analyzer.evaluation import compare, key_score, to_labeled
from barrefree_analyzer.pipeline.chordino import ChordinoRecognizer, to_harte
from barrefree_analyzer.pipeline.factory import build_pipeline
from barrefree_analyzer.pipeline.interfaces import BeatGrid, Chromagram, RawChord
from barrefree_analyzer.pipeline.key import KrumhanslKeyEstimator, tonic_evidence
from barrefree_analyzer.pipeline.postprocess import (
    chord_template,
    chroma_confidence,
    drop_short,
    mark_silence,
    merge_repeats,
    postprocess,
    silent_runs,
    snap_to_beats,
)
from barrefree_analyzer.pipeline.run import tempo_from_beats, time_signature
from barrefree_analyzer.schema import JobOptions
from barrefree_analyzer.synth import RATE, SONGS, SongSpec, render


def chords(*rows: tuple[float, float, str]) -> list[RawChord]:
    return [RawChord(s, e, label) for s, e, label in rows]


def spans(cs: list[RawChord]) -> list[tuple[float, float, str]]:
    return [(round(c.start, 3), round(c.end, 3), c.label) for c in cs]


def test_to_harte_spells_chordino_majors() -> None:
    assert [to_harte(x) for x in ["C", "C/3", "A:min", "G:7/3", "N", "", "B:hdim7/b7"]] == [
        "C:maj",
        "C:maj/3",
        "A:min",
        "G:7/3",
        "N",
        "N",
        "B:hdim7/b7",
    ]


def test_merge_and_snap_respect_the_tolerance() -> None:
    raw = chords((0, 1, "C:maj"), (1, 2.07, "C:maj"), (2.07, 4.4, "G:maj"), (4.4, 6, "A:min"))
    assert spans(merge_repeats(raw)) == [
        (0, 2.07, "C:maj"),
        (2.07, 4.4, "G:maj"),
        (4.4, 6, "A:min"),
    ]
    beats = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 5.0]
    # 2.07 snaps to 2.0; 4.4 is 0.6 s from the nearest beat: the grid is wrong there, keep it.
    assert spans(snap_to_beats(merge_repeats(raw), beats)) == [
        (0, 2.0, "C:maj"),
        (2.0, 4.4, "G:maj"),
        (4.4, 6, "A:min"),
    ]


def test_drop_short_prefers_the_neighbor_with_the_same_label() -> None:
    raw = chords(
        (0, 2, "C:maj"), (2, 2.2, "F:maj"), (2.2, 4, "G:maj"), (4, 4.1, "G:maj"), (4.1, 6, "C:maj")
    )
    assert spans(drop_short(raw, 0.5)) == [
        (0, 2.2, "C:maj"),
        (2.2, 4.1, "G:maj"),
        (4.1, 6, "C:maj"),
    ]


def test_mark_silence_relabels_lead_in_pauses_and_tail() -> None:
    raw = chords((0, 3, "C:maj"), (3, 9, "G:maj"))
    assert spans(mark_silence(raw, [(0, 0.5), (4.0, 5.5), (8.0, 9)])) == [
        (0, 0.5, "N"),
        (0.5, 3, "C:maj"),
        (3, 4.0, "G:maj"),
        (4.0, 5.5, "N"),
        (5.5, 8.0, "G:maj"),
        (8.0, 9, "N"),
    ]
    # A run that ends exactly on a chord boundary leaves no zero-length piece behind.
    assert spans(mark_silence(raw, [(2.0, 3.0)])) == [
        (0, 2.0, "C:maj"),
        (2.0, 3, "N"),
        (3, 9, "G:maj"),
    ]


def tone(seconds: float) -> np.ndarray:
    n = round(seconds * RATE)
    return (0.5 * np.sin(np.arange(n) * 2 * np.pi * 440 / RATE)).astype(np.float32)


def test_silent_runs_find_the_lead_in_the_pauses_and_the_tail() -> None:
    gap = np.zeros(int(1.5 * RATE), dtype=np.float32)
    blip = np.zeros(int(0.3 * RATE), dtype=np.float32)
    audio = np.concatenate([np.zeros(RATE, dtype=np.float32), tone(2), gap, tone(1), blip, tone(1)])
    audio = np.concatenate([audio, np.zeros(RATE // 2, dtype=np.float32)])
    runs = silent_runs(audio, RATE)
    assert len(runs) == 3  # the 0.3 s blip is shorter than a pause
    (lead, pause, tail) = runs
    assert lead[0] == 0
    assert lead[1] == pytest.approx(1.0, abs=0.03)
    assert pause[0] == pytest.approx(3.0, abs=0.03)
    assert pause[1] == pytest.approx(4.5, abs=0.03)
    assert tail[0] == pytest.approx(6.8, abs=0.03)
    assert tail[1] == pytest.approx(len(audio) / RATE)
    assert silent_runs(np.zeros(RATE, dtype=np.float32), RATE) == [(0.0, 1.0)]
    assert silent_runs(np.zeros(0, dtype=np.float32), RATE) == []


def test_silent_runs_count_the_final_partial_block() -> None:
    # 1 s of tone, then 600 samples of silence: the last block holds 122 silent samples.
    audio = np.concatenate([tone(1.0), np.zeros(600, dtype=np.float32)])
    assert silent_runs(audio, RATE) == [(44 * 512 / RATE, len(audio) / RATE)]
    # Music to the last sample: no tail run past the end.
    assert silent_runs(tone(1.0), RATE) == []


def test_chroma_confidence_separates_clear_from_ambiguous() -> None:
    c_major = np.asarray(chord_template("C:maj"))
    assert chroma_confidence("C:maj", c_major) > 0.9
    assert chroma_confidence("G:maj", c_major) < 0.1
    # C and E only: C major and A minor fit about as well as each other.
    ambiguous = np.zeros(12)
    ambiguous[[0, 4]] = 1.0
    assert chroma_confidence("C:maj", ambiguous) < 0.6
    assert chroma_confidence("N", np.zeros(12)) == 1.0
    assert chroma_confidence("N", c_major) < 0.2


def test_postprocess_end_to_end_on_a_toy_example() -> None:
    times = np.arange(0, 6, 0.1)
    values = np.tile(np.asarray(chord_template("C:maj")), (len(times), 1))
    out = postprocess(
        chords((0, 0.3, "N"), (0.3, 3.1, "C:maj"), (3.1, 3.2, "D:min"), (3.2, 6, "C:maj")),
        [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5],
        Chromagram(times=times, values=values),
        silences=[(0, 0.5), (5.5, 6)],
    )
    assert [(s.start, s.end, s.label) for s in out] == [
        (0, 0.5, "N"),
        (0.5, 5.5, "C:maj"),
        (5.5, 6, "N"),
    ]
    assert out[1].confidence > 0.9


def test_postprocess_keeps_one_beat_chords_at_fast_tempos() -> None:
    # 150 bpm: a beat is 0.4 s, below the 0.5 s used without a beat grid.
    beats = [0.4 * i for i in range(16)]
    raw = chords((0, 2.0, "C:maj"), (2.0, 2.4, "F:maj"), (2.4, 6.0, "G:maj"))
    out = postprocess(raw, beats, None)
    assert [s.label for s in out] == ["C:maj", "F:maj", "G:maj"]
    assert [s.label for s in postprocess(raw, [], None)] == ["C:maj", "G:maj"]


def test_tempo_and_time_signature_from_the_grid() -> None:
    beats = [0.5 + 0.5 * i for i in range(13)]
    assert tempo_from_beats(beats) == 120.0
    assert time_signature(BeatGrid(beats, downbeats=beats[::3])) == "3/4"
    assert time_signature(BeatGrid(beats, downbeats=beats[::4])) == "4/4"
    assert time_signature(BeatGrid(beats)) is None
    assert tempo_from_beats([1.0]) is None


def test_key_estimation_uses_the_tonic_chord_for_relative_keys() -> None:
    a_minor_chords = [
        (0, 4, "A:min"),
        (4, 6, "F:maj"),
        (6, 8, "C:maj"),
        (8, 10, "G:maj"),
        (10, 14, "A:min"),
    ]
    assert tonic_evidence(a_minor_chords, 9, "minor") > tonic_evidence(a_minor_chords, 0, "major")
    # A C-major scale chroma: without chords it reads C major, with these chords A minor.
    chroma = np.zeros(12)
    chroma[[0, 2, 4, 5, 7, 9, 11]] = 1.0
    chroma[[0, 4, 7]] += 1.0  # the C major triad stands out
    gram = Chromagram(times=np.zeros(1), values=chroma[None, :])
    est = KrumhanslKeyEstimator()
    plain = est.estimate(gram)
    assert plain is not None
    assert (plain.tonic, plain.mode) == (0, "major")
    informed = est.estimate(gram, a_minor_chords)
    assert informed is not None
    assert (informed.tonic, informed.mode) == (9, "minor")
    assert 0 < informed.confidence <= 1
    assert est.estimate(Chromagram(times=np.zeros(1), values=np.ones((1, 12)))) is None


def test_no_key_for_noise_or_when_no_chord_was_heard() -> None:
    est = KrumhanslKeyEstimator()
    rng = np.random.default_rng(2)
    # Per-frame max-normalized noise chroma: never exactly flat, but nearly.
    frames = rng.uniform(0.9, 1.0, size=(400, 12))
    noise = Chromagram(
        times=np.asarray(np.arange(400) * 0.1, dtype=np.float64),
        values=frames / frames.max(axis=1)[:, None],
    )
    assert est.estimate(noise) is None
    c_major = np.tile(np.asarray(chord_template("C:maj")), (10, 1))
    music = Chromagram(times=np.asarray(np.arange(10) * 0.1, dtype=np.float64), values=c_major)
    assert est.estimate(music) is not None
    assert est.estimate(music, [(0.0, 1.0, "N")]) is None


def test_synthetic_songs_are_deterministic_and_annotated() -> None:
    spec = SongSpec("t", ["C:maj", "G:7/3"], bpm=120, key="C major", drums=True, lead=True, seed=3)
    a, b = render(spec), render(spec)
    assert np.array_equal(a.audio, b.audio)
    assert a.chords == [(0.0, 0.5, "N"), (0.5, 2.5, "C:maj"), (2.5, 4.5, "G:7/3"), (4.5, 5.5, "N")]
    assert a.lab().splitlines()[1] == "0.500000\t2.500000\tC:maj"
    assert len(a.beats) == 8
    assert a.downbeats == [0.5, 2.5]
    assert float(np.max(np.abs(a.audio[int(4.6 * RATE) :]))) == 0.0


def test_evaluation_pools_by_duration() -> None:
    ref = to_labeled([(0, 2, "C:maj"), (2, 4, "G:7"), (4, 6, "A:min")])
    est = to_labeled([(0, 2, "C:maj"), (2, 4, "G:maj"), (4, 6, "C:maj")])
    tally = compare(ref, est)
    assert tally.score("root") == pytest.approx(4 / 6)
    assert tally.score("majmin") == pytest.approx(4 / 6)  # G:7 is compared as its G major triad
    assert tally.score("sevenths") == pytest.approx(2 / 6)
    assert key_score("A minor", "C major") == pytest.approx(0.3)
    assert key_score("A minor", None) == 0.0


def test_chordino_recognizes_a_synthetic_progression(vamp_dir: object) -> None:
    song = render(SongSpec("t", ["C:maj", "A:min", "F:maj", "G:7"], bpm=100, key="C major"))
    recognizer = ChordinoRecognizer(Settings().vamp_path)
    labels = [c.label for c in merge_repeats(recognizer.recognize(song.audio, song.rate))]
    assert labels == ["N", "C:maj", "A:min", "F:maj", "G:7", "N"]


def test_acceptance_synthetic_majmin_at_least_90_percent(pipeline_settings: Settings) -> None:
    """M3 acceptance: the full pipeline scores majmin >= 90% on the synthetic songs."""
    pipeline = build_pipeline(pipeline_settings)
    assert pipeline.beat_tracker.name == "beat_this"
    pooled = None
    for spec in SONGS:
        song = render(spec)
        result = pipeline.run(song.audio, song.rate, JobOptions())
        tally = compare(
            to_labeled(song.chords), to_labeled((c.start, c.end, c.label) for c in result.chords)
        )
        if pooled is None:
            pooled = tally
        else:
            pooled.add(tally)
    assert pooled is not None
    majmin = pooled.score("majmin")
    assert majmin is not None
    assert majmin >= 0.90, f"majmin {majmin:.3f}"


def test_full_pipeline_with_btc_after_separation(pipeline_settings: Settings) -> None:
    pipeline = build_pipeline(pipeline_settings)
    song = render(SONGS[8])  # drums and a lead
    result = pipeline.run(song.audio, song.rate, JobOptions(recognizer="btc", separate=True))
    assert result.meta.recognizer == "btc"
    assert result.meta.separated is True
    tally = compare(
        to_labeled(song.chords), to_labeled((c.start, c.end, c.label) for c in result.chords)
    )
    majmin = tally.score("majmin")
    assert majmin is not None
    assert majmin > 0.9
