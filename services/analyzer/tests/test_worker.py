import threading

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
