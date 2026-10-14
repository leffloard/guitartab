"""Runtime configuration, read from environment variables (or a ``.env`` file)."""

import json
import socket
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

#: Chord recognizers this service knows; ``Settings.recognizers`` picks from them.
KNOWN_RECOGNIZERS = ("chordino", "btc")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    data_dir: Path = Field(
        default=Path("local-data"),
        description="Where job database, uploads and temporary files live. Use a Docker volume.",
    )
    web_dist_dir: Path | None = Field(
        default=None,
        description="Built web app (apps/web/dist). When set and present, it is served at '/'.",
    )
    enable_url_import: bool = Field(
        default=False,
        description="Allow YouTube/Spotify link import. Off by default: downloading is the "
        "user's responsibility and may violate the platform's terms of service.",
    )
    max_upload_mb: int = Field(default=50, gt=0)
    max_duration_sec: int = Field(default=15 * 60, gt=0)
    temp_file_ttl_sec: int = Field(
        default=6 * 60 * 60,
        gt=0,
        description="Finished jobs, their audio and results are deleted after this long.",
    )
    worker_poll_interval_sec: float = Field(default=1.0, gt=0)
    worker_id: str = Field(
        default_factory=socket.gethostname,
        min_length=1,
        description="Names this worker in the queue, so that after a crash or restart it fails "
        "the jobs it was running at once. Give every worker its own id. Default: host name.",
    )
    job_timeout_sec: int = Field(
        default=60 * 60,
        gt=0,
        description="A running job with no progress for this long is marked failed.",
    )
    max_pending_jobs: int = Field(default=20, gt=0, description="Queued + running jobs.")
    upload_rate_per_min: int = Field(default=6, gt=0, description="New jobs per client.")
    client_ip_header: str | None = Field(
        default=None,
        description="Header holding the real client IP behind a trusted proxy, e.g. "
        "'CF-Connecting-IP' with Cloudflare Tunnel. Unset: the TCP peer address.",
    )
    recognizers: Annotated[list[str], NoDecode] = Field(
        default=["chordino", "btc"],
        description="Enabled chord recognizers ('chordino', 'btc'), the first available one is "
        "the default. Env: a comma-separated list, e.g. RECOGNIZERS=chordino,btc.",
    )
    transcription: bool = Field(
        default=True,
        description="Offer note transcription (Basic Pitch) for the experimental tab view.",
    )
    separation: bool = Field(
        default=True,
        description="Offer source separation (Demucs) as a job option. CPU-heavy: tens of "
        "seconds per minute of music.",
    )
    beat_tracker: Literal["beat_this", "librosa"] = Field(default="beat_this")
    vamp_path: Path = Field(
        default=Path(__file__).resolve().parents[2] / ".vamp",
        description="Folder with nnls-chroma.so (Chordino). Env: VAMP_PATH.",
    )
    url_import_cookies: Path | None = Field(
        default=None,
        description="Optional cookies.txt of a signed-in YouTube session for link import. "
        "YouTube asks many data-center servers to sign in; see docs/architecture.md 4c.",
    )
    model_dir: Path | None = Field(
        default=None, description="Model weights and caches. Default: <data_dir>/models."
    )

    @field_validator("recognizers", mode="before")
    @classmethod
    def _recognizer_list(cls, value: object) -> object:
        # A typo must fail at start-up, not leave every job without a recognizer.
        if isinstance(value, str):
            text = value.strip()
            value = json.loads(text) if text.startswith("[") else text.split(",")
        if not isinstance(value, list):
            return value  # pydantic reports the type error
        names = list(dict.fromkeys(str(v).strip() for v in value if str(v).strip()))
        unknown = [n for n in names if n not in KNOWN_RECOGNIZERS]
        if unknown:
            raise ValueError(
                f"unknown recognizer(s) {', '.join(unknown)}; known: {', '.join(KNOWN_RECOGNIZERS)}"
            )
        if not names:
            raise ValueError("at least one recognizer is needed")
        return names

    @field_validator("url_import_cookies", mode="before")
    @classmethod
    def _empty_is_none(cls, value: object) -> object:
        # Compose passes unset variables as "": no file, not the current directory.
        return None if value == "" else value

    @property
    def models_path(self) -> Path:
        return self.model_dir if self.model_dir is not None else self.data_dir / "models"

    @property
    def cache_path(self) -> Path:
        """Derived audio (separated stems); cleared on the same TTL as job files."""
        return self.data_dir / "cache"

    @property
    def stems_path(self) -> Path:
        """Cached separation stems, one ``<sha256>.npz`` per input."""
        return self.cache_path / "stems"

    @property
    def jobs_path(self) -> Path:
        return self.data_dir / "jobs"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "jobs.sqlite3"


@lru_cache
def get_settings() -> Settings:
    return Settings()
