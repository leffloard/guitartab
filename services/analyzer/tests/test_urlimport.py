import json
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from barrefree_analyzer.app import create_app
from barrefree_analyzer.config import Settings
from barrefree_analyzer.jobs import JobStore
from barrefree_analyzer.schema import Candidate
from barrefree_analyzer.urlimport import (
    ImportFailedError,
    Link,
    LinkError,
    failure_message,
    parse_link,
    resolve,
    spotify_track,
)
from barrefree_analyzer.worker import Worker
from tests.conftest import fake_install
from tests.test_jobs_api import fake_pipeline

VIDEO = "dQw4w9WgXcQ"
TRACK = "4cOdK2wGLETKBW3PvgPWqT"


@pytest.mark.parametrize(
    ("text", "link"),
    [
        (f"https://www.youtube.com/watch?v={VIDEO}", Link("youtube", VIDEO)),
        (f"https://youtube.com/watch?v={VIDEO}&t=42s&list=PL123", Link("youtube", VIDEO)),
        (f"https://music.youtube.com/watch?v={VIDEO}", Link("youtube", VIDEO)),
        (f"youtu.be/{VIDEO}?si=abc", Link("youtube", VIDEO)),
        (f"https://www.youtube.com/shorts/{VIDEO}", Link("youtube", VIDEO)),
        (f"https://open.spotify.com/track/{TRACK}?si=x", Link("spotify", TRACK)),
        (f"https://open.spotify.com/intl-tr/track/{TRACK}", Link("spotify", TRACK)),
    ],
)
def test_parses_supported_links(text: str, link: Link) -> None:
    assert parse_link(text) == link


@pytest.mark.parametrize(
    "text",
    [
        f"https://youtube.com@evil.example/watch?v={VIDEO}",  # user-info trick
        f"https://www.youtube.com.evil.example/watch?v={VIDEO}",
        f"https://evil.example/?u=https://youtu.be/{VIDEO}",
        f"https://www.youtube.com:8443/watch?v={VIDEO}",
        f"file:///etc/passwd?v={VIDEO}",
        f"javascript:alert(1)//youtu.be/{VIDEO}",
        "https://www.youtube.com/watch?v=short",
        "https://www.youtube.com/playlist?list=PL123",
        f"https://open.spotify.com/album/{TRACK}",
        "https://open.spotify.com/track/../../oembed",
        "x" * 600,
    ],
)
def test_rejects_everything_else(text: str) -> None:
    with pytest.raises(LinkError):
        parse_link(text)


PAGE = (
    '<html><head><meta property="og:description" content="Fallback Artist · Album · Song">'
    '<meta name="music:musician_description" content="Some Artist &amp; Band"></head></html>'
)


def fake_fetch(calls: list[str]):  # type: ignore[no-untyped-def]
    def fetch(url: str) -> str:
        calls.append(url)
        if url.startswith("https://open.spotify.com/oembed?url="):
            return json.dumps({"title": "Placeholder Song", "type": "rich"})
        if url == f"https://open.spotify.com/track/{TRACK}":
            return PAGE
        raise AssertionError(f"unexpected fetch {url}")

    return fetch


def test_spotify_metadata_comes_from_fixed_urls_built_from_the_id() -> None:
    calls: list[str] = []
    assert spotify_track(TRACK, fake_fetch(calls)) == ("Placeholder Song", "Some Artist & Band")
    assert calls == [
        f"https://open.spotify.com/oembed?url=https%3A%2F%2Fopen.spotify.com%2Ftrack%2F{TRACK}",
        f"https://open.spotify.com/track/{TRACK}",
    ]
    with pytest.raises(ImportFailedError):
        spotify_track(TRACK, lambda _url: "not json")


class FakeSource:
    def __init__(self, audio: Path | None = None) -> None:
        self.audio = audio
        self.queries: list[str] = []
        self.downloads: list[str] = []

    def candidate(self, video_id: str, title: str) -> Candidate:
        url = f"https://www.youtube.com/watch?v={video_id}"
        return Candidate(
            video_id=video_id, title=title, channel="Channel", duration_sec=200, url=url
        )

    def search(self, query: str, limit: int) -> list[Candidate]:
        self.queries.append(query)
        return [self.candidate("aaaaaaaaaaa", "First"), self.candidate("bbbbbbbbbbb", "Second")]

    def lookup(self, video_id: str) -> Candidate:
        return self.candidate(video_id, "Direct")

    def download(self, video_id: str, directory: Path, max_bytes: int, max_sec: float) -> Path:
        self.downloads.append(video_id)
        assert self.audio is not None
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / "upload.m4a"
        target.write_bytes(self.audio.read_bytes())
        return target


def test_resolve_searches_spotify_tracks_and_looks_up_videos() -> None:
    source = FakeSource()
    spotify = resolve(f"https://open.spotify.com/track/{TRACK}", source, fetch=fake_fetch([]))
    assert spotify.query == "Some Artist & Band Placeholder Song"
    assert [c.video_id for c in spotify.candidates] == ["aaaaaaaaaaa", "bbbbbbbbbbb"]
    direct = resolve(f"https://youtu.be/{VIDEO}", source)
    assert [c.video_id for c in direct.candidates] == [VIDEO]


