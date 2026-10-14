"""Source separation with Demucs (Hybrid Transformer Demucs, "htdemucs").

Rouard, Massa & Défossez (2023), "Hybrid Transformers for Music Source Separation", ICASSP.
Package ``demucs`` (MIT). The weights are the published ``htdemucs`` model (trained on
MUSDB18-HQ plus 800 extra songs; the model card states no license of its own, see
docs/licenses.md), read from a pinned safetensors file with its SHA-256 checked. Demucs' own
safetensors loader imports and calls whatever class the file's metadata names, so
``load_htdemucs`` builds the one expected class itself and takes only tensors and JSON
arguments from the file.

The model splits a 44.1 kHz stereo mix into drums, bass, other and vocals. Chords are heard in
everything but drums and vocals: drums smear the chroma with broadband noise and a sung melody
adds passing notes, so the recognizer gets bass + other. Note transcription gets "other" alone
(guitars, keys). The pipeline's analysis signal is mono 22.05 kHz; it is resampled and shown to
the model as two identical channels, which loses the stereo cues that help separate a centered
voice, and the results are brought back to the analysis rate.

Separation dominates the CPU time of a job (tens of seconds per minute of music), so stems are
cached by the SHA-256 of the input samples for as long as other job files are kept. The job
that asked for them records the entry's name (``jobs/<id>/stems.ref``), so deleting the job
deletes them too.
"""

import hashlib
import json
import logging
import math
import os
import tempfile
import time
from fractions import Fraction
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np
import numpy.typing as npt
import torch

from barrefree_analyzer.pipeline.interfaces import Audio, Stems

if TYPE_CHECKING:
    from demucs.htdemucs import HTDemucs

log = logging.getLogger("barrefree.separation")

#: Stems kept for chord recognition (bass and the rest of the harmony).
HARMONIC_STEMS = ("bass", "other")
#: The only model class a weights file may describe.
MODEL_CLASS = "demucs.htdemucs.HTDemucs"
#: Overlap between neighbouring segments, as in demucs.api.Separator.
OVERLAP = 0.25


