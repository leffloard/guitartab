import http.server
import json
import subprocess
import threading
import time
from collections.abc import Iterator, Sequence
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from barrefree_analyzer.app import create_app
from barrefree_analyzer.config import Settings
from barrefree_analyzer.jobs import JobStore
from barrefree_analyzer.limits import RateLimiter
from barrefree_analyzer.pipeline.interfaces import (
    Audio,
    BeatGrid,
    Chromagram,
    KeyEstimate,
    RawChord,
)
from barrefree_analyzer.pipeline.run import Pipeline
from barrefree_analyzer.uploads import sniff_audio_type
from barrefree_analyzer.worker import Worker


def make_audio(path: Path, seconds: float = 3.0, fmt: str | None = None) -> Path:
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y"]
    cmd += ["-f", "lavfi", "-i", f"sine=frequency=220:duration={seconds}"]
    if fmt:
        cmd += ["-f", fmt]
    subprocess.run([*cmd, str(path)], check=True)  # noqa: S603
    return path


class FakeBeats:
    name = "fake"

    def track(self, audio: Audio, rate: int) -> BeatGrid:
        return BeatGrid(beats=[0.5, 1.0, 1.5, 2.0, 2.5], downbeats=[0.5, 2.5])


class FakeChroma:
    def chroma(self, audio: Audio, rate: int) -> Chromagram:
        times = np.arange(0, len(audio) / rate, 0.1)
        values = np.tile(np.array([1.0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0]), (len(times), 1))
        return Chromagram(times=times, values=values)


class FakeKey:
    def estimate(
        self, chroma: Chromagram, chords: Sequence[tuple[float, float, str]] = ()
    ) -> KeyEstimate | None:
        return KeyEstimate(tonic=0, mode="major", confidence=0.9)


class FakeChords:
    name = "fake"

    def recognize(self, audio: Audio, rate: int) -> list[RawChord]:
        return [RawChord(0.0, 1.4, "C:maj"), RawChord(1.4, len(audio) / rate, "G:maj")]


def fake_pipeline(_settings: Settings) -> Pipeline:
    return Pipeline(
        beat_tracker=FakeBeats(),
        chroma=FakeChroma(),
        key_estimator=FakeKey(),
        recognizers={"chordino": FakeChords()},
    )


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(data_dir=tmp_path / "data", max_upload_mb=1, max_duration_sec=60)


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(settings)) as c:
        yield c


def upload(client: TestClient, path: Path, **form: str) -> object:
    with path.open("rb") as f:
        return client.post("/api/jobs", files={"file": (path.name, f)}, data=form)


def test_upload_runs_through_the_worker_and_streams_events(
    client: TestClient, settings: Settings, tmp_path: Path
) -> None:
    response = upload(client, make_audio(tmp_path / "song.mp3"))
    assert response.status_code == 201  # type: ignore[attr-defined]
    job_id = response.json()["jobId"]  # type: ignore[attr-defined]

    queued = client.get(f"/api/jobs/{job_id}").json()
    assert queued["status"] == "queued"
    assert queued["source"] == {"kind": "upload", "name": "song.mp3", "url": None}
    assert queued["options"] == {"recognizer": "chordino", "separate": False, "transcribe": False}
    assert queued["result"] is None

    worker = Worker(settings, pipeline_factory=fake_pipeline)
    assert worker.poll_once() is True
    assert worker.poll_once() is False

    done = client.get(f"/api/jobs/{job_id}").json()
    assert done["status"] == "done", done
    result = done["result"]
    # (The MP3 encoder pads the end with silence, which comes back as a closing "N".)
    assert [c["label"] for c in result["chords"] if c["label"] != "N"] == ["C:maj", "G:maj"]
    # The change at 1.4 s snapped to the beat at 1.5 s.
    assert result["chords"][1]["start"] == 1.5
    assert result["tempoBpm"] == 120.0
    assert result["key"] == {"tonic": "C", "mode": "major", "confidence": 0.9}
    assert result["meta"]["recognizer"] == "fake"

    # Only the normalized playback copy stays on disk.
    files = sorted(p.name for p in (settings.jobs_path / job_id).iterdir())
    assert files == ["audio.mp3"]
    audio = client.get(f"/api/jobs/{job_id}/audio", headers={"Range": "bytes=0-99"})
    assert audio.status_code == 206
    assert audio.headers["content-type"] == "audio/mpeg"
    assert len(audio.content) == 100

    with client.stream("GET", f"/api/jobs/{job_id}/events") as stream:
        lines = [line for line in stream.iter_lines() if line]
    events = [line.split(": ", 1)[1] for line in lines if line.startswith("event: ")]
    assert events == ["job", "end"]
    data = [json.loads(line[6:]) for line in lines if line.startswith("data: ")]
    assert data[0]["status"] == "done"
    assert data[0]["result"] is None
    # Same camelCase keys as GET /api/jobs/{id}.
    assert set(data[0]) == set(done)
    assert data[1] == "done"


