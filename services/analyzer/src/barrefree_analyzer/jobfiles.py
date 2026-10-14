"""A job's folder on disk, and its removal together with the stems derived from its audio."""

import re
import shutil
from pathlib import Path

from barrefree_analyzer.config import Settings

#: In a job's folder: the name of the stems cache entry computed from its audio.
STEMS_REF = "stems.ref"
_ENTRY = re.compile(r"[0-9a-f]{64}\.npz")


def job_dir(settings: Settings, job_id: str) -> Path:
    return settings.jobs_path / job_id


def record_stems(settings: Settings, job_id: str, entry: str) -> None:
    """Notes which cache entry holds the job's separated stems (written, then renamed)."""
    directory = job_dir(settings, job_id)
    tmp = directory / f".{STEMS_REF}.tmp"
    tmp.write_text(entry)
    tmp.replace(directory / STEMS_REF)


def remove_job_files(settings: Settings, job_id: str) -> None:
    """Deletes the job's folder and the cached stems derived from its audio.

    Another job of the same audio shares the cache entry; it only has to separate again.
    """
    directory = job_dir(settings, job_id)
    try:
        entry = (directory / STEMS_REF).read_text().strip()
    except OSError:
        entry = ""
    # The name is checked before it becomes a path, so a bad ref cannot point elsewhere.
    if _ENTRY.fullmatch(entry):
        (settings.stems_path / entry).unlink(missing_ok=True)
    shutil.rmtree(directory, ignore_errors=True)
