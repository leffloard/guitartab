"""Runtime configuration, read from environment variables (or a ``.env`` file)."""

from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


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
    recognizers: list[str] = Field(
        default=["chordino", "btc"],
        description="Enabled chord recognizers ('chordino', 'btc'), the first is the default.",
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
    beat_tracker: str = Field(default="beat_this", description="'beat_this' or 'librosa'.")
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
    def jobs_path(self) -> Path:
        return self.data_dir / "jobs"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "jobs.sqlite3"


@lru_cache
def get_settings() -> Settings:
    return Settings()
