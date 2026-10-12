"""FastAPI application: the analysis API and (optionally) the built web app."""

from pathlib import Path

from fastapi import FastAPI
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope

from barrefree_analyzer import __version__
from barrefree_analyzer.config import Settings, get_settings
from barrefree_analyzer.schema import CamelModel


class Features(CamelModel):
    url_import: bool


class Health(CamelModel):
    status: str
    version: str
    features: Features


class SpaStaticFiles(StaticFiles):
    """Serves the single-page app, falling back to index.html for client-side routes."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code != 404 or path == "api" or path.startswith("api/"):
                raise
            return await super().get_response("index.html", scope)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    app = FastAPI(title="BarreFree analyzer", version=__version__)

    @app.get("/api/health")
    def health() -> Health:
        return Health(
            status="ok",
            version=__version__,
            features=Features(url_import=settings.enable_url_import),
        )

    # Mount the SPA last so that /api routes take precedence.
    dist: Path | None = settings.web_dist_dir
    if dist is not None and (dist / "index.html").is_file():
        app.mount("/", SpaStaticFiles(directory=dist, html=True), name="web")

    return app
