"""Upload validation: magic bytes and a size limit enforced while streaming to disk.

The extension and the client's Content-Type are not trusted. The first bytes must look like
one of the accepted containers; ffprobe then checks that there is a decodable audio stream.
"""

import hashlib
from pathlib import Path
from typing import Literal, Protocol

AudioType = Literal["mp3", "wav", "flac", "ogg", "m4a"]

#: Bytes read from the start of a file to identify it.
SNIFF_BYTES = 12
_CHUNK = 1024 * 1024
_MP4_BRANDS = {b"M4A ", b"M4B ", b"isom", b"iso2", b"mp41", b"mp42", b"dash", b"MSNV"}


class UploadTooLargeError(Exception):
    pass


class UnsupportedAudioError(Exception):
    pass


def sniff_audio_type(head: bytes) -> AudioType | None:
    """Identifies MP3, WAV, FLAC, Ogg and MP4/M4A audio from their first bytes."""
    if head.startswith(b"ID3"):
        return "mp3"  # ID3v2 tag in front of MPEG audio frames
    if head.startswith(b"fLaC"):
        return "flac"
    if head.startswith(b"OggS"):
        return "ogg"
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "wav"
    if head[4:8] == b"ftyp" and head[8:12] in _MP4_BRANDS:
        return "m4a"
    if len(head) >= 2 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0:
        # MPEG audio frame sync: 11 set bits, then version (01 is reserved) and layer (00 is
        # reserved; AAC ADTS streams use 00 and are rejected here).
        version = (head[1] >> 3) & 0x3
        layer = (head[1] >> 1) & 0x3
        if version != 0b01 and layer != 0b00:
            return "mp3"
    return None


class ChunkReader(Protocol):
    async def read(self, size: int = -1, /) -> bytes: ...


async def save_upload(
    source: ChunkReader, dest_dir: Path, max_bytes: int
) -> tuple[Path, AudioType, str]:
    """Streams an upload to ``dest_dir`` and returns (path, type, sha256).

    Stops reading as soon as the limit is passed, so an oversized upload never fills the disk.
    """
    dest_dir.mkdir(parents=True, exist_ok=True)
    head = await source.read(SNIFF_BYTES)
    kind = sniff_audio_type(head)
    if kind is None:
        raise UnsupportedAudioError("not an MP3, WAV, FLAC, Ogg or M4A audio file")
    path = dest_dir / f"upload.{kind}"
    digest = hashlib.sha256(head)
    size = len(head)
    try:
        with path.open("wb") as out:
            out.write(head)
            while chunk := await source.read(_CHUNK):
                size += len(chunk)
                if size > max_bytes:
                    raise UploadTooLargeError(f"file is larger than {max_bytes // 2**20} MB")
                digest.update(chunk)
                out.write(chunk)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return path, kind, digest.hexdigest()
