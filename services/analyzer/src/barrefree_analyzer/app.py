"""FastAPI application: the analysis API and (optionally) the built web app."""

import importlib.util
import logging
from collections.abc import Callable
from pathlib import Path

from fastapi import FastAPI
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope

from barrefree_analyzer import __version__
from barrefree_analyzer.api import build_import_router, build_router
from barrefree_analyzer.config import Settings, get_settings
from barrefree_analyzer.jobs import JobStore
from barrefree_analyzer.limits import BodySizeLimit
from barrefree_analyzer.schema import Features, Health
from barrefree_analyzer.urlimport import VideoSource, YtDlpSource

log = logging.getLogger("barrefree.app")

#: Multipart overhead allowed on top of the audio file itself.
_FORM_OVERHEAD = 64 * 1024


class SpaStaticFiles(StaticFiles):
    """Serves the single-page app, falling back to index.html for client-side routes."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code != 404 or path == "api" or path.startswith("api/"):
                raise
            return await super().get_response("index.html", scope)


def create_app(
    settings: Settings | None = None, video_source: Callable[[], VideoSource] | None = None
) -> FastAPI:
    """The app; ``video_source`` replaces yt-dlp for link import (tests)."""
    settings = settings or get_settings()
    url_import = settings.enable_url_import
    if url_import and video_source is None:
        if importlib.util.find_spec("yt_dlp") is None:
            log.warning("ENABLE_URL_IMPORT is set but yt-dlp is not installed (extra 'url')")
            url_import = False
        else:
            cookies = settings.url_import_cookies

            def video_source() -> VideoSource:
                return YtDlpSource(cookies=cookies)

    # Everything the server answers lives under /api/; every other path belongs to the web
    # app, whose service worker answers navigations with index.html.
    app = FastAPI(
        title="BarreFree analyzer",
        version=__version__,
        docs_url="/api/docs",
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )

    @app.get("/api/health")
    def health() -> Health:
        return Health(
            status="ok",
            version=__version__,
            features=Features(
                url_import=url_import,
                recognizers=settings.recognizers,
                separation=settings.separation,
                max_upload_mb=settings.max_upload_mb,
                max_duration_sec=settings.max_duration_sec,
            ),
        )

    store = JobStore(settings.db_path)
    app.include_router(build_router(settings, store))
    if url_import and video_source is not None:
        # Off by default; when off, these paths do not exist (404).
        app.include_router(build_import_router(settings, store, video_source))
    app.add_middleware(
        BodySizeLimit,
        max_bytes=settings.max_upload_mb * 2**20 + _FORM_OVERHEAD,
        paths=("/api/jobs",),
    )
    app.add_middleware(BodySizeLimit, max_bytes=16 * 1024, paths=("/api/import",))

    # Mount the SPA last so that /api routes take precedence.
    dist: Path | None = settings.web_dist_dir
    if dist is not None and (dist / "index.html").is_file():
        app.mount("/", SpaStaticFiles(directory=dist, html=True), name="web")

    return app
