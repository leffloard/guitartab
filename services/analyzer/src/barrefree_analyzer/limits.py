"""Request limits without external services: a per-client token bucket and a body-size cap."""

import threading
import time
from collections import OrderedDict

from starlette.types import ASGIApp, Message, Receive, Scope, Send


class RateLimiter:
    """Token bucket per client key: ``rate`` requests per ``per_sec``, bursts up to ``rate``.

    In-process and in-memory, which is enough for one API process. Old clients are evicted so
    the table stays small.
    """

    def __init__(self, rate: int, per_sec: float, max_clients: int = 10_000) -> None:
        self.capacity = float(rate)
        self.refill = rate / per_sec
        self.max_clients = max_clients
        self._buckets: OrderedDict[str, tuple[float, float]] = OrderedDict()
        self._lock = threading.Lock()

    def allow(self, key: str, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        with self._lock:
            tokens, last = self._buckets.pop(key, (self.capacity, now))
            tokens = min(self.capacity, tokens + (now - last) * self.refill)
            allowed = tokens >= 1.0
            if allowed:
                tokens -= 1.0
            self._buckets[key] = (tokens, now)
            while len(self._buckets) > self.max_clients:
                self._buckets.popitem(last=False)
            return allowed


class BodySizeLimit:
    """Rejects request bodies over ``max_bytes`` (413) on the given path prefixes.

    Starlette spools a whole multipart upload before the endpoint runs, so the limit has to be
    enforced here, while the body is still arriving: by Content-Length when the client sends
    one, and by counting the received bytes otherwise.
    """

    def __init__(self, app: ASGIApp, max_bytes: int, paths: tuple[str, ...]) -> None:
        self.app = app
        self.max_bytes = max_bytes
        self.paths = paths

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not str(scope.get("path", "")).startswith(self.paths):
            await self.app(scope, receive, send)
            return
        for name, value in scope.get("headers", []):
            if name == b"content-length":
                try:
                    declared = int(value)
                except ValueError:
                    declared = -1
                if declared < 0 or declared > self.max_bytes:
                    await _too_large(send)
                    return
        received = 0
        exceeded = False
        replied = False

        async def limited_receive() -> Message:
            nonlocal received, exceeded
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    exceeded = True
                    raise _BodyTooLargeError
            return message

        async def guarded_send(message: Message) -> None:
            # Whatever the app answers to the aborted body (FastAPI turns the parse error into a
            # 400), the client gets a 413.
            nonlocal replied
            if not exceeded:
                await send(message)
            elif message["type"] == "http.response.start" and not replied:
                replied = True
                await _too_large(send)

        try:
            await self.app(scope, limited_receive, guarded_send)
        except _BodyTooLargeError:
            if not replied:
                await _too_large(send)


class _BodyTooLargeError(Exception):
    pass


async def _too_large(send: Send) -> None:
    body = b'{"detail":"The file is too large."}'
    await send(
        {
            "type": "http.response.start",
            "status": 413,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})
