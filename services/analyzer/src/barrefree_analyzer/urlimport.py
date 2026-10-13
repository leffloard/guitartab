"""Import a song from a link: Spotify track or YouTube video → candidates → the user confirms.

Off by default (``ENABLE_URL_IMPORT``). Downloading audio from YouTube can break its terms of
service; whoever runs the server decides whether to enable it, and users confirm the exact video
before anything is downloaded.

The server never fetches a URL the user typed. A link is parsed against a fixed list of hosts and
reduced to an id (a Spotify track id, a YouTube video id); every request is then built from that
id on a fixed host. yt-dlp is restricted to its YouTube extractors, takes no playlists, and has
size and duration limits, so a link cannot make the server reach anywhere else.

- Spotify gives no audio. Its oEmbed endpoint gives the track title and the track page's
  ``music:musician_description`` meta tag the artist; "artist title" is searched on YouTube.
- A YouTube link is looked up directly and offered as the single candidate.
"""

import html
import io
import json
import re
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Protocol
from urllib.parse import parse_qs, quote, urlsplit

from barrefree_analyzer.schema import Candidate, Resolution

YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"}
_VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
_TRACK_ID = re.compile(r"^[A-Za-z0-9]{22}$")
#: Pages and JSON read from Spotify are small; anything bigger is not what we asked for.
_MAX_RESPONSE_BYTES = 2 * 2**20


class LinkError(ValueError):
    """The link is not a Spotify track or YouTube video link."""


class ImportFailedError(Exception):
    """The service could not be reached or returned nothing usable."""


@dataclass(frozen=True)
class Link:
    kind: Literal["spotify", "youtube"]
    id: str


def parse_link(text: str) -> Link:
    """A Spotify track or YouTube video id from a pasted link; anything else raises LinkError."""
    text = text.strip()
    if len(text) > 500:
        raise LinkError("The link is too long.")
    try:
        parts = urlsplit(text if "://" in text else f"https://{text}")
        host = (parts.hostname or "").lower()
        port = parts.port
    except ValueError as exc:  # e.g. a port that is not a number
        raise LinkError("Paste a Spotify track or YouTube video link.") from exc
    # No user-info ("youtube.com@elsewhere") and no ports: the host must be exactly one of ours.
    if parts.scheme not in ("http", "https") or parts.username or parts.password or port:
        raise LinkError("Paste a Spotify track or YouTube video link.")
    path = [p for p in parts.path.split("/") if p]
    if host == "open.spotify.com":
        if path and path[0].startswith("intl-"):
            path = path[1:]
        if len(path) == 2 and path[0] == "track" and _TRACK_ID.match(path[1]):
            return Link("spotify", path[1])
    elif host in YOUTUBE_HOSTS:
        video = (parse_qs(parts.query).get("v") or [""])[0]
        if path == ["watch"] and _VIDEO_ID.match(video):
            return Link("youtube", video)
        if len(path) == 2 and path[0] in ("shorts", "live") and _VIDEO_ID.match(path[1]):
            return Link("youtube", path[1])
    elif host == "youtu.be" and len(path) == 1 and _VIDEO_ID.match(path[0]):
        return Link("youtube", path[0])
    raise LinkError("Paste a Spotify track or YouTube video link.")


def youtube_url(video_id: str) -> str:
    if not _VIDEO_ID.match(video_id):
        raise LinkError("Not a YouTube video id.")
    return f"https://www.youtube.com/watch?v={video_id}"


Fetch = Callable[[str], str]


