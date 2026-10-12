"""Versioned raw-analysis result schema.

These Pydantic models are the single source of truth for the analyzer's output.
``export_schema`` turns them into JSON Schema, from which the TypeScript types in
``packages/contracts`` are generated. Field names are camelCase on the wire.

Chord labels use Harte et al. (2005) syntax (``C:maj``, ``A:min7``, ``G:7/3``, ``N``),
which is what ``mir_eval.chord`` expects.
"""

from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

SCHEMA_VERSION: Literal[1] = 1


class CamelModel(BaseModel):
    """Base for every wire model: camelCase JSON keys, strict fields, immutable."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        validate_by_name=True,
        validate_by_alias=True,
        extra="forbid",
        frozen=True,
        # JSON has no Infinity/NaN; Pydantic would serialize them as null and break the schema.
        allow_inf_nan=False,
        # Defaulted fields are still always present in the output, so mark them required
        # in the serialization schema (cleaner generated TypeScript types).
        json_schema_serialization_defaults_required=True,
    )


class _Interval(CamelModel):
    start: float = Field(ge=0, description="Start time in seconds.")
    end: float = Field(ge=0, description="End time in seconds.")

    @model_validator(mode="after")
    def _check_order(self) -> Self:
        if self.end < self.start:
            raise ValueError(f"end ({self.end}) must be >= start ({self.start})")
        return self


class Key(CamelModel):
    tonic: str = Field(pattern=r"^[A-G](#|b)?$", examples=["A", "F#", "Bb"])
    mode: Literal["major", "minor"]
    confidence: float = Field(ge=0, le=1)


class ChordSegment(_Interval):
    label: str = Field(
        min_length=1,
        description="Chord label in Harte syntax, e.g. 'C:maj', 'A:min7', 'G:7/3', 'N'.",
        examples=["A:min", "G:7/3", "N"],
    )
    confidence: float = Field(ge=0, le=1)


class Note(_Interval):
    midi: int = Field(ge=0, le=127)
    velocity: float = Field(ge=0, le=1)


class AnalysisMeta(CamelModel):
    recognizer: str = Field(description="Chord recognizer implementation, e.g. 'chordino'.")
    separated: bool = Field(description="Whether source separation ran before chord recognition.")
    processing_sec: float = Field(ge=0)


class AnalysisResult(CamelModel):
    """Raw analysis of one audio file."""

    model_config = ConfigDict(title="AnalysisResult")

    version: Literal[1] = SCHEMA_VERSION
    duration_sec: float = Field(ge=0)
    tempo_bpm: float | None = Field(default=None, gt=0)
    time_signature: str | None = Field(default=None, pattern=r"^\d+/\d+$", examples=["4/4"])
    key: Key | None = None
    beats: list[float] = Field(default_factory=list, description="Beat times in seconds.")
    chords: list[ChordSegment] = Field(default_factory=list)
    notes: list[Note] = Field(
        default_factory=list, description="Transcribed notes (only for the tab mode)."
    )
    meta: AnalysisMeta
