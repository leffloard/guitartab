import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

from barrefree_analyzer.config import Settings
from barrefree_analyzer.worker import Worker


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
    env = {**os.environ, "WORKER_POLL_INTERVAL_SEC": "0.001", "DATA_DIR": str(tmp_path)}
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
