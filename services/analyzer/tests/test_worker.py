import os
import signal
import subprocess
import sys
import threading
import time

from barrefree_analyzer.config import Settings
from barrefree_analyzer.worker import Worker


def test_worker_stops_cleanly() -> None:
    worker = Worker(Settings(worker_poll_interval_sec=0.01))
    thread = threading.Thread(target=worker.run)
    thread.start()
    worker.stop()
    thread.join(timeout=2)
    assert not thread.is_alive()


def test_poll_once_without_queue_does_nothing() -> None:
    assert Worker(Settings()).poll_once() is False


def test_sigterm_stops_the_worker_process() -> None:
    # A tiny poll interval maximizes the chance that SIGTERM lands inside Event.wait(),
    # which is where a naive handler calling Event.set() would deadlock.
    env = {**os.environ, "WORKER_POLL_INTERVAL_SEC": "0.001"}
    proc = subprocess.Popen(
        [sys.executable, "-m", "barrefree_analyzer.worker"],
        env=env,
        stderr=subprocess.PIPE,
        text=True,
    )
    time.sleep(1.0)
    proc.send_signal(signal.SIGTERM)
    assert proc.wait(timeout=5) == 0
    assert proc.stderr is not None
    assert "worker stopped" in proc.stderr.read()
