"""Background worker that runs analysis jobs.

M0 skeleton: the SQLite job queue and the analysis pipeline arrive in M3. For now the
worker only runs its polling loop and shuts down cleanly on SIGTERM/SIGINT, so that the
docker-compose topology (api + worker sharing a volume) can already be exercised.
"""

import logging
import signal
import threading
from types import FrameType

from barrefree_analyzer.config import Settings, get_settings

log = logging.getLogger("barrefree.worker")


class Worker:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._stop = threading.Event()

    def poll_once(self) -> bool:
        """Claims and runs at most one job. Returns True if a job was processed."""
        return False  # no job queue yet (M3)

    def run(self) -> None:
        log.info("worker started (data_dir=%s)", self.settings.data_dir)
        while not self._stop.is_set():
            if not self.poll_once():
                self._stop.wait(self.settings.worker_poll_interval_sec)
        log.info("worker stopped")

    def stop(self) -> None:
        self._stop.set()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    worker = Worker(get_settings())

    def _handle(signum: int, _frame: FrameType | None) -> None:
        log.info("received signal %d, shutting down", signum)
        worker.stop()

    signal.signal(signal.SIGTERM, _handle)
    signal.signal(signal.SIGINT, _handle)
    worker.run()


if __name__ == "__main__":
    main()