def fetch_text(url: str, timeout: float = 10.0) -> str:
    """GET a page from one of the fixed hosts this module builds URLs for."""
    if urlsplit(url).hostname not in ("open.spotify.com",):
        raise ImportFailedError("refusing to fetch an unexpected host")
    request = urllib.request.Request(  # noqa: S310 - https URL on a fixed host
        url, headers={"User-Agent": "Mozilla/5.0 (BarreFree)", "Accept-Language": "en"}
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
            body: bytes = response.read(_MAX_RESPONSE_BYTES + 1)
    except OSError as exc:
        raise ImportFailedError("Spotify could not be reached.") from exc
    if len(body) > _MAX_RESPONSE_BYTES:
        raise ImportFailedError("unexpectedly large response")
    return body.decode("utf-8", errors="replace")


def _meta(page: str, name: str) -> str | None:
    match = re.search(
        rf'<meta\s+(?:name|property)="{re.escape(name)}"\s+content="([^"]*)"', page, re.IGNORECASE
    )
    return html.unescape(match.group(1)).strip() or None if match else None


def spotify_track(track_id: str, fetch: Fetch = fetch_text) -> tuple[str, str | None]:
    """Title and (best effort) artist of a Spotify track."""
    page_url = f"https://open.spotify.com/track/{track_id}"
    try:
        oembed = json.loads(
            fetch(f"https://open.spotify.com/oembed?url={quote(page_url, safe='')}")
        )
    except (ValueError, TypeError) as exc:
        raise ImportFailedError("Spotify returned no track information.") from exc
    title = str(oembed.get("title") or "").strip() if isinstance(oembed, dict) else ""
    if not title:
        raise ImportFailedError("Spotify returned no track information.")
    artist: str | None = None
    try:
        page = fetch(page_url)
        artist = _meta(page, "music:musician_description")
        if artist is None:
            description = _meta(page, "og:description")
            artist = description.split(" · ")[0].strip() if description else None
    except ImportFailedError:
        pass  # the title alone still finds the song most of the time
    return title, artist


class VideoSource(Protocol):
    def search(self, query: str, limit: int) -> list[Candidate]: ...

    def lookup(self, video_id: str) -> Candidate: ...

    def download(self, video_id: str, directory: Path, max_bytes: int, max_sec: float) -> Path:
        """Downloads the audio as ``directory/upload.m4a`` and returns its path."""
        ...


def resolve(
    text: str, source: VideoSource, *, limit: int = 5, fetch: Fetch = fetch_text
) -> Resolution:
    link = parse_link(text)
    if link.kind == "youtube":
        candidate = source.lookup(link.id)
        return Resolution(title=candidate.title, candidates=[candidate])
    title, artist = spotify_track(link.id, fetch)
    query = f"{artist} {title}" if artist else title
    return Resolution(
        title=title, artist=artist, query=query, candidates=source.search(query, limit)
    )


def _candidate(entry: dict[str, Any]) -> Candidate | None:
    video_id = str(entry.get("id") or "")
    if not _VIDEO_ID.match(video_id):
        return None
    duration = entry.get("duration")
    thumbnails = entry.get("thumbnails") or []
    thumbnail = entry.get("thumbnail") or (thumbnails[-1].get("url") if thumbnails else None)
    return Candidate(
        video_id=video_id,
        title=str(entry.get("title") or video_id),
        channel=entry.get("channel") or entry.get("uploader"),
        duration_sec=float(duration) if isinstance(duration, int | float) else None,
        url=youtube_url(video_id),
        thumbnail=thumbnail
        if isinstance(thumbnail, str) and thumbnail.startswith("https://")
        else None,
    )


def failure_message(error: str) -> str:
    """A user-facing reason for a yt-dlp error (which is long, technical and English)."""
    if "confirm your age" in error or "age-restricted" in error or "inappropriate" in error:
        return "This video is age-restricted."
    if "not a bot" in error:
        # YouTube blocks many data-center addresses unless the request carries a signed-in
        # session; the operator can provide one (URL_IMPORT_COOKIES, see architecture.md 4c).
        return "YouTube refused this server (it asks it to sign in)."
    if "Private video" in error or "members-only" in error or "Video unavailable" in error:
        return "This video is not public."
    if any(
        phrase in error
        for phrase in ("Unable to download", "HTTP Error", "timed out", "Unable to connect")
    ):
        return "YouTube could not be reached."
    return "YouTube did not return this video."


class YtDlpSource:
    """YouTube through yt-dlp, limited to its YouTube extractors."""

    def __init__(self, timeout: float = 20.0, cookies: Path | None = None) -> None:
        import yt_dlp  # optional dependency (extra "url")

        self._yt_dlp = yt_dlp
        self._cookies = cookies
        self._base: dict[str, Any] = {
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "allowed_extractors": ["youtube", "youtube:search"],
            "socket_timeout": timeout,
            "cachedir": False,
            "noprogress": True,
        }

    def _cookie_jar(self) -> io.StringIO | None:
        """A private in-memory copy of the cookies file for one yt-dlp session.

        yt-dlp writes its cookie jar back when a session ends. Given the file itself it would
        need write access, and concurrent sessions (the API and the workers) would overwrite
        each other's copies; a copy keeps the operator's file read-only and intact.
        """
        if self._cookies is None:
            return None
        try:
            return io.StringIO(self._cookies.read_text(encoding="utf-8"))
        except OSError as exc:
            raise ImportFailedError("The YouTube cookie file could not be read.") from exc

    def _info(self, target: str, *, download: bool = False, **options: Any) -> dict[str, Any]:
        jar = self._cookie_jar()
        params = {**self._base, **options, **({"cookiefile": jar} if jar else {})}
        try:
            with self._yt_dlp.YoutubeDL(params) as ydl:
                info = ydl.extract_info(target, download=download)
        except self._yt_dlp.utils.DownloadError as exc:
            raise ImportFailedError(failure_message(str(exc))) from exc
        except OSError as exc:
            raise ImportFailedError("YouTube could not be reached.") from exc
        if not isinstance(info, dict):
            raise ImportFailedError("YouTube returned nothing.")
        return info

    def search(self, query: str, limit: int) -> list[Candidate]:
        info = self._info(f"ytsearch{limit}:{query}", extract_flat="in_playlist")
        found = [_candidate(e) for e in info.get("entries") or [] if isinstance(e, dict)]
        return [c for c in found if c is not None]

    def lookup(self, video_id: str) -> Candidate:
        candidate = _candidate(self._info(youtube_url(video_id)))
        if candidate is None:
            raise ImportFailedError("YouTube returned nothing.")
        return candidate

    def download(self, video_id: str, directory: Path, max_bytes: int, max_sec: float) -> Path:
        # AAC in MP4: the container the upload path already accepts.
        audio_format = "bestaudio[ext=m4a]"
        info = self._info(youtube_url(video_id), format=audio_format)
        duration = info.get("duration")
        if isinstance(duration, int | float) and duration > max_sec:
            raise ImportFailedError("The video is too long.")
        if info.get("is_live"):
            raise ImportFailedError("Live streams cannot be analyzed.")
        # yt-dlp skips a file over max_filesize without an error: check the size it announced.
        size = info.get("filesize") or info.get("filesize_approx") or 0
        if isinstance(size, int | float) and size > max_bytes:
            raise ImportFailedError("The audio is too large.")
        directory.mkdir(parents=True, exist_ok=True)
        options = {
            "format": audio_format,
            "max_filesize": max_bytes,
            "outtmpl": str(directory / "upload.%(ext)s"),
            "overwrites": True,
        }
        self._info(youtube_url(video_id), download=True, **options)
        path = directory / "upload.m4a"
        if not path.is_file():
            raise ImportFailedError("The audio could not be downloaded.")
        return path
