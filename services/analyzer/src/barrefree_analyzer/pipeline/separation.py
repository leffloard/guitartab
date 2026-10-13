"""Source separation with Demucs (Hybrid Transformer Demucs, "htdemucs").

Rouard, Massa & Défossez (2023), "Hybrid Transformers for Music Source Separation", ICASSP.
Package ``demucs`` (MIT). The weights are the published ``htdemucs`` model (trained on
MUSDB18-HQ plus 800 extra songs; the model card states no license of its own, see
docs/licenses.md), loaded from a pinned safetensors file rather than the older pickle files, so
loading them cannot run arbitrary code.

The model splits a 44.1 kHz stereo mix into drums, bass, other and vocals. Chords are heard in
everything but drums and vocals: drums smear the chroma with broadband noise and a sung melody
adds passing notes, so the recognizer gets bass + other. Note transcription gets "other" alone
(guitars, keys). The pipeline's analysis signal is mono 22.05 kHz; it is resampled and copied
to both channels, which loses the stereo cues that help separate a centered voice, and the
results are brought back to the analysis rate.

Separation dominates the CPU time of a job (tens of seconds per minute of music), so stems are
cached by the SHA-256 of the input samples for as long as other job files are kept.
"""

import hashlib
import time
from pathlib import Path

import numpy as np
import numpy.typing as npt
import torch

from barrefree_analyzer.pipeline.interfaces import Audio, Stems

#: Stems kept for chord recognition (bass and the rest of the harmony).
HARMONIC_STEMS = ("bass", "other")


class DemucsSeparator:
    name = "htdemucs"

    def __init__(self, weights: Path) -> None:
        if not weights.is_file():
            raise FileNotFoundError(
                f"Demucs weights {weights} are missing; run barrefree-download-models"
            )
        from demucs.hf import load_safetensors_model

        self._model = load_safetensors_model(weights)
        self._model.eval()
        self.sources: list[str] = list(self._model.sources)
        self.model_rate = int(self._model.samplerate)

    def separate(self, audio: Audio, rate: int) -> Stems:
        from demucs.apply import apply_model
        from demucs.audio import convert_audio

        wav = convert_audio(torch.from_numpy(audio)[None], rate, self.model_rate, 2)
        # Same normalization as demucs.api.Separator: zero mean, unit variance.
        reference = wav.mean(0)
        mean, std = reference.mean(), reference.std() + 1e-8
        with torch.inference_mode():
            # shifts=0: no random time shifts, so the same input always gives the same stems.
            out = apply_model(
                self._model, ((wav - mean) / std)[None], shifts=0, split=True, overlap=0.25
            )[0]
        out = out * std + mean
        stems = dict(zip(self.sources, out, strict=True))

        def mono(*names: str) -> npt.NDArray[np.float32]:
            mix = sum((stems[n] for n in names), torch.zeros_like(out[0])).mean(0, keepdim=True)
            back = convert_audio(mix, self.model_rate, rate, 1)[0]
            return back[: len(audio)].numpy().astype(np.float32)

        return Stems(rate=rate, harmonic=mono(*HARMONIC_STEMS), other=mono("other"))


class CachedSeparator:
    """Keeps the stems of recent inputs on disk; entries older than ``ttl_sec`` are removed."""

    def __init__(self, inner: DemucsSeparator, directory: Path, ttl_sec: float) -> None:
        self.inner = inner
        self.name = inner.name
        self.directory = directory
        self.ttl_sec = ttl_sec

    def _path(self, audio: Audio, rate: int) -> Path:
        digest = hashlib.sha256(np.ascontiguousarray(audio, dtype=np.float32).tobytes())
        digest.update(f"{rate}:{self.inner.name}".encode())
        return self.directory / f"{digest.hexdigest()}.npz"

    def separate(self, audio: Audio, rate: int) -> Stems:
        self.prune()
        path = self._path(audio, rate)
        if path.is_file():
            try:
                with np.load(path) as data:
                    return Stems(rate=rate, harmonic=data["harmonic"], other=data["other"])
            except (OSError, ValueError, KeyError):
                path.unlink(missing_ok=True)  # a damaged entry is recomputed
        stems = self.inner.separate(audio, rate)
        self.directory.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp.npz")
        np.savez(tmp, harmonic=stems.harmonic, other=stems.other)
        tmp.replace(path)
        return stems

    def prune(self, now: float | None = None) -> None:
        if not self.directory.is_dir():
            return
        now = time.time() if now is None else now
        for entry in self.directory.glob("*.npz"):
            try:
                if now - entry.stat().st_mtime > self.ttl_sec:
                    entry.unlink()
            except FileNotFoundError:
                pass
