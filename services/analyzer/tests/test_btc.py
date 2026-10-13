import itertools

import numpy as np
import pytest

from barrefree_analyzer.config import Settings
from barrefree_analyzer.evaluation import compare, to_labeled
from barrefree_analyzer.pipeline.btc import FRAME_SEC, NUM_CHORDS, BTCRecognizer, label_of
from barrefree_analyzer.synth import SONGS, render
from tests.conftest import need_model


def test_label_of_covers_the_large_vocabulary() -> None:
    assert label_of(0) == "C:min"
    assert label_of(1) == "C:maj"  # the original writes a bare root for major
    assert label_of(14 * 9 + 9) == "A:7"
    assert label_of(14 * 11 + 11) == "B:hdim7"
    assert label_of(NUM_CHORDS - 2) == "X"
    assert label_of(NUM_CHORDS - 1) == "N"


@pytest.fixture(scope="module")
def btc() -> BTCRecognizer:
    return BTCRecognizer(need_model(Settings(), "btc"))


def test_btc_recognizes_a_synthetic_song(btc: BTCRecognizer) -> None:
    song = render(SONGS[2])  # B minor, G, D, A
    chords = btc.recognize(song.audio, song.rate)
    assert chords[0].start == 0
    assert chords[-1].end == pytest.approx(len(song.audio) / song.rate)
    assert all(a.end == pytest.approx(b.start) for a, b in itertools.pairwise(chords))
    assert all(c.confidence is not None and 0 < c.confidence <= 1 for c in chords)
    tally = compare(to_labeled(song.chords), to_labeled((c.start, c.end, c.label) for c in chords))
    majmin = tally.score("majmin")
    assert majmin is not None
    assert majmin > 0.9


def test_btc_handles_audio_shorter_than_one_hop_and_odd_rates(btc: BTCRecognizer) -> None:
    probs = btc.frame_probabilities(np.zeros(100, dtype=np.float32), 22050)
    assert probs.shape[1] == NUM_CHORDS
    assert np.allclose(probs.sum(axis=1), 1, atol=1e-4)
    tone = np.sin(np.arange(44100) * 2 * np.pi * 220 / 44100).astype(np.float32)
    chords = btc.recognize(tone, 44100)
    assert chords[-1].end == pytest.approx(1.0)
    assert len(chords) <= 1.0 / FRAME_SEC + 1
