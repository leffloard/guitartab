import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

from barrefree_analyzer.config import Settings
from barrefree_analyzer.jobs import JobStore
from barrefree_analyzer.pipeline.run import NoRecognizerError, Pipeline
from barrefree_analyzer.worker import NO_RECOGNIZER, Worker
from tests.test_jobs_api import fake_pipeline, make_audio


def test_worker_stops_cleanly(tmp_path: Path) -> None:
    worker = Worker(Settings(data_dir=tmp_path, worker_poll_interval_sec=0.01))
    thread = threading.Thread(target=worker.run)
    thread.start()
    worker.stop()
    thread.join(timeout=2)
    assert not thread.is_alive()


def test_poll_once_without_queue_does_nothing(tmp_path: Path) -> None:
    assert Worker(Settings(data_dir=tmp_path)).poll_once() is False


def test_sigterm_stops_the_worker_process(tmp_path: Path) -> None:
    # A tiny poll interval maximizes the chance that SIGTERM lands inside Event.wait(),
    # which is where a naive handler calling Event.set() would deadlock.
    env = {
        **os.environ,
        "WORKER_POLL_INTERVAL_SEC": "0.001",
        "DATA_DIR": str(tmp_path),
        # Nothing to download at start-up (the worker fetches missing weights).
        "MODEL_DIR": str(tmp_path / "models"),
        "BEAT_TRACKER": "librosa",
        "RECOGNIZERS": "chordino",
        "SEPARATION": "false",
        "TRANSCRIPTION": "false",
    }
    proc = subprocess.Popen(
        [sys.executable, "-m", "barrefree_analyzer.worker"],
        env=env,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert proc.stderr is not None
    # Wait for the handlers to be installed (imports take a while on a busy machine).
    lines = []
    for line in proc.stderr:
        lines.append(line)
        if "worker started" in line:
            break
    time.sleep(0.2)
    proc.send_signal(signal.SIGTERM)
    assert proc.wait(timeout=10) == 0
    assert "worker stopped" in "".join(lines) + proc.stderr.read()


def queue(settings: Settings, job_id: str, tmp_path: Path, **options: object) -> JobStore:
    store = JobStore(settings.db_path)
    directory = settings.jobs_path / job_id
    directory.mkdir(parents=True)
    make_audio(directory / "upload.wav")
    store.create(job_id=job_id, source={"kind": "upload", "name": "x"}, options=options)
    return store


def test_a_recognizer_that_did_not_load_fails_the_job_before_decoding(tmp_path: Path) -> None:
    settings = Settings(data_dir=tmp_path)
    store = queue(settings, "j1", tmp_path, recognizer="btc")
    Worker(settings, pipeline_factory=fake_pipeline).poll_once()
    job = store.get("j1")
    assert job is not None
    assert job.status == "failed"
    assert job.error == "The chord recognizer 'btc' is not available on this server."
    assert (settings.jobs_path / "j1" / "upload.wav").exists()  # never decoded


def test_without_any_recognizer_jobs_fail_clearly_and_loading_backs_off(tmp_path: Path) -> None:
    settings = Settings(data_dir=tmp_path)
    calls = []

    def broken(_settings: Settings) -> Pipeline:
        calls.append(1)
        raise NoRecognizerError("nothing loads")

    worker = Worker(settings, pipeline_factory=broken)
    for job_id in ("j1", "j2"):
        store = queue(settings, job_id, tmp_path)
        worker.poll_once()
        job = store.get(job_id)
        assert job is not None
        assert job.error == NO_RECOGNIZER
    assert len(calls) == 1  # the second job did not reload every model


def test_the_pipeline_is_rebuilt_when_a_model_file_changes(tmp_path: Path) -> None:
    settings = Settings(data_dir=tmp_path, model_dir=tmp_path / "models")
    calls = []

    def counting(s: Settings) -> Pipeline:
        calls.append(1)
        return fake_pipeline(s)

    worker = Worker(settings, pipeline_factory=counting)
    queue(settings, "j1", tmp_path)
    worker.poll_once()
    queue(settings, "j2", tmp_path)
    worker.poll_once()
    assert len(calls) == 1
    weights = tmp_path / "models" / "btc" / "btc_model_large_voca.pt"
    weights.parent.mkdir(parents=True)
    weights.write_bytes(b"new")  # e.g. barrefree-download-models run by hand
    queue(settings, "j3", tmp_path)
    worker.poll_once()
    assert len(calls) == 2