def test_import_endpoints_do_not_exist_while_switched_off(tmp_path: Path) -> None:
    client = TestClient(create_app(Settings(data_dir=tmp_path), video_source=FakeSource))
    assert client.get("/api/health").json()["features"]["urlImport"] is False
    assert client.post("/api/import/resolve", json={"url": "https://youtu.be/x"}).status_code == 404
    assert client.post("/api/import/jobs", json={"videoId": VIDEO}).status_code == 404


def test_a_confirmed_video_is_downloaded_and_analyzed(tmp_path: Path) -> None:
    audio = tmp_path / "song.m4a"
    subprocess.run(  # noqa: S603
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i",  # noqa: S607
         "sine=frequency=220:duration=3", "-c:a", "aac", "-f", "ipod", str(audio)],
        check=True,
    )  # fmt: skip
    source = FakeSource(audio)
    vamp, models = fake_install(tmp_path)
    settings = Settings(
        data_dir=tmp_path / "data", enable_url_import=True, vamp_path=vamp, model_dir=models
    )
    with TestClient(create_app(settings, video_source=lambda: source)) as client:
        assert client.get("/api/health").json()["features"]["urlImport"] is True
        found = client.post("/api/import/resolve", json={"url": f"https://youtu.be/{VIDEO}"})
        assert found.status_code == 200
        assert found.json()["candidates"][0]["videoId"] == VIDEO
        bad = client.post("/api/import/resolve", json={"url": "https://example.com/song.mp3"})
        assert bad.status_code == 400
        assert client.post("/api/import/jobs", json={"videoId": "../../etc"}).status_code == 422
        created = client.post("/api/import/jobs", json={"videoId": VIDEO, "title": "Direct"})
        assert created.status_code == 201
        job_id = created.json()["jobId"]
        queued = client.get(f"/api/jobs/{job_id}").json()
        assert queued["source"] == {
            "kind": "url",
            "name": "Direct",
            "url": f"https://www.youtube.com/watch?v={VIDEO}",
        }
        worker = Worker(settings, pipeline_factory=fake_pipeline, video_source=lambda: source)
        assert worker.poll_once() is True
        done = client.get(f"/api/jobs/{job_id}").json()
        assert done["status"] == "done", done
        assert source.downloads == [VIDEO]
        assert client.get(f"/api/jobs/{job_id}/audio").status_code == 200


def test_link_jobs_are_refused_without_a_recognizer(tmp_path: Path) -> None:
    vamp, models = fake_install(tmp_path, models=(), plugin=False)
    settings = Settings(
        data_dir=tmp_path / "data", enable_url_import=True, vamp_path=vamp, model_dir=models
    )
    client = TestClient(create_app(settings, video_source=FakeSource))
    assert client.post("/api/import/jobs", json={"videoId": VIDEO}).status_code == 503


def test_worker_refuses_link_jobs_once_import_is_switched_off(tmp_path: Path) -> None:
    settings = Settings(data_dir=tmp_path / "data")
    store = JobStore(settings.db_path)
    store.create(
        job_id="j1",
        source={"kind": "url", "name": "x", "url": f"https://www.youtube.com/watch?v={VIDEO}"},
        options={},
    )
    source = FakeSource()
    Worker(settings, pipeline_factory=fake_pipeline, video_source=lambda: source).poll_once()
    job = store.get("j1")
    assert job is not None
    assert job.status == "failed"
    assert source.downloads == []


def test_failure_messages_are_short_and_actionable() -> None:
    bot = "ERROR: [youtube] x: Sign in to confirm you\u2019re not a bot. Use --cookies-from-browser"
    assert failure_message(bot) == "YouTube refused this server (it asks it to sign in)."
    assert failure_message("ERROR: Private video") == "This video is not public."
    age = "ERROR: [youtube] x: Sign in to confirm your age. This video may be inappropriate"
    assert failure_message(age) == "This video is age-restricted."
    # "page" must not read as "age": a network error is a network error.
    offline = "ERROR: Unable to download API page: ('Unable to connect to proxy')"
    assert failure_message(offline) == "YouTube could not be reached."
    assert failure_message("anything else") == "YouTube did not return this video."


def test_the_cookie_file_is_read_per_session_and_never_written(tmp_path: Path) -> None:
    pytest.importorskip("yt_dlp")
    from barrefree_analyzer.urlimport import YtDlpSource

    cookies = tmp_path / "cookies.txt"
    cookies.write_text("# Netscape HTTP Cookie File\n", encoding="utf-8")
    cookies.chmod(0o400)
    source = YtDlpSource(cookies=cookies)
    first, second = source._cookie_jar(), source._cookie_jar()
    assert first is not None
    assert second is not None
    assert first is not second
    assert first.read() == "# Netscape HTTP Cookie File\n"
    missing = YtDlpSource(cookies=tmp_path / "missing.txt")
    with pytest.raises(ImportFailedError, match="cookie file"):
        missing._cookie_jar()