def test_rejects_non_audio_and_oversized_uploads(client: TestClient, tmp_path: Path) -> None:
    fake = tmp_path / "notes.mp3"
    fake.write_text("<html>not audio</html>")
    assert upload(client, fake).status_code == 415  # type: ignore[attr-defined]

    big = tmp_path / "big.wav"
    make_audio(big, seconds=30)  # about 2.6 MB of PCM, over the 1 MB limit
    response = upload(client, big)
    assert response.status_code == 413  # type: ignore[attr-defined]
    assert response.json()["detail"] == "The file is too large."  # type: ignore[attr-defined]


def test_rejects_separation_when_it_is_switched_off(tmp_path: Path) -> None:
    settings = Settings(data_dir=tmp_path / "data", separation=False)
    with TestClient(create_app(settings)) as client:
        response = upload(client, make_audio(tmp_path / "a.wav"), separate="true")
        assert response.status_code == 400  # type: ignore[attr-defined]
        assert client.get("/api/health").json()["features"]["separation"] is False


def test_rejects_audio_too_short_to_analyze(client: TestClient, tmp_path: Path) -> None:
    response = upload(client, make_audio(tmp_path / "blip.wav", seconds=0.02))
    assert response.status_code == 422  # type: ignore[attr-defined]


def test_rejects_songs_over_the_duration_limit(tmp_path: Path) -> None:
    settings = Settings(data_dir=tmp_path / "data", max_duration_sec=2)
    with TestClient(create_app(settings)) as client:
        response = upload(client, make_audio(tmp_path / "long.mp3", seconds=4))
    assert response.status_code == 413  # type: ignore[attr-defined]
    assert not any(settings.jobs_path.iterdir())


def test_rejects_unknown_recognizer_and_rate_limits(client: TestClient, tmp_path: Path) -> None:
    song = make_audio(tmp_path / "a.ogg")
    assert upload(client, song, recognizer="nope").status_code == 400  # type: ignore[attr-defined]
    codes = [upload(client, song).status_code for _ in range(6)]  # type: ignore[attr-defined]
    assert codes[:5] == [201] * 5
    assert codes[5] == 429


def test_unknown_job_is_404_and_delete_removes_files(
    client: TestClient, settings: Settings, tmp_path: Path
) -> None:
    assert client.get("/api/jobs/nope").status_code == 404
    assert client.get("/api/jobs/nope/events").status_code == 404
    job_id = upload(client, make_audio(tmp_path / "x.flac")).json()["jobId"]  # type: ignore[attr-defined]
    assert client.get(f"/api/jobs/{job_id}/audio").status_code == 404  # not ready yet
    assert client.delete(f"/api/jobs/{job_id}").status_code == 204
    assert client.get(f"/api/jobs/{job_id}").status_code == 404
    assert not (settings.jobs_path / job_id).exists()


def test_delete_refuses_a_running_job(
    client: TestClient, settings: Settings, tmp_path: Path
) -> None:
    job_id = upload(client, make_audio(tmp_path / "x.wav")).json()["jobId"]  # type: ignore[attr-defined]
    store = JobStore(settings.db_path)
    assert store.claim() is not None
    assert client.delete(f"/api/jobs/{job_id}").status_code == 409
    assert (settings.jobs_path / job_id).exists()
    assert store.delete_idle(job_id) is False


@pytest.fixture
def http_server(tmp_path: Path) -> Iterator[tuple[str, list[str]]]:
    """A local HTTP server with real audio on it; yields its URL and the paths requested."""
    served = tmp_path / "served"
    served.mkdir()
    make_audio(served / "secret.m4a", seconds=4, fmt="ipod")
    hits: list[str] = []

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args: object, **kwargs: object) -> None:
            super().__init__(*args, directory=str(served), **kwargs)  # type: ignore[arg-type]

        def log_message(self, format: str, *args: object) -> None:
            hits.append(self.path)

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}", hits
    finally:
        server.shutdown()
        server.server_close()