def resample(x: torch.Tensor, old: int, new: int, block_sec: float = 30.0) -> torch.Tensor:
    """julius' resampling (as in ``demucs.audio.convert_audio``), block by block.

    Resampling is a short FIR filter (about 50 input samples each side here), so blocks with
    4096 samples of context on each side give the samples of one full pass, without its
    full-length temporaries: about 1.3 GB for a 15-minute song in one pass.
    """
    from julius.resample import ResampleFrac

    g = math.gcd(old, new)
    step_in, step_out = old // g, new // g
    resampler = ResampleFrac(old, new)
    n = x.shape[-1]
    block = step_in * max(1, int(block_sec * old) // step_in)
    if n <= block:
        out: torch.Tensor = resampler(x)
        return out
    context = step_in * math.ceil(4096 / step_in)
    parts = []
    for start in range(0, n, block):
        end = min(n, start + block)
        first = max(0, start - context)
        y = resampler(x[..., first : min(n, end + context)])
        # Block edges are multiples of step_in, so input and output samples line up exactly.
        skip = (start - first) // step_in * step_out
        last = end == n  # the last block keeps the floored tail of a single pass
        parts.append(y[..., skip:] if last else y[..., skip : skip + block // step_in * step_out])
    return torch.cat(parts, -1)


def _decode_json(value: Any) -> Any:
    """Demucs' JSON encoding of model arguments, where fractions are tagged objects."""
    if isinstance(value, dict):
        if value.get("_type") == "fraction":
            return Fraction(int(value["numerator"]), int(value["denominator"]))
        return {key: _decode_json(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_decode_json(item) for item in value]
    return value


def load_htdemucs(weights: Path) -> "HTDemucs":
    """Builds HTDemucs from a safetensors file without importing anything the file names.

    ``demucs.hf.load_safetensors_model`` imports the metadata's ``klass`` (and any ``_class``
    in its ``structure``) and calls it, so a crafted file runs code. Here the class is fixed,
    the metadata only supplies JSON constructor arguments, and the tensors must match the
    model's parameters exactly.
    """
    from demucs.htdemucs import HTDemucs
    from safetensors import safe_open

    with safe_open(str(weights), framework="pt") as file:
        meta = file.metadata() or {}
        if meta.get("klass") != MODEL_CLASS or "structure" in meta:
            raise ValueError(f"{weights} is not a plain {MODEL_CLASS} weights file")
        tensors = {key: file.get_tensor(key) for key in file.keys()}  # noqa: SIM118
    args = _decode_json(json.loads(meta.get("args", "[]")))
    kwargs = _decode_json(json.loads(meta.get("kwargs", "{}")))
    if not isinstance(args, list) or not isinstance(kwargs, dict):
        raise ValueError(f"{weights} has malformed model arguments")
    model: HTDemucs = HTDemucs(*args, **kwargs)
    model.load_state_dict(tensors, strict=True)
    return model


class DemucsSeparator:
    name = "htdemucs"

    def __init__(self, weights: Path) -> None:
        if not weights.is_file():
            raise FileNotFoundError(
                f"Demucs weights {weights} are missing; run barrefree-download-models"
            )
        self._model = load_htdemucs(weights)
        self._model.eval()
        self.sources: list[str] = list(self._model.sources)
        self.model_rate = int(self._model.samplerate)

    def separate(self, audio: Audio, rate: int) -> Stems:
        samples = torch.from_numpy(np.ascontiguousarray(audio, dtype=np.float32))[None]
        # Resample the mono signal once, then show it to the model as two identical channels
        # (a stride-0 view, no copy). Every full-length buffer is freed as soon as it is used:
        # a 15-minute song is 40 M samples (160 MB) per buffer at 44.1 kHz.
        mono = resample(samples, rate, self.model_rate)
        # Same normalization as demucs.api.Separator: zero mean, unit variance of the mix.
        mean, std = mono.mean(), mono.std() + 1e-8
        mix = (mono - mean) / std
        del mono
        harmonic, other = self._mono_stems(mix.expand(2, -1)[None])
        del mix
        # Undo the normalization on each stem, then mix: (b·s + m) + (o·s + m) for bass + other.
        harmonic.mul_(std).add_(len(HARMONIC_STEMS) * mean)
        other.mul_(std).add_(mean)

        def back(signal: torch.Tensor) -> npt.NDArray[np.float32]:
            out = resample(signal[None], self.model_rate, rate)[0]
            return out[: len(audio)].numpy().astype(np.float32, copy=False)

        harmonic_out = back(harmonic)
        del harmonic
        return Stems(rate=rate, harmonic=harmonic_out, other=back(other))

    def _mono_stems(self, mix: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        """Mono bass + other and mono other for a normalized (1, 2, n) mix.

        The overlap-add loop of ``demucs.apply.apply_model(split=True, shifts=0)`` (MIT, Meta
        Platforms, Inc. and affiliates), changed to keep only these two mono signals: each
        segment's four stereo stems are reduced as soon as it is separated, instead of holding
        all four sources for the whole song (1.3 GB for 15 minutes).
        """
        from demucs.apply import TensorChunk, apply_model

        length = mix.shape[-1]
        segment = int(self.model_rate * self._model.segment)
        stride = int((1 - OVERLAP) * segment)
        # A triangle with its peak in the middle of the segment (transition_power 1).
        weight = torch.cat(
            [torch.arange(1, segment // 2 + 1), torch.arange(segment - segment // 2, 0, -1)]
        )
        weight = weight / weight.max()
        bass_and_other = [self.sources.index(n) for n in HARMONIC_STEMS]
        other_index = self.sources.index("other")
        harmonic = torch.zeros(length)
        other = torch.zeros(length)
        total = torch.zeros(length)
        with torch.inference_mode():
            for offset in range(0, length, stride):
                chunk = TensorChunk(mix, offset, segment)  # type: ignore[no-untyped-call]
                # shifts=0: no random time shifts, so the same input always gives the same stems.
                out = apply_model(self._model, chunk, shifts=0, split=False)[0]  # (4, 2, n)
                n = out.shape[-1]
                w = weight[:n]
                harmonic[offset : offset + n] += w * out[bass_and_other].sum(0).mean(0)
                other[offset : offset + n] += w * out[other_index].mean(0)
                total[offset : offset + n] += w
        return harmonic.div_(total), other.div_(total)


class CachedSeparator:
    """Keeps the stems of recent inputs on disk; entries older than ``ttl_sec`` are removed.

    A damaged entry is discarded and computed again, and a failed write only costs the cache:
    neither fails the job. Entries are written to a hidden temporary file and renamed, so
    concurrent workers never see each other's partial files.
    """

    def __init__(self, inner: DemucsSeparator, directory: Path, ttl_sec: float) -> None:
        self.inner = inner
        self.name = inner.name
        self.directory = directory
        self.ttl_sec = ttl_sec

    def entry_name(self, audio: Audio, rate: int) -> str:
        # hashlib reads the array's buffer directly: no copy of a long song.
        digest = hashlib.sha256(np.ascontiguousarray(audio, dtype=np.float32))
        digest.update(f"{rate}:{self.inner.name}".encode())
        return f"{digest.hexdigest()}.npz"

    def separate(self, audio: Audio, rate: int) -> Stems:
        self.prune()
        path = self.directory / self.entry_name(audio, rate)
        cached = self._read(path, len(audio), rate)
        if cached is not None:
            return cached
        stems = self.inner.separate(audio, rate)
        self._write(path, stems)
        return stems

    def _read(self, path: Path, n_samples: int, rate: int) -> Stems | None:
        if not path.is_file():
            return None
        try:
            with np.load(path, allow_pickle=False) as data:
                if sorted(data.files) != ["harmonic", "other"]:
                    raise ValueError(f"unexpected arrays {data.files}")
                harmonic, other = data["harmonic"], data["other"]
            for array in (harmonic, other):
                if array.dtype != np.float32 or array.shape != (n_samples,):
                    raise ValueError(f"unexpected array {array.dtype} {array.shape}")
        except Exception as exc:  # truncated, bad CRC, wrong content: compute it again
            log.warning("discarding damaged stems cache entry %s: %s", path.name, exc)
            path.unlink(missing_ok=True)
            return None
        return Stems(rate=rate, harmonic=harmonic, other=other)

    def _write(self, path: Path, stems: Stems) -> None:
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
            fd, name = tempfile.mkstemp(dir=self.directory, prefix=".", suffix=".tmp")
            try:
                with os.fdopen(fd, "wb") as out:
                    np.savez(out, harmonic=stems.harmonic, other=stems.other)
                os.replace(name, path)
            finally:
                Path(name).unlink(missing_ok=True)
        except OSError as exc:
            log.warning("could not cache stems in %s: %s", self.directory, exc)

    def prune(self, now: float | None = None) -> None:
        if not self.directory.is_dir():
            return
        now = time.time() if now is None else now
        # Every file, including temporary files a killed worker left behind; a file being
        # written is younger than the TTL.
        for entry in self.directory.iterdir():
            try:
                if now - entry.stat().st_mtime > self.ttl_sec:
                    entry.unlink()
            except FileNotFoundError:
                pass
