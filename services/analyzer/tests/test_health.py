from pathlib import Path

from fastapi.testclient import TestClient

from barrefree_analyzer.app import create_app
from barrefree_analyzer.config import Settings


def test_health_reports_ok_and_features() -> None:
    client = TestClient(create_app(Settings(enable_url_import=False)))
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["features"] == {"urlImport": False}


def test_serves_spa_with_client_side_route_fallback(tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text("<html>spa</html>")
    (tmp_path / "app.js").write_text("console.log(1)")
    client = TestClient(create_app(Settings(web_dist_dir=tmp_path)))

    assert client.get("/").text == "<html>spa</html>"
    assert client.get("/app.js").text == "console.log(1)"
    assert client.get("/library/some-song").text == "<html>spa</html>"
    assert client.get("/api/health").json()["status"] == "ok"
    assert client.get("/api/does-not-exist").status_code == 404
    assert client.get("/api").status_code == 404
    assert client.get("/api/").status_code == 404


def test_no_spa_when_dist_missing(tmp_path: Path) -> None:
    client = TestClient(create_app(Settings(web_dist_dir=tmp_path / "missing")))
    assert client.get("/").status_code == 404
