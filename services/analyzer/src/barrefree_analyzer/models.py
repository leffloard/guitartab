"""Model weights: where they come from, their checksums, and a downloader.

Weights are never committed or baked into the image: ``barrefree-download-models`` fetches them
into the models volume once, checks their SHA-256 and writes them atomically.

    uv run barrefree-download-models            # everything the configured pipeline needs
    uv run barrefree-download-models beat_this  # one model
"""

import argparse
import hashlib
import logging
import os
import tempfile
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from barrefree_analyzer.config import Settings, get_settings

log = logging.getLogger("barrefree.models")


@dataclass(frozen=True)
class ModelFile:
    key: str
    path: str  # relative to Settings.models_path
    url: str
    sha256: str
    size: int
    license: str


MODELS: dict[str, ModelFile] = {
    # beat_this "final0": trained on all data except GTZAN, seed 0 (the package's default).
    # Code and weights: MIT, CPJKU (https://github.com/CPJKU/beat_this).
    "beat_this": ModelFile(
        key="beat_this",
        path="beat_this/final0.ckpt",
        url="https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/final0.ckpt",
        sha256="8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331",
        size=81_058_141,
        license="MIT",
    ),
    # BTC large-vocabulary model (170 classes), from the paper's repository at a pinned commit.
    # Code MIT; the weights carry no separate license (see docs/licenses.md): downloaded, never
    # redistributed.
    "btc": ModelFile(
        key="btc",
        path="btc/btc_model_large_voca.pt",
        url="https://raw.githubusercontent.com/jayg996/BTC-ISMIR19/"
        "2682317be668032e6e4b269ded36adaa2ad57df0/test/btc_model_large_voca.pt",
        sha256="1673d23f8f9a55ae7f9e8b80a51da616debb22675b8d8b67ea6ce0ef37b0ab51",
        size=12_229_576,
        license="MIT code; weights without a stated license",
    ),
    # Hybrid Transformer Demucs (htdemucs, signature 955717e8) as safetensors, from the
    # maintainer's Hugging Face repository at a pinned commit. Code MIT; the model card states
    # no license for the weights (see docs/licenses.md): downloaded, never redistributed.
    "htdemucs": ModelFile(
        key="htdemucs",
        path="demucs/955717e8.safetensors",
        url="https://huggingface.co/adefossez/HTDemucs/resolve/"
        "cbc8a9b1a87023b7fd74e7b3412e6321c0eab003/955717e8.safetensors",
        sha256="d9fa14133cfcc034a6758923bb3a8ca9f8dfd0b582134643bbf83f72c17576dd",
        size=84_025_440,
        license="MIT code; weights without a stated license",
    ),
}


class ChecksumError(Exception):
    pass


def model_path(settings: Settings, key: str) -> Path:
    return settings.models_path / MODELS[key].path


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def ensure_model(settings: Settings, key: str, *, timeout: float = 120.0) -> Path:
    """Downloads a model if it is missing or corrupt; returns its path."""
    spec = MODELS[key]
    dest = model_path(settings, key)
    if dest.is_file() and dest.stat().st_size == spec.size and sha256_of(dest) == spec.sha256:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    _remove_stale_partials(dest)
    log.info("downloading %s (%.0f MB) from %s", key, spec.size / 1e6, spec.url)
    fd, tmp_name = tempfile.mkstemp(dir=dest.parent, prefix=f".{dest.name}.")
    tmp = Path(tmp_name)
    try:
        digest = hashlib.sha256()
        # The URL is a constant https:// address from MODELS, never user input.
        with os.fdopen(fd, "wb") as out, urllib.request.urlopen(spec.url, timeout=timeout) as resp:  # noqa: S310
            received = 0
            while chunk := resp.read(1 << 20):
                received += len(chunk)
                if received > spec.size:
                    raise ChecksumError(f"{key}: larger than the expected {spec.size} bytes")
                digest.update(chunk)
                out.write(chunk)
        if digest.hexdigest() != spec.sha256:
            raise ChecksumError(f"{key}: checksum mismatch (got {digest.hexdigest()})")
        tmp.replace(dest)
    finally:
        tmp.unlink(missing_ok=True)
    return dest


#: A partial download this old was abandoned (the process was killed before its clean-up ran).
_PARTIAL_MAX_AGE_SEC = 3600.0


def _remove_stale_partials(dest: Path) -> None:
    now = time.time()
    for partial in dest.parent.glob(f".{dest.name}.*"):
        try:
            if now - partial.stat().st_mtime > _PARTIAL_MAX_AGE_SEC:
                partial.unlink()
        except FileNotFoundError:
            pass  # another worker removed it


def required_models(settings: Settings) -> list[str]:
    keys = []
    if settings.beat_tracker == "beat_this":
        keys.append("beat_this")
    if "btc" in settings.recognizers:
        keys.append("btc")
    if settings.separation:
        keys.append("htdemucs")
    return keys


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "keys", nargs="*", help=f"any of {', '.join(MODELS)}; default: what the settings need"
    )
    args = parser.parse_args(argv)
    unknown = [k for k in args.keys if k not in MODELS]
    if unknown:
        parser.error(f"unknown model(s): {', '.join(unknown)}")
    settings = get_settings()
    for key in args.keys or required_models(settings):
        print(f"{key}: {ensure_model(settings, key)}")


if __name__ == "__main__":
    main()
