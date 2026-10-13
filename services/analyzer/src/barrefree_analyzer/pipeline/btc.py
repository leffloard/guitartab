"""BTC chord recognizer: a bi-directional transformer over a constant-Q spectrogram.

Park, Choi, Jeon & Kim (2019), "A Bi-Directional Transformer for Musical Chord Recognition",
ISMIR. The network below is a typed, inference-only port of ``btc_model.py`` and
``utils/transformer_modules.py`` from https://github.com/jayg996/BTC-ISMIR19 (MIT License,
Copyright (c) 2019 Jonggwon Park; commit 2682317be668032e6e4b269ded36adaa2ad57df0). Module and
attribute names are kept so that the published ``btc_model_large_voca.pt`` weights load with
strict key checking. Two quirks of the original are kept on purpose because the weights were
trained with them: the layer norm divides by the unbiased standard deviation plus epsilon, and
the position-wise feed-forward block applies ReLU after its last convolution too.

The large-vocabulary model predicts 170 classes every 10/108 s: 12 roots x 14 qualities, plus
"X" (an unknown chord) and "N" (no chord). Features follow the original exactly: 22.05 kHz mono,
a 144-bin CQT (24 bins per octave, hop 2048) computed in 10 s chunks, log magnitude, then the
mean and standard deviation stored in the checkpoint.
"""

import math
import warnings
from pathlib import Path
from typing import Any

import librosa
import numpy as np
import numpy.typing as npt
import torch
from torch import nn
from torch.nn import functional

from barrefree_analyzer.pipeline.interfaces import Audio, RawChord

RATE = 22050
CHUNK_SEC = 10.0
TIMESTEP = 108
#: Seconds per output frame: each 10 s chunk gives 108 CQT frames.
FRAME_SEC = CHUNK_SEC / TIMESTEP
N_BINS = 144
BINS_PER_OCTAVE = 24
HOP = 2048
NUM_CHORDS = 170
_ROOTS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_QUALITIES = [
    "min", "maj", "dim", "aug", "min6", "maj6", "min7",
    "minmaj7", "maj7", "7", "dim7", "hdim7", "sus2", "sus4",
]  # fmt: skip


def label_of(index: int) -> str:
    """Harte label of a class index (168 = unknown chord "X", 169 = no chord "N")."""
    if index == NUM_CHORDS - 1:
        return "N"
    if index == NUM_CHORDS - 2:
        return "X"
    return f"{_ROOTS[index // 14]}:{_QUALITIES[index % 14]}"


def _future_mask(length: int) -> torch.Tensor:
    """-inf above the diagonal: position i may not attend to j > i. Shape (1, 1, L, L)."""
    mask = torch.triu(torch.full((length, length), float("-inf")), diagonal=1)
    return mask[None, None]


def _timing_signal(length: int, channels: int) -> torch.Tensor:
    """Sinusoidal position encoding (tensor2tensor), shape (1, length, channels)."""
    position = np.arange(length, dtype=np.float64)
    timescales = channels // 2
    increment = math.log(1.0e4) / (timescales - 1)
    inv = np.exp(np.arange(timescales, dtype=np.float64) * -increment)
    scaled = position[:, None] * inv[None, :]
    signal = np.concatenate([np.sin(scaled), np.cos(scaled)], axis=1)
    signal = np.pad(signal, [[0, 0], [0, channels % 2]])
    return torch.from_numpy(signal.reshape(1, length, channels)).float()


class LayerNorm(nn.Module):
    def __init__(self, features: int, eps: float = 1e-6) -> None:
        super().__init__()
        self.gamma = nn.Parameter(torch.ones(features))
        self.beta = nn.Parameter(torch.zeros(features))
        self.eps = eps

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        mean = x.mean(-1, keepdim=True)
        std = x.std(-1, keepdim=True)
        return self.gamma * (x - mean) / (std + self.eps) + self.beta


