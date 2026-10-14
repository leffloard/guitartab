import json
import os
import threading
import time
from collections.abc import Callable
from pathlib import Path

import numpy as np
import pytest
import torch

from barrefree_analyzer.config import Settings
from barrefree_analyzer.pipeline.interfaces import Audio, Stems
from barrefree_analyzer.pipeline.separation import (
    HARMONIC_STEMS,
    CachedSeparator,
    DemucsSeparator,
    load_htdemucs,
    resample,
)
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


@pytest.mark.parametrize("seconds", [0.5, 30, 61.37, 95])
def test_blockwise_resampling_equals_one_pass(seconds: float) -> None:
    from demucs.audio import convert_audio

    rng = np.random.default_rng(0)
    x = torch.from_numpy(rng.standard_normal(int(seconds * 22050)).astype(np.float32))[None]
    up = convert_audio(x, 22050, 44100, 1)
    assert torch.equal(resample(x, 22050, 44100, block_sec=7), up)
    assert torch.equal(resample(up, 44100, 22050, block_sec=7), convert_audio(up, 44100, 22050, 1))


def damage(kind: str) -> Callable[[Path], None]:
    def apply(entry: Path) -> None:
        data = entry.read_bytes()
        if kind == "empty":
            entry.write_bytes(b"")
        elif kind == "truncated":
            entry.write_bytes(data[: len(data) // 2])
        elif kind == "flipped":  # a bit flip inside the array data: bad CRC
            entry.write_bytes(data[:200] + bytes([data[200] ^ 0xFF]) + data[201:])
        elif kind == "wrong-arrays":
            with entry.open("wb") as f:
                np.savez(f, harmonic=np.zeros(1000, np.float32))
        elif kind == "wrong-length":
            with entry.open("wb") as f:
                np.savez(f, harmonic=np.zeros(10, np.float32), other=np.zeros(10, np.float32))
        elif kind == "wrong-dtype":
            with entry.open("wb") as f:
                np.savez(f, harmonic=np.zeros(1000), other=np.zeros(1000))

    return apply


@pytest.mark.parametrize(
    "kind", ["empty", "truncated", "flipped", "wrong-arrays", "wrong-length", "wrong-dtype"]
)
def test_a_damaged_cache_entry_is_computed_again(tmp_path: Path, kind: str) -> None:
    inner = CountingSeparator()
    cache = CachedSeparator(inner, tmp_path / "stems", ttl_sec=60)  # type: ignore[arg-type]
    audio = np.linspace(-1, 1, 1000, dtype=np.float32)
    cache.separate(audio, 22050)
    (entry,) = (tmp_path / "stems").glob("*.npz")
    damage(kind)(entry)
    stems = cache.separate(audio, 22050)
    assert inner.calls == 2
    assert np.array_equal(stems.harmonic, audio * 0.5)
    # ... and the entry was written again, intact.
    assert cache.separate(audio, 22050).harmonic.shape == (1000,)
    assert inner.calls == 2


def test_concurrent_writers_of_one_entry_both_succeed(tmp_path: Path) -> None:
    both_separated = threading.Barrier(2)

    class Slow(CountingSeparator):
        def separate(self, audio: Audio, rate: int) -> Stems:
            both_separated.wait(timeout=10)  # both workers missed the cache
            return super().separate(audio, rate)

    audio = np.linspace(-1, 1, 1000, dtype=np.float32)
    errors: list[BaseException] = []

    def work() -> None:
        try:
            cache = CachedSeparator(Slow(), tmp_path / "stems", ttl_sec=60)  # type: ignore[arg-type]
            cache.separate(audio, 22050)
        except BaseException as exc:  # reported below
            errors.append(exc)

    threads = [threading.Thread(target=work) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=20)
    assert errors == []
    assert [p.name.endswith(".npz") for p in (tmp_path / "stems").iterdir()] == [True]


def test_a_cache_that_cannot_be_written_does_not_fail_the_separation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def full_disk(*_args: object, **_kwargs: object) -> None:
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(np, "savez", full_disk)
    inner = CountingSeparator()
    cache = CachedSeparator(inner, tmp_path / "stems", ttl_sec=60)  # type: ignore[arg-type]
    audio = np.ones(100, dtype=np.float32)
    assert np.array_equal(cache.separate(audio, 22050).other, audio * 0.25)
    assert list((tmp_path / "stems").iterdir()) == []  # no temporary file left behind


def test_prune_removes_old_files_but_not_ones_being_written(tmp_path: Path) -> None:
    stems = tmp_path / "stems"
    stems.mkdir()
    writing, abandoned = stems / ".abc.tmp", stems / ".old.tmp"
    writing.write_bytes(b"partial")
    abandoned.write_bytes(b"partial")
    old = time.time() - 120
    os.utime(abandoned, (old, old))
    CachedSeparator(CountingSeparator(), stems, ttl_sec=60).prune()  # type: ignore[arg-type]
    assert writing.exists()
    assert not abandoned.exists()


def test_the_weights_loader_never_imports_what_the_file_names(tmp_path: Path) -> None:
    from safetensors.torch import save_file

    marker = tmp_path / "ran"
    evil = {
        "klass": "os.system",
        "args": json.dumps([f"touch {marker}"]),
        "kwargs": "{}",
    }
    for metadata in (evil, {**evil, "klass": "demucs.htdemucs.HTDemucs", "structure": "{}"}):
        path = tmp_path / "weights.safetensors"
        save_file({"x": torch.zeros(1)}, str(path), metadata=metadata)
        with pytest.raises(ValueError, match="not a plain"):
            load_htdemucs(path)
    assert not marker.exists()


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


def test_the_weights_load_exactly_as_demucs_loads_them() -> None:
    from demucs.hf import load_safetensors_model

    weights = need_model(Settings(), "htdemucs")
    ours, theirs = load_htdemucs(weights), load_safetensors_model(weights)
    assert type(ours) is type(theirs)
    assert ours.sources == theirs.sources
    assert ours.samplerate == theirs.samplerate
    assert ours.segment == theirs.segment
    a, b = ours.state_dict(), theirs.state_dict()
    assert a.keys() == b.keys()
    assert all(torch.equal(a[k], b[k]) for k in a)


def test_separation_matches_demucs_own_overlap_add(demucs: DemucsSeparator) -> None:
    """The memory-lean loop gives what apply_model over the whole song would give."""
    from demucs.apply import apply_model
    from demucs.audio import convert_audio

    song = render(SONGS[5])
    audio, rate = song.audio[: 12 * song.rate], song.rate
    wav = convert_audio(torch.from_numpy(audio)[None], rate, demucs.model_rate, 2)
    mean, std = wav.mean(0).mean(), wav.mean(0).std() + 1e-8
    with torch.inference_mode():
        out = apply_model(demucs._model, ((wav - mean) / std)[None], shifts=0, split=True)[0]
    out = out * std + mean
    sources = dict(zip(demucs.sources, out, strict=True))

    def mono(*names: str) -> np.ndarray:
        mix = sum((sources[n] for n in names), torch.zeros_like(out[0])).mean(0, keepdim=True)
        return convert_audio(mix, demucs.model_rate, rate, 1)[0][: len(audio)].numpy()

    stems = demucs.separate(audio, rate)
    assert np.allclose(stems.harmonic, mono(*HARMONIC_STEMS), atol=1e-5)
    assert np.allclose(stems.other, mono("other"), atol=1e-5)
