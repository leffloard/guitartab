import os
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from pathlib import Path

import pytest

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


def test_a_recognizer_that_did_not_load_fails_the_job_before_decoding(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = Settings(data_dir=tmp_path)
    store = queue(settings, "j1", tmp_path, recognizer="btc")

    def no_decoding(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("decoded although the job could not run")

    monkeypatch.setattr("barrefree_analyzer.worker.decode", no_decoding)
    Worker(settings, pipeline_factory=fake_pipeline).poll_once()
    job = store.get("j1")
    assert job is not None
    assert job.status == "failed"
    assert job.error == "The chord recognizer 'btc' is not available on this server."
    # A failed analysis keeps no audio.
    assert not (settings.jobs_path / "j1").exists()


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


def test_a_restarted_worker_fails_the_jobs_it_was_running(tmp_path: Path) -> None:
    settings = Settings(data_dir=tmp_path, worker_id="w1", worker_poll_interval_sec=0.01)
    store = JobStore(settings.db_path)
    for job_id in ("mine", "theirs"):
        store.create(job_id=job_id, source={}, options={})
        (settings.jobs_path / job_id).mkdir(parents=True)
    assert store.claim("w1") is not None
    assert store.claim("w2") is not None
    worker = Worker(settings)
    thread = threading.Thread(target=worker.run)
    thread.start()
    worker.stop()
    thread.join(timeout=5)
    mine, theirs = store.get("mine"), store.get("theirs")
    assert mine is not None
    assert theirs is not None
    assert mine.status == "failed"
    assert mine.error == "The analysis was interrupted. Please try again."
    assert theirs.status == "running"  # another worker's job is left alone
    assert not (settings.jobs_path / "mine").exists()  # an interrupted job keeps no audio
    assert (settings.jobs_path / "theirs").exists()


def test_an_old_database_gets_the_new_column(tmp_path: Path) -> None:
    import sqlite3

    db = tmp_path / "jobs.sqlite3"
    with sqlite3.connect(db) as conn:
        conn.execute(
            "CREATE TABLE jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, stage TEXT NOT NULL,"
            " progress REAL NOT NULL DEFAULT 0, error TEXT, source TEXT NOT NULL,"
            " options TEXT NOT NULL, result TEXT, attempts INTEGER NOT NULL DEFAULT 0,"
            " created_at REAL NOT NULL, updated_at REAL NOT NULL)"
        )
        conn.execute(
            "INSERT INTO jobs (id, status, stage, source, options, created_at, updated_at)"
            " VALUES ('old', 'queued', 'queued', '{}', '{}', 0, 0)"
        )
    store = JobStore(db)
    JobStore(db)  # opening it again (the API and the worker both do) is fine
    job = store.claim("w1")
    assert job is not None
    assert job.id == "old"


def test_workers_sharing_an_id_get_distinct_ids(tmp_path: Path) -> None:
    """Replicas of one compose service share WORKER_ID: the second becomes worker-1-2."""
    settings = Settings(data_dir=tmp_path, worker_id="worker-1")
    first, second, third = Worker(settings), Worker(settings), Worker(settings)
    assert first.take_id() == "worker-1"
    assert second.take_id() == "worker-1-2"
    # A worker that ends releases its id; the next one to start gets it back.
    assert first._id_lock is not None
    first._id_lock.close()
    assert third.take_id() == "worker-1"


def test_a_second_replica_leaves_the_running_job_of_the_first_alone(tmp_path: Path) -> None:
    settings = Settings(data_dir=tmp_path, worker_id="worker-1", worker_poll_interval_sec=0.01)
    store = JobStore(settings.db_path)
    store.create(job_id="live", source={}, options={})
    first = Worker(settings)
    first.take_id()
    assert store.claim(first.worker_id) is not None
    second = Worker(settings)
    thread = threading.Thread(target=second.run)
    thread.start()
    second.stop()
    thread.join(timeout=5)
    job = store.get("live")
    assert job is not None
    assert job.status == "running"
    assert second.worker_id == "worker-1-2"


def test_a_job_failed_meanwhile_is_not_brought_back(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "q.sqlite3")
    store.create(job_id="j", source={}, options={})
    assert store.claim("w1") is not None
    assert store.fail_interrupted("w1") == ["j"]
    assert store.finish("j", "{}", "w1") is False
    store.set_stage("j", "chords", 0.5, "w1")
    job = store.get("j")
    assert job is not None
    assert (job.status, job.stage) == ("failed", "failed")


def test_clean_up_survives_a_job_folder_deleted_during_the_scan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = Settings(data_dir=tmp_path)
    (settings.jobs_path / "kept").mkdir(parents=True)
    gone = settings.jobs_path / "gone"
    real_iterdir = Path.iterdir

    def iterdir_then_delete(self: Path) -> Iterator[Path]:
        entries = list(real_iterdir(self))
        if self == settings.jobs_path:
            entries.append(gone)  # listed, then removed by a DELETE before its stat()
        return iter(entries)

    monkeypatch.setattr(Path, "iterdir", iterdir_then_delete)
    worker = Worker(settings)
    worker.cleanup(now=time.time() + 7200)  # no FileNotFoundError
    assert not (settings.jobs_path / "kept").exists()  # the orphan sweep went on
