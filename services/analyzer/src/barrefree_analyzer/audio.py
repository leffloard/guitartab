"""ffmpeg/ffprobe wrappers: probing, decoding to NumPy, and a browser-friendly playback copy.

ffmpeg runs as a subprocess with a fixed argument list (no shell) and a timeout, on untrusted
uploads, so every call pins down what it may do:

- the input is demuxed with the format its magic bytes were accepted as (``-f``). Without this,
  ffmpeg probes the content and may pick a playlist demuxer (HLS, DASH, concat) for a file that
  merely starts like an MP3, then fetch the URLs or local paths it lists: server-side request
  forgery and local file disclosure;
- ``-protocol_whitelist file`` limits any nested opening to local files as a second line of
  defence, and the ``file:`` prefix keeps a name from being read as a protocol or an option.
"""

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import numpy.typing as npt

from barrefree_analyzer.uploads import AudioType

#: Sample rate of the analysis signal. Chordino, beat_this and the key estimator all accept it.
ANALYSIS_RATE = 22050
#: Shorter audio has no chords to speak of (and is too short for the beat tracker's windows).
MIN_DURATION_SEC = 1.0
_TIMEOUT_SEC = 600
#: ffmpeg demuxer for each accepted container (m4a/mp4 is "mov"; its external data references,
#: "drefs", stay disabled, which is ffmpeg's default).
DEMUXERS: dict[AudioType, str] = {
    "mp3": "mp3",
    "wav": "wav",
    "flac": "flac",
    "ogg": "ogg",
    "m4a": "mov",
}


class AudioError(Exception):
    """The file is not decodable audio, or it breaks a limit."""


@dataclass(frozen=True)
class ProbeResult:
    duration_sec: float
    codec: str
    sample_rate: int
    channels: int


def _binary(name: str) -> str:
    path = shutil.which(name)
    if path is None:
        raise AudioError(f"{name} is not installed")
    return path


def kind_of(path: Path) -> AudioType:
    """The accepted type an upload was saved as (``upload.<type>``)."""
    suffix = path.suffix.lstrip(".")
    for kind in DEMUXERS:
        if kind == suffix:
            return kind
    raise AudioError("unsupported audio file")


def _input(path: Path, kind: AudioType) -> list[str]:
    return ["-protocol_whitelist", "file", "-f", DEMUXERS[kind], "-i", f"file:{path}"]


def probe(path: Path, kind: AudioType | None = None) -> ProbeResult:
    """Reads the first audio stream's format with ffprobe."""
    kind = kind or kind_of(path)
    cmd = [_binary("ffprobe"), "-v", "error", "-print_format", "json"]
    cmd += ["-select_streams", "a:0"]
    cmd += ["-show_entries", "format=duration:stream=codec_name,sample_rate,channels,duration"]
    cmd += ["-protocol_whitelist", "file", "-f", DEMUXERS[kind], f"file:{path}"]
    proc = subprocess.run(cmd, capture_output=True, timeout=60, check=False)  # noqa: S603
    if proc.returncode != 0:
        raise AudioError("the file could not be read as audio")
    info = json.loads(proc.stdout or b"{}")
    streams = info.get("streams") or []
    if not streams:
        raise AudioError("the file has no audio stream")
    stream = streams[0]
    raw_duration = info.get("format", {}).get("duration") or stream.get("duration")
    try:
        duration = float(raw_duration)
    except (TypeError, ValueError) as exc:
        raise AudioError("the audio duration is unknown") from exc
    if not np.isfinite(duration) or duration <= 0:
        raise AudioError("the audio is empty")
    return ProbeResult(
        duration_sec=duration,
        codec=str(stream.get("codec_name", "")),
        sample_rate=int(stream.get("sample_rate") or 0),
        channels=int(stream.get("channels") or 0),
    )


def decode(
    path: Path,
    rate: int = ANALYSIS_RATE,
    max_sec: float | None = None,
    kind: AudioType | None = None,
) -> npt.NDArray[np.float32]:
    """Decodes the first audio stream to mono float32 at ``rate`` Hz, peak-normalized."""
    cmd = [_binary("ffmpeg"), "-nostdin", "-hide_banner", "-loglevel", "error"]
    cmd += _input(path, kind or kind_of(path))
    cmd += ["-map", "0:a:0", "-vn", "-ac", "1", "-ar", str(rate)]
    if max_sec is not None:
        cmd += ["-t", f"{max_sec:.3f}"]
    cmd += ["-f", "f32le", "pipe:1"]
    proc = subprocess.run(cmd, capture_output=True, timeout=_TIMEOUT_SEC, check=False)  # noqa: S603
    if proc.returncode != 0:
        raise AudioError("the audio could not be decoded")
    samples = np.frombuffer(proc.stdout, dtype="<f4").astype(np.float32)
    if samples.size == 0:
        raise AudioError("the audio is empty")
    return normalize(samples)


def normalize(samples: npt.NDArray[np.float32], peak: float = 0.9) -> npt.NDArray[np.float32]:
    """Scales to a fixed peak. Analysis only needs a consistent level, not perceived loudness."""
    samples = np.nan_to_num(samples, nan=0.0, posinf=0.0, neginf=0.0)
    top = float(np.max(np.abs(samples))) if samples.size else 0.0
    if top < 1e-6:
        return samples.astype(np.float32)
    return (samples * (peak / top)).astype(np.float32)


PLAYBACK_NAME = "audio.mp3"
PLAYBACK_MEDIA_TYPE = "audio/mpeg"


def make_playback_copy(
    path: Path, dest: Path, max_sec: float | None = None, kind: AudioType | None = None
) -> None:
    """Writes a mono 44.1 kHz, 128 kbit/s constant-bitrate MP3 copy for the browser player.

    MP3 decodes natively in every browser, including Firefox on Linux and Chromium builds without
    the proprietary AAC decoder; constant bitrate keeps seeking exact, which a play-along view
    needs. Loudness is evened out with EBU R128 ``loudnorm`` (one pass) so that quiet and loud
    uploads play at a similar level.
    """
    cmd = [_binary("ffmpeg"), "-nostdin", "-hide_banner", "-loglevel", "error", "-y"]
    cmd += _input(path, kind or kind_of(path))
    cmd += ["-map", "0:a:0", "-vn", "-ac", "1"]
    if max_sec is not None:
        cmd += ["-t", f"{max_sec:.3f}"]
    # loudnorm upsamples internally; resample to 44.1 kHz after it.
    cmd += ["-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "44100"]
    cmd += ["-c:a", "libmp3lame", "-b:a", "128k", "-f", "mp3", f"file:{dest}"]
    proc = subprocess.run(cmd, capture_output=True, timeout=_TIMEOUT_SEC, check=False)  # noqa: S603
    if proc.returncode != 0:
        dest.unlink(missing_ok=True)
        raise AudioError("the playback copy could not be made")