class MultiHeadAttention(nn.Module):
    def __init__(self, depth: int, num_heads: int, bias_mask: torch.Tensor) -> None:
        super().__init__()
        self.num_heads = num_heads
        self.query_scale = (depth // num_heads) ** -0.5
        self.register_buffer("bias_mask", bias_mask, persistent=False)
        self.query_linear = nn.Linear(depth, depth, bias=False)
        self.key_linear = nn.Linear(depth, depth, bias=False)
        self.value_linear = nn.Linear(depth, depth, bias=False)
        self.output_linear = nn.Linear(depth, depth, bias=False)

    def _split(self, x: torch.Tensor) -> torch.Tensor:
        b, t, d = x.shape
        return x.view(b, t, self.num_heads, d // self.num_heads).permute(0, 2, 1, 3)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        queries = self._split(self.query_linear(x)) * self.query_scale
        keys = self._split(self.key_linear(x))
        values = self._split(self.value_linear(x))
        logits = torch.matmul(queries, keys.permute(0, 1, 3, 2))
        t = logits.shape[-1]
        logits = logits + self.get_buffer("bias_mask")[:, :, :t, :t]
        contexts = torch.matmul(functional.softmax(logits, dim=-1), values)
        b, h, _, d = contexts.shape
        merged = contexts.permute(0, 2, 1, 3).contiguous().view(b, t, h * d)
        out: torch.Tensor = self.output_linear(merged)
        return out


class Conv(nn.Module):
    """Width-3 convolution over time with "same" padding, on (batch, time, channels)."""

    def __init__(self, size: int) -> None:
        super().__init__()
        self.pad = nn.ConstantPad1d((1, 1), 0.0)
        self.conv = nn.Conv1d(size, size, kernel_size=3, padding=0)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        out: torch.Tensor = self.conv(self.pad(x.permute(0, 2, 1))).permute(0, 2, 1)
        return out


class PositionwiseFeedForward(nn.Module):
    def __init__(self, size: int) -> None:
        super().__init__()
        self.layers = nn.ModuleList([Conv(size), Conv(size)])

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        for layer in self.layers:
            x = torch.relu(layer(x))  # after the last layer too, as in the original
        return x


class SelfAttentionBlock(nn.Module):
    def __init__(self, size: int, num_heads: int, bias_mask: torch.Tensor) -> None:
        super().__init__()
        self.multi_head_attention = MultiHeadAttention(size, num_heads, bias_mask)
        self.positionwise_convolution = PositionwiseFeedForward(size)
        self.layer_norm_mha = LayerNorm(size)
        self.layer_norm_ffn = LayerNorm(size)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = x + self.multi_head_attention(self.layer_norm_mha(x))
        out: torch.Tensor = x + self.positionwise_convolution(self.layer_norm_ffn(x))
        return out


class BiDirectionalSelfAttention(nn.Module):
    def __init__(self, size: int, num_heads: int, max_length: int) -> None:
        super().__init__()
        forward_mask = _future_mask(max_length)
        self.attn_block = SelfAttentionBlock(size, num_heads, forward_mask)
        self.backward_attn_block = SelfAttentionBlock(size, num_heads, forward_mask.transpose(2, 3))
        self.linear = nn.Linear(size * 2, size)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        both = torch.cat((self.attn_block(x), self.backward_attn_block(x)), dim=2)
        out: torch.Tensor = self.linear(both)
        return out


class BiDirectionalSelfAttentionLayers(nn.Module):
    def __init__(
        self, features: int, size: int, num_layers: int, num_heads: int, max_length: int
    ) -> None:
        super().__init__()
        self.register_buffer("timing_signal", _timing_signal(max_length, size), persistent=False)
        self.embedding_proj = nn.Linear(features, size, bias=False)
        self.self_attn_layers = nn.Sequential(
            *[BiDirectionalSelfAttention(size, num_heads, max_length) for _ in range(num_layers)]
        )
        self.layer_norm = LayerNorm(size)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        y = self.embedding_proj(x) + self.get_buffer("timing_signal")[:, : x.shape[1], :]
        out: torch.Tensor = self.layer_norm(self.self_attn_layers(y))
        return out


class SoftmaxOutputLayer(nn.Module):
    def __init__(self, size: int, classes: int) -> None:
        super().__init__()
        self.output_projection = nn.Linear(size, classes)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """Class probabilities, shape (batch, time, classes)."""
        return functional.softmax(self.output_projection(x), dim=-1)


class BTCModel(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.self_attn_layers = BiDirectionalSelfAttentionLayers(
            features=N_BINS, size=128, num_layers=8, num_heads=4, max_length=TIMESTEP
        )
        self.output_layer = SoftmaxOutputLayer(128, NUM_CHORDS)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        probs: torch.Tensor = self.output_layer(self.self_attn_layers(x))
        return probs


def load_checkpoint(path: Path) -> tuple[BTCModel, float, float]:
    """The model in eval mode, and the feature mean and standard deviation it was trained with.

    The file is a pickle; ``weights_only=True`` lets torch unpickle only tensors and the few
    NumPy types the checkpoint stores its statistics as, never arbitrary objects.
    """
    allowed: list[Any] = [
        (np._core.multiarray.scalar, "numpy.core.multiarray.scalar"),  # type: ignore[attr-defined]
        np.dtype,
        np.dtypes.Float64DType,
    ]
    with torch.serialization.safe_globals(allowed):
        checkpoint = torch.load(path, map_location="cpu", weights_only=True)
    # The output layer's LSTM is never used in the forward pass; its weights are dropped.
    state = {k: v for k, v in checkpoint["model"].items() if not k.startswith("output_layer.lstm.")}
    model = BTCModel()
    model.load_state_dict(state, strict=True)
    model.eval()
    return model, float(checkpoint["mean"]), float(checkpoint["std"])


def features(audio: Audio, rate: int) -> npt.NDArray[np.float32]:
    """Log-magnitude CQT frames, shape (frames, 144), in 10 s chunks as in the original."""
    if rate != RATE:
        audio = librosa.resample(audio, orig_sr=rate, target_sr=RATE)
    step = int(RATE * CHUNK_SEC)
    chunks = []
    for start in range(0, len(audio), step):
        chunk = audio[start : start + step]
        # The CQT needs a few samples per octave; a last chunk shorter than one hop is padded
        # with silence (its frames past the end are clipped by the caller).
        if len(chunk) < HOP:
            chunk = np.pad(chunk, (0, HOP - len(chunk)))
        with warnings.catch_warnings():
            # Short final chunks make librosa warn that its top-octave FFT exceeds the input.
            warnings.simplefilter("ignore", UserWarning)
            cqt = librosa.cqt(
                chunk, sr=RATE, n_bins=N_BINS, bins_per_octave=BINS_PER_OCTAVE, hop_length=HOP
            )
        chunks.append(np.log(np.abs(cqt) + 1e-6))
    return np.concatenate(chunks, axis=1).T.astype(np.float32)


class BTCRecognizer:
    name = "btc"

    def __init__(self, checkpoint: Path) -> None:
        if not checkpoint.is_file():
            raise FileNotFoundError(
                f"BTC checkpoint {checkpoint} is missing; run barrefree-download-models"
            )
        self._model, self._mean, self._std = load_checkpoint(checkpoint)

    def frame_probabilities(self, audio: Audio, rate: int) -> npt.NDArray[np.float32]:
        """Class probabilities for every 10/108 s frame, shape (frames, 170)."""
        x = (features(audio, rate) - self._mean) / self._std
        frames = len(x)
        pad = (-frames) % TIMESTEP
        x = np.pad(x, ((0, pad), (0, 0)))
        # Independent 108-frame windows, as the model was trained; batched in one call.
        batch = torch.from_numpy(x).view(-1, TIMESTEP, N_BINS)
        with torch.inference_mode():
            probs = self._model(batch).reshape(-1, NUM_CHORDS)[:frames]
        return np.asarray(probs.numpy(), dtype=np.float32)

    def recognize(self, audio: Audio, rate: int) -> list[RawChord]:
        if len(audio) == 0:
            return []
        probs = self.frame_probabilities(audio, rate)
        best = probs.argmax(axis=1)
        top = probs[np.arange(len(best)), best]
        duration = len(audio) / rate
        chords: list[RawChord] = []
        start = 0
        for i in range(1, len(best) + 1):
            if i == len(best) or best[i] != best[start]:
                begin, end = start * FRAME_SEC, min(i * FRAME_SEC, duration)
                if end > begin:
                    confidence = float(top[start:i].mean())
                    chords.append(RawChord(begin, end, label_of(int(best[start])), confidence))
                start = i
        return chords
