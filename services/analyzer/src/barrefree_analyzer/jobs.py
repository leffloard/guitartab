"""SQLite job queue shared by the API process and the worker process.

One table, one row per job. SQLite in WAL mode lets the API read while the worker writes, and a
single ``UPDATE ... RETURNING`` statement claims the oldest queued job atomically, so several
workers never run the same job. No Redis or broker is needed at this scale.
"""

import json
import secrets
import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from barrefree_analyzer.schema import JobStage, JobStatus

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT PRIMARY KEY,
    status      TEXT NOT NULL,
    stage       TEXT NOT NULL,
    progress    REAL NOT NULL DEFAULT 0,
    error       TEXT,
    source      TEXT NOT NULL,
    options     TEXT NOT NULL,
    result      TEXT,
    attempts    INTEGER NOT NULL DEFAULT 0,
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL,
    claimed_by  TEXT
);
CREATE INDEX IF NOT EXISTS jobs_queue ON jobs (status, created_at);
"""


@dataclass(frozen=True)
class Job:
    id: str
    status: JobStatus
    stage: JobStage
    progress: float
    error: str | None
    source: dict[str, Any]
    options: dict[str, Any]
    result: str | None
    attempts: int
    created_at: float
    updated_at: float


def _row_to_job(row: sqlite3.Row) -> Job:
    return Job(
        id=row["id"],
        status=cast(JobStatus, row["status"]),
        stage=cast(JobStage, row["stage"]),
        progress=row["progress"],
        error=row["error"],
        source=json.loads(row["source"]),
        options=json.loads(row["options"]),
        result=row["result"],
        attempts=row["attempts"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def new_job_id() -> str:
    """Unguessable id: there are no accounts, so knowing the id is what grants access."""
    return secrets.token_urlsafe(16)


class JobStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(_SCHEMA)
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(jobs)")}
            if "claimed_by" not in columns:  # a database from before M8
                try:
                    conn.execute("ALTER TABLE jobs ADD COLUMN claimed_by TEXT")
                except sqlite3.OperationalError as exc:  # the other process added it first
                    if "duplicate column" not in str(exc):
                        raise

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        # Autocommit mode: every statement is its own transaction, which is all we need.
        conn = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        try:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA busy_timeout=30000")
            yield conn
        finally:
            conn.close()

    def create(self, *, source: dict[str, Any], options: dict[str, Any], job_id: str) -> Job:
        now = time.time()
        with self._connect() as conn:
            row = conn.execute(
                "INSERT INTO jobs (id, status, stage, source, options, created_at, updated_at)"
                " VALUES (?, 'queued', 'queued', ?, ?, ?, ?) RETURNING *",
                (job_id, json.dumps(source), json.dumps(options), now, now),
            ).fetchone()
        return _row_to_job(row)

    def get(self, job_id: str) -> Job | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return _row_to_job(row) if row else None

    def claim(self, worker: str | None = None) -> Job | None:
        """Atomically moves the oldest queued job to 'running' and returns it."""
        now = time.time()
        with self._connect() as conn:
            row = conn.execute(
                "UPDATE jobs SET status = 'running', stage = 'decoding', progress = 0,"
                " attempts = attempts + 1, updated_at = ?, claimed_by = ?"
                " WHERE id = (SELECT id FROM jobs WHERE status = 'queued'"
                "             ORDER BY created_at, id LIMIT 1)"
                " AND status = 'queued' RETURNING *",
                (now, worker),
            ).fetchone()
        return _row_to_job(row) if row else None

    def set_stage(self, job_id: str, stage: JobStage, progress: float) -> None:
        with self._connect() as conn:
            conn.execute(
                "UPDATE jobs SET stage = ?, progress = ?, updated_at = ?"
                " WHERE id = ? AND status = 'running'",
                (stage, min(max(progress, 0.0), 1.0), time.time(), job_id),
            )

    def finish(self, job_id: str, result_json: str) -> None:
        with self._connect() as conn:
            conn.execute(
                "UPDATE jobs SET status = 'done', stage = 'done', progress = 1, result = ?,"
                " error = NULL, updated_at = ? WHERE id = ?",
                (result_json, time.time(), job_id),
            )

    def fail(self, job_id: str, error: str) -> None:
        with self._connect() as conn:
            conn.execute(
                "UPDATE jobs SET status = 'failed', stage = 'failed', error = ?, updated_at = ?"
                " WHERE id = ?",
                (error[:500], time.time(), job_id),
            )

    def count_pending(self) -> int:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT COUNT(*) FROM jobs WHERE status IN ('queued', 'running')"
            ).fetchone()
        return int(row[0])

    def fail_stale(self, older_than: float) -> list[str]:
        """Fails jobs left 'running' by a worker that died (no update since ``older_than``)."""
        with self._connect() as conn:
            rows = conn.execute(
                "UPDATE jobs SET status = 'failed', stage = 'failed',"
                " error = 'The analysis was interrupted. Please try again.', updated_at = ?"
                " WHERE status = 'running' AND updated_at < ? RETURNING id",
                (time.time(), older_than),
            ).fetchall()
        return [r["id"] for r in rows]

    def fail_interrupted(self, worker: str) -> list[str]:
        """Fails the jobs this worker was running when it stopped (killed, out of memory).

        Called when the worker starts: nothing of its own can still be running then.
        """
        with self._connect() as conn:
            rows = conn.execute(
                "UPDATE jobs SET status = 'failed', stage = 'failed',"
                " error = 'The analysis was interrupted. Please try again.', updated_at = ?"
                " WHERE status = 'running' AND claimed_by = ? RETURNING id",
                (time.time(), worker),
            ).fetchall()
        return [r["id"] for r in rows]

    def expired(self, older_than: float) -> list[str]:
        """Finished or failed jobs last touched before ``older_than``."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id FROM jobs WHERE status IN ('done', 'failed') AND updated_at < ?",
                (older_than,),
            ).fetchall()
        return [r["id"] for r in rows]

    def delete(self, job_id: str) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM jobs WHERE id = ?", (job_id,))

    def delete_idle(self, job_id: str) -> bool:
        """Deletes the job unless a worker is running it, in one statement.

        Checking the status first and deleting afterwards would race with ``claim``: a worker
        could start the job in between and then write into a directory that is being removed.
        """
        with self._connect() as conn:
            row = conn.execute(
                "DELETE FROM jobs WHERE id = ? AND status != 'running' RETURNING id", (job_id,)
            ).fetchone()
        return row is not None
