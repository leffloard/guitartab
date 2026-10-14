"""Background worker: claims jobs from the SQLite queue and runs the analysis pipeline.

Run one or more of these next to the API (they share the data volume). The worker also deletes
expired jobs and their files: no user audio stays on the server longer than the configured TTL.
"""

import logging
import signal
import threading
import time
from collections.abc import Callable
from pathlib import Path
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
from barrefree_analyzer.jobfiles import job_dir, record_stems, remove_job_files
from barrefree_analyzer.jobs import Job, JobStore
from barrefree_analyzer.models import fingerprint
from barrefree_analyzer.pipeline.interfaces import StemsCache
from barrefree_analyzer.pipeline.run import NoRecognizerError, Pipeline
from barrefree_analyzer.schema import JobOptions, JobSource
from barrefree_analyzer.urlimport import ImportFailedError, VideoSource, parse_link

log = logging.getLogger("barrefree.worker")

#: Seconds between two clean-up passes.
_CLEANUP_EVERY_SEC = 60.0
#: An upload directory with no job row (the API died mid-upload) is removed after this long.
_ORPHAN_AFTER_SEC = 60.0 * 60
#: After a pipeline with no usable chord recognizer, wait this long before loading again.
_RETRY_LOAD_SEC = 60.0
NO_RECOGNIZER = "Chord recognition is not available on this server right now. Try again later."


class UserFacingError(Exception):
    """An error whose message can be shown to the user as is."""


class Worker:
    def __init__(
        self,
        settings: Settings,
        pipeline_factory: Callable[[Settings], Pipeline] | None = None,
        video_source: Callable[[], VideoSource] | None = None,
    ) -> None:
        self.settings = settings
        self._video_source = video_source
        self.store = JobStore(settings.db_path)
        self._pipeline_factory = pipeline_factory
        self._pipeline: Pipeline | None = None
        self._models: object = None  # models.fingerprint() when the pipeline was built
        self._load_failed_at: float | None = None
        self._stop = threading.Event()
        self._last_cleanup = 0.0

    @property
    def pipeline(self) -> Pipeline:
        """The models, loaded on first use and again whenever a model file changes.

        Parts that fail to load are left out (see ``pipeline.factory``). When no chord
        recognizer loads, jobs fail with a clear message, and loading is retried after a
        pause rather than for every job.
        """
        models = fingerprint(self.settings)
        if self._pipeline is not None and models == self._models:
            return self._pipeline
        now = time.monotonic()
        failed = self._load_failed_at
        if failed is not None and models == self._models and now - failed < _RETRY_LOAD_SEC:
            raise UserFacingError(NO_RECOGNIZER)
        if self._pipeline_factory is None:
            from barrefree_analyzer.pipeline.factory import build_pipeline

            self._pipeline_factory = build_pipeline
        self._pipeline, self._models = None, models
        try:
            self._pipeline = self._pipeline_factory(self.settings)
        except NoRecognizerError:
            log.exception("no chord recognizer could be loaded")
            self._load_failed_at = now
            raise UserFacingError(NO_RECOGNIZER) from None
        self._load_failed_at = None
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
        except ImportFailedError as exc:
            log.info("job %s failed: %s", job.id, exc)
            self.store.fail(job.id, f"The video could not be downloaded: {exc}")
        except Exception:
            log.exception("job %s crashed", job.id)
            self.store.fail(job.id, "The analysis failed unexpectedly.")
        else:
            log.info("job %s done in %.1f s", job.id, time.monotonic() - started)
        return True

    def download(self, job: Job, directory: Path) -> None:
        """Fetches the audio of a confirmed link (``ENABLE_URL_IMPORT``) as the job's upload."""
        source = JobSource.model_validate(job.source)
        if not self.settings.enable_url_import:
            raise UserFacingError("Importing from links is switched off on this server.")
        link = parse_link(source.url or "")
        if link.kind != "youtube":
            raise UserFacingError("Only a YouTube video can be downloaded.")
        if self._video_source is None:
            from barrefree_analyzer.urlimport import YtDlpSource

            cookies = self.settings.url_import_cookies
            self._video_source = lambda: YtDlpSource(cookies=cookies)
        self.store.set_stage(job.id, "downloading", 0.01)
        self._video_source().download(
            link.id,
            directory,
            max_bytes=self.settings.max_upload_mb * 2**20,
            max_sec=float(self.settings.max_duration_sec),
        )

    def process(self, job: Job) -> None:
        directory = job_dir(self.settings, job.id)
        options = JobOptions.model_validate(job.options)
        # Checked before any download or decoding: the API offers what is installed, but the
        # worker is the one that knows what actually loaded.
        pipeline = self.pipeline
        if options.recognizer not in pipeline.recognizers:
            raise UserFacingError(
                f"The chord recognizer '{options.recognizer}' is not available on this server."
            )
        if options.separate and pipeline.separator is None:
            log.warning("job %s asked for separation, which is unavailable", job.id)
        if options.transcribe and pipeline.transcriber is None:
            log.warning("job %s asked for notes, which are unavailable", job.id)
        if job.source.get("kind") == "url" and not any(directory.glob("upload.*")):
            self.download(job, directory)
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
        if options.separate and isinstance(pipeline.separator, StemsCache):
            # Recorded first, so that deleting the job also deletes the stems.
            record_stems(self.settings, job.id, pipeline.separator.entry_name(audio, ANALYSIS_RATE))
        result = pipeline.run(
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
        ttl = self.settings.temp_file_ttl_sec
        for job_id in self.store.expired(now - ttl):
            remove_job_files(self.settings, job_id)
            self.store.delete(job_id)
        # Derived audio (separated stems) follows the same TTL as the job files.
        cache = self.settings.cache_path
        if cache.is_dir():
            for entry in cache.rglob("*"):
                try:
                    if entry.is_file() and now - entry.stat().st_mtime > ttl:
                        entry.unlink()
                except FileNotFoundError:
                    pass
        jobs_path = self.settings.jobs_path
        if jobs_path.is_dir():
            for directory in jobs_path.iterdir():
                stale = now - directory.stat().st_mtime > _ORPHAN_AFTER_SEC
                if directory.is_dir() and stale and self.store.get(directory.name) is None:
                    remove_job_files(self.settings, directory.name)

    def run(self) -> None:
        log.info("worker started (data_dir=%s)", self.settings.data_dir)
        while not self._stop.is_set():
            if not self.poll_once():
                self._stop.wait(self.settings.worker_poll_interval_sec)
        log.info("worker stopped")

    def stop(self) -> None:
        self._stop.set()


def ensure_models(settings: Settings) -> None:
    """Downloads missing or damaged model weights.

    A model that cannot be fetched only removes its feature (librosa beats instead of
    beat_this; no BTC, separation or notes); the log and /api/health say what is available.
    """
    from barrefree_analyzer.models import availability, ensure_model, required_models

    for key in required_models(settings):
        try:
            ensure_model(settings, key)
        except Exception as exc:  # any failure here only degrades the service
            log.warning("could not get model %s: %s", key, exc)
    log.info("available: %s", availability(settings))


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
