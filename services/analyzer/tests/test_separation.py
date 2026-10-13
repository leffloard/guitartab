import os
import time
from pathlib import Path

import numpy as np
import pytest

from barrefree_analyzer.config import Settings
from barrefree_analyzer.pipeline.interfaces import Audio, Stems
from barrefree_analyzer.pipeline.separation import CachedSeparator, DemucsSeparator
from barrefree_analyzer.synth import SONGS, render
from tests.conftest import need_model


class CountingSeparator:
    name = "fake"

    def __init__(self) -> None:
        self.calls = 0

    def separate(self, audio: Audio, rate: int) -> Stems:
        self.calls += 1
        return Stems(rate=rate, harmonic=audio * 0.5, other=audio * 0.25)


def test_cache_reuses_stems_for_the_same_input_and_expires(tmp_path: Path) -> None:
    inner = CountingSeparator()
    cache = CachedSeparator(inner, tmp_path / "stems", ttl_sec=60)  # type: ignore[arg-type]
    audio = np.linspace(-1, 1, 1000, dtype=np.float32)
    first = cache.separate(audio, 22050)
    second = cache.separate(audio, 22050)
    assert inner.calls == 1
    assert np.array_equal(first.harmonic, second.harmonic)
    cache.separate(audio[::-1].copy(), 22050)
    assert inner.calls == 2
    # Entries past the TTL are removed; a damaged entry is recomputed.
    entries = sorted((tmp_path / "stems").glob("*.npz"))
    assert len(entries) == 2
    old = time.time() - 120
    os.utime(entries[0], (old, old))
    cache.prune()
    assert len(list((tmp_path / "stems").glob("*.npz"))) == 1
    for entry in (tmp_path / "stems").glob("*.npz"):
        entry.write_bytes(b"broken")
    cache.separate(audio, 22050)
    cache.separate(audio[::-1].copy(), 22050)
    assert inner.calls == 4


@pytest.fixture(scope="module")
def demucs() -> DemucsSeparator:
    return DemucsSeparator(need_model(Settings(), "htdemucs"))


def test_demucs_removes_drums_from_the_harmonic_stem(demucs: DemucsSeparator) -> None:
    song = render(SONGS[5])  # with drums
    audio = song.audio[: 6 * song.rate]
    stems = demucs.separate(audio, song.rate)
    assert stems.rate == song.rate
    assert stems.harmonic.shape == audio.shape
    assert stems.other.shape == audio.shape
    assert stems.harmonic.dtype == np.float32
    # Same input, same output: no random shifts.
    again = demucs.separate(audio, song.rate)
    assert np.array_equal(stems.harmonic, again.harmonic)

    # Drums are broadband: removing them lowers the energy above 5 kHz much more than the
    # energy of the chord tones below 1 kHz.
    def band(x: np.ndarray, lo: float, hi: float) -> float:
        spectrum = np.abs(np.fft.rfft(x)) ** 2
        freqs = np.fft.rfftfreq(len(x), 1 / song.rate)
        return float(spectrum[(freqs >= lo) & (freqs < hi)].sum())

    high = band(stems.harmonic, 5000, 11000) / band(audio, 5000, 11000)
    low = band(stems.harmonic, 60, 1000) / band(audio, 60, 1000)
    assert high < 0.3 * low
