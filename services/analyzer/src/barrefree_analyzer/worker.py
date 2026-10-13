"""Background worker: claims jobs from the SQLite queue and runs the analysis pipeline.

Run one or more of these next to the API (they share the data volume). The worker also deletes
expired jobs and their files: no user audio stays on the server longer than the configured TTL.
"""

import logging
import shutil
import signal
import threading
import time
from collections.abc import Callable
from types import FrameType

from barrefree_analyzer.audio import (
    ANALYSIS_RATE,
    MIN_DURATION_SEC,
    PLAYBACK_NAME,
    AudioError,
    decode,
    kind_of,
    make_playback_copy,
    probe,
)
from barrefree_analyzer.config import Settings, get_settings
from barrefree_analyzer.jobs import Job, JobStore
from barrefree_analyzer.pipeline.run import Pipeline
from barrefree_analyzer.schema import JobOptions

log = logging.getLogger("barrefree.worker")

#: Seconds between two clean-up passes.
_CLEANUP_EVERY_SEC = 60.0
#: An upload directory with no job row (the API died mid-upload) is removed after this long.
_ORPHAN_AFTER_SEC = 60.0 * 60


class UserFacingError(Exception):
    """An error whose message can be shown to the user as is."""


class Worker:
    def __init__(
        self,
        settings: Settings,
        pipeline_factory: Callable[[Settings], Pipeline] | None = None,
    ) -> None:
        self.settings = settings
        self.store = JobStore(settings.db_path)
        self._pipeline_factory = pipeline_factory
        self._pipeline: Pipeline | None = None
        self._stop = threading.Event()
        self._last_cleanup = 0.0

    @property
    def pipeline(self) -> Pipeline:
        # Built on first use: loading models takes seconds and needs no time at startup.
        if self._pipeline is None:
            if self._pipeline_factory is None:
                from barrefree_analyzer.pipeline.factory import build_pipeline

                self._pipeline_factory = build_pipeline
            self._pipeline = self._pipeline_factory(self.settings)
        return self._pipeline

    def poll_once(self) -> bool:
        """Claims and runs at most one job. Returns True if a job was processed."""
        self.cleanup()
        job = self.store.claim()
        if job is None:
            return False
        started = time.monotonic()
        try:
            self.process(job)
        except UserFacingError as exc:
            log.info("job %s failed: %s", job.id, exc)
            self.store.fail(job.id, str(exc))
        except AudioError as exc:
            log.info("job %s failed: %s", job.id, exc)
            self.store.fail(job.id, f"The audio could not be processed: {exc}.")
        except Exception:
            log.exception("job %s crashed", job.id)
            self.store.fail(job.id, "The analysis failed unexpectedly.")
        else:
            log.info("job %s done in %.1f s", job.id, time.monotonic() - started)
        return True

    def process(self, job: Job) -> None:
        directory = self.settings.jobs_path / job.id
        uploads = sorted(directory.glob("upload.*"))
        if not uploads:
            raise UserFacingError("The uploaded file is missing. Please upload it again.")
        upload = uploads[0]
        max_sec = float(self.settings.max_duration_sec)
        kind = kind_of(upload)
        info = probe(upload, kind)
        if info.duration_sec > max_sec + 1:
            raise UserFacingError("The song is too long.")
        if info.duration_sec < MIN_DURATION_SEC:
            raise UserFacingError("The audio is too short to analyze.")
        self.store.set_stage(job.id, "decoding", 0.02)
        audio = decode(upload, ANALYSIS_RATE, max_sec=max_sec, kind=kind)
        make_playback_copy(upload, directory / PLAYBACK_NAME, max_sec=max_sec, kind=kind)
        # The original upload is not needed any more; keep only the normalized copy.
        upload.unlink(missing_ok=True)
        options = JobOptions.model_validate(job.options)
        result = self.pipeline.run(
            audio,
            ANALYSIS_RATE,
            options,
            progress=lambda stage, fraction: self.store.set_stage(job.id, stage, fraction),
        )
        self.store.finish(job.id, result.model_dump_json(by_alias=True))

    def cleanup(self, now: float | None = None) -> None:
        now = time.time() if now is None else now
        if now - self._last_cleanup < _CLEANUP_EVERY_SEC:
            return
        self._last_cleanup = now
        for job_id in self.store.fail_stale(now - self.settings.job_timeout_sec):
            log.warning("job %s timed out", job_id)
        for job_id in self.store.expired(now - self.settings.temp_file_ttl_sec):
            shutil.rmtree(self.settings.jobs_path / job_id, ignore_errors=True)
            self.store.delete(job_id)
        jobs_path = self.settings.jobs_path
        if jobs_path.is_dir():
            for directory in jobs_path.iterdir():
                stale = now - directory.stat().st_mtime > _ORPHAN_AFTER_SEC
                if directory.is_dir() and stale and self.store.get(directory.name) is None:
                    shutil.rmtree(directory, ignore_errors=True)

    def run(self) -> None:
        log.info("worker started (data_dir=%s)", self.settings.data_dir)
        while not self._stop.is_set():
            if not self.poll_once():
                self._stop.wait(self.settings.worker_poll_interval_sec)
        log.info("worker stopped")

    def stop(self) -> None:
        self._stop.set()


def ensure_models(settings: Settings) -> None:
    """Downloads missing model weights. Offline, the pipeline falls back (librosa beats)."""
    from barrefree_analyzer.models import ensure_model, required_models

    for key in required_models(settings):
        try:
            ensure_model(settings, key)
        except Exception as exc:  # any failure here only degrades quality
            log.warning("could not get model %s: %s", key, exc)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = get_settings()
    ensure_models(settings)
    worker = Worker(settings)

    def _handle(signum: int, _frame: FrameType | None) -> None:
        log.info("received signal %d, shutting down", signum)
        # Event.set() takes a non-reentrant lock that the interrupted main thread may be holding
        # inside Event.wait(); calling it directly from the handler could deadlock.
        threading.Thread(target=worker.stop, name="worker-stop", daemon=True).start()

    signal.signal(signal.SIGTERM, _handle)
    signal.signal(signal.SIGINT, _handle)
    worker.run()


if __name__ == "__main__":
    main()
