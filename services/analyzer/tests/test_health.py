from pathlib import Path

from fastapi.testclient import TestClient

from barrefree_analyzer.app import create_app
from barrefree_analyzer.config import Settings
from tests.conftest import fake_install


def health(settings: Settings) -> dict[str, object]:
    response = TestClient(create_app(settings)).get("/api/health")
    assert response.status_code == 200
    body: dict[str, object] = response.json()
    return body


def test_health_reports_ok_and_features(tmp_path: Path) -> None:
    vamp, models = fake_install(tmp_path)
    body = health(Settings(data_dir=tmp_path, vamp_path=vamp, model_dir=models))
    assert body["status"] == "ok"
    assert body["features"] == {
        "urlImport": False,
        "recognizers": ["chordino", "btc"],
        "separation": True,
        "transcription": True,
        "maxUploadMb": 50,
        "maxDurationSec": 900,
    }


def test_health_reports_only_what_is_installed(tmp_path: Path) -> None:
    # The worker downloads models after start-up, or may fail to: offer only what is there.
    vamp, models = fake_install(tmp_path, models=())
    body = health(Settings(data_dir=tmp_path, vamp_path=vamp, model_dir=models))
    assert body["status"] == "ok"
    features = body["features"]
    assert isinstance(features, dict)
    assert features["recognizers"] == ["chordino"]
    assert features["separation"] is False
    assert features["transcription"] is False

    vamp, models = fake_install(tmp_path / "btc-only", models=["btc"], plugin=False)
    settings = Settings(data_dir=tmp_path, vamp_path=vamp, model_dir=models)
    assert health(settings)["features"]["recognizers"] == ["btc"]  # type: ignore[index]
    (models / "btc" / "btc_model_large_voca.pt").write_bytes(b"truncated")
    body = health(settings)
    assert body["status"] == "degraded"
    assert body["features"]["recognizers"] == []  # type: ignore[index]


def test_serves_spa_with_client_side_route_fallback(tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text("<html>spa</html>")
    (tmp_path / "app.js").write_text("console.log(1)")
    client = TestClient(create_app(Settings(data_dir=tmp_path / "data", web_dist_dir=tmp_path)))

    assert client.get("/").text == "<html>spa</html>"
    assert client.get("/app.js").text == "console.log(1)"
    # Only content-hashed assets may be cached without asking again.
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "index-abc123.js").write_text("1")
    assert client.get("/assets/index-abc123.js").headers["cache-control"].endswith("immutable")
    for path in ("/", "/app.js", "/library/some-song"):
        assert client.get(path).headers["cache-control"] == "no-cache"
    assert client.get("/library/some-song").text == "<html>spa</html>"
    assert client.get("/api/health").json()["status"] == "ok"
    assert client.get("/api/does-not-exist").status_code == 404
    assert client.get("/api").status_code == 404
    assert client.get("/api/").status_code == 404
    # The API docs live under /api/ too, so the web app (and its service worker) own the rest.
    assert client.get("/api/openapi.json").json()["info"]["title"] == "BarreFree analyzer"
    assert client.get("/api/docs").status_code == 200
    assert client.get("/docs").text == "<html>spa</html>"
    assert client.get("/openapi.json").text == "<html>spa</html>"


def test_no_spa_when_dist_missing(tmp_path: Path) -> None:
    client = TestClient(
        create_app(Settings(data_dir=tmp_path / "data", web_dist_dir=tmp_path / "missing"))
    )
    assert client.get("/").status_code == 404
