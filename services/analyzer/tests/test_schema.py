import json
from pathlib import Path
from typing import Any

import jsonschema
import pytest
from pydantic import ValidationError

from barrefree_analyzer.export_schema import DEFAULT_OUT, build_schema, render_schema
from barrefree_analyzer.schema import AnalysisResult

EXAMPLE: dict[str, Any] = {
    "version": 1,
    "durationSec": 213.4,
    "tempoBpm": 92.0,
    "timeSignature": "4/4",
    "key": {"tonic": "A", "mode": "minor", "confidence": 0.71},
    "beats": [0.52, 1.17],
    "chords": [{"start": 0.52, "end": 3.10, "label": "A:min", "confidence": 0.83}],
    "notes": [{"start": 1.0, "end": 1.4, "midi": 64, "velocity": 0.7}],
    "meta": {"recognizer": "chordino", "separated": True, "processingSec": 48.2},
}


def test_example_round_trips_with_camel_case_keys() -> None:
    result = AnalysisResult.model_validate(EXAMPLE)
    assert result.tempo_bpm == 92.0
    assert result.model_dump(mode="json", by_alias=True) == EXAMPLE


def test_example_validates_against_exported_json_schema() -> None:
    jsonschema.Draft202012Validator(build_schema()).validate(EXAMPLE)


def test_minimal_result_fills_defaults() -> None:
    result = AnalysisResult.model_validate(
        {"durationSec": 1, "meta": {"recognizer": "x", "separated": False, "processingSec": 0}}
    )
    dumped = result.model_dump(mode="json", by_alias=True)
    assert dumped["version"] == 1
    assert dumped["chords"] == []
    jsonschema.Draft202012Validator(build_schema()).validate(dumped)


@pytest.mark.parametrize(
    "patch",
    [
        {"chords": [{"start": 3.0, "end": 1.0, "label": "C:maj", "confidence": 0.5}]},
        {"key": {"tonic": "H", "mode": "major", "confidence": 0.5}},
        {"version": 2},
        {"unexpected": True},
        {"durationSec": float("inf")},
        {"beats": [float("nan")]},
        {"chords": [{"start": 0.0, "end": float("inf"), "label": "N", "confidence": 0.5}]},
    ],
)
def test_rejects_invalid_results(patch: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        AnalysisResult.model_validate({**EXAMPLE, **patch})


def test_committed_schema_is_up_to_date() -> None:
    committed = Path(DEFAULT_OUT)
    assert committed.is_file(), "run `uv run barrefree-export-schema`"
    assert json.loads(committed.read_text(encoding="utf-8")) == json.loads(render_schema()), (
        "packages/contracts/schema/analysis.schema.json is stale: "
        "run `uv run barrefree-export-schema` and then `pnpm gen:contracts`"
    )