def manifests(url: str) -> dict[str, bytes]:
    """Playlists that ffmpeg's content probing would open, behind an MP3 (ID3) header."""
    id3 = b"ID3\x04\x00\x00\x00\x00\x00\x00"
    mpd = (
        '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"'
        ' profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"'
        ' mediaPresentationDuration="PT4S" minBufferTime="PT1S"><Period>'
        '<AdaptationSet mimeType="audio/mp4"><Representation id="a" bandwidth="128000"'
        f' codecs="mp4a.40.2"><BaseURL>{url}</BaseURL></Representation></AdaptationSet>'
        "</Period></MPD>"
    )
    hls = f"#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n{url}\n#EXT-X-ENDLIST\n"
    return {"dash": id3 + mpd.encode(), "hls": id3 + hls.encode()}


def test_uploaded_playlists_never_make_ffmpeg_fetch_anything(
    client: TestClient, settings: Settings, http_server: tuple[str, list[str]]
) -> None:
    base, hits = http_server
    for kind, body in manifests(f"{base}/secret.m4a").items():
        response = client.post("/api/jobs", files={"file": (f"{kind}.mp3", body)})
        assert response.status_code == 415, kind
    # The worker re-probes what is on disk (the API's check could be bypassed by a bug).
    store = JobStore(settings.db_path)
    worker = Worker(settings, pipeline_factory=fake_pipeline)
    secret = settings.data_dir.parent / "served" / "secret.m4a"
    payloads = {**manifests(f"{base}/secret.m4a"), "local": manifests(f"file:{secret}")["dash"]}
    for kind, body in payloads.items():
        directory = settings.jobs_path / kind
        directory.mkdir(parents=True)
        (directory / "upload.mp3").write_bytes(body)
        store.create(job_id=kind, source={"kind": "upload", "name": kind}, options={})
        assert worker.poll_once() is True
        job = store.get(kind)
        assert job is not None
        assert job.status == "failed", kind
        assert not (directory / "audio.mp3").exists()
    assert hits == []


def test_worker_reports_failures_and_cleans_up(settings: Settings, tmp_path: Path) -> None:
    store = JobStore(settings.db_path)
    broken = settings.jobs_path / "broken"
    broken.mkdir(parents=True)
    (broken / "upload.mp3").write_bytes(b"ID3 garbage")
    store.create(job_id="broken", source={"kind": "upload", "name": "x"}, options={})
    worker = Worker(settings, pipeline_factory=fake_pipeline)
    assert worker.poll_once() is True
    job = store.get("broken")
    assert job is not None
    assert job.status == "failed"
    assert job.error is not None
    assert job.error.startswith("The audio could not be processed")

    # After the TTL the job and its directory are gone.
    worker.cleanup(now=time.time() + settings.temp_file_ttl_sec + 120)
    assert store.get("broken") is None
    assert not broken.exists()


def test_store_claims_each_job_once_and_fails_stale_jobs(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "q.sqlite3")
    for i in range(3):
        store.create(job_id=f"j{i}", source={}, options={})
    claimed = [store.claim() for _ in range(4)]
    assert [j.id if j else None for j in claimed] == ["j0", "j1", "j2", None]
    assert store.count_pending() == 3
    assert store.fail_stale(time.time() + 1) == ["j0", "j1", "j2"]
    assert store.count_pending() == 0


def test_rate_limiter_refills() -> None:
    limiter = RateLimiter(2, 60.0)
    assert [limiter.allow("a", now=0.0) for _ in range(3)] == [True, True, False]
    assert limiter.allow("b", now=0.0) is True
    assert limiter.allow("a", now=30.0) is True


@pytest.mark.parametrize("fmt", ["mp3", "wav", "flac", "ogg", "m4a"])
def test_sniffs_ffmpeg_output(tmp_path: Path, fmt: str) -> None:
    path = make_audio(tmp_path / f"t.{fmt}", seconds=1, fmt="ipod" if fmt == "m4a" else None)
    assert sniff_audio_type(path.read_bytes()[:12]) == fmt


def test_oversized_chunked_upload_without_length_is_413(client: TestClient) -> None:
    def body() -> Iterator[bytes]:
        yield b'--b\r\nContent-Disposition: form-data; name="file"; filename="x.wav"\r\n\r\n'
        for _ in range(3):  # 3 MB against a 1 MB limit
            yield b"\0" * 2**20
        yield b"\r\n--b--\r\n"

    response = client.post(
        "/api/jobs", content=body(), headers={"content-type": "multipart/form-data; boundary=b"}
    )
    assert response.status_code == 413
