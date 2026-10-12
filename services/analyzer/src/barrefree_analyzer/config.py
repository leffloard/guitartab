"""Runtime configuration, read from environment variables (or a ``.env`` file)."""

from functools import lru_cache
from pathlib import Path

from pydantic import Field
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
    temp_file_ttl_sec: int = Field(default=6 * 60 * 60, gt=0)
    worker_poll_interval_sec: float = Field(default=1.0, gt=0)


@lru_cache
def get_settings() -> Settings:
    return Settings()
