"""Export the analysis JSON Schema consumed by ``packages/contracts``.

Usage (from services/analyzer)::

    uv run barrefree-export-schema            # writes ../../packages/contracts/schema/...
    uv run barrefree-export-schema --out x.json
"""

import argparse
import json
from pathlib import Path
from typing import Any

from barrefree_analyzer.schema import AnalysisResult

SCHEMA_ID = "https://github.com/leffloard/guitartab/schemas/analysis.schema.json"
REPO_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_OUT = REPO_ROOT / "packages" / "contracts" / "schema" / "analysis.schema.json"


def _drop_property_titles(node: Any) -> Any:
    """Removes the per-field "title" Pydantic emits ("Durationsec", ...).

    Model titles are kept. Without this, json-schema-to-typescript turns every titled
    field into its own exported type alias.
    """
    if isinstance(node, list):
        return [_drop_property_titles(item) for item in node]
    if not isinstance(node, dict):
        return node
    out = {key: _drop_property_titles(value) for key, value in node.items()}
    if isinstance(out.get("properties"), dict):
        out["properties"] = {
            name: {k: v for k, v in prop.items() if k != "title"}
            for name, prop in out["properties"].items()
        }
    return out


def build_schema() -> dict[str, Any]:
    schema = _drop_property_titles(
        AnalysisResult.model_json_schema(mode="serialization", by_alias=True)
    )
    return {"$schema": "https://json-schema.org/draft/2020-12/schema", "$id": SCHEMA_ID, **schema}


def render_schema() -> str:
    return json.dumps(build_schema(), indent=2, ensure_ascii=False) + "\n"


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args(argv)
    out: Path = args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render_schema(), encoding="utf-8")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
