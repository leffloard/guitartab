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
        # Also outside FastAPI's response encoding, e.g. SSE event data and the stored result.
        serialize_by_alias=True,
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
    downbeats: list[float] = Field(
        default_factory=list, description="Times of the first beat of each bar, in seconds."
    )
    chords: list[ChordSegment] = Field(default_factory=list)
    notes: list[Note] = Field(
        default_factory=list, description="Transcribed notes (only for the tab mode)."
    )
    meta: AnalysisMeta


# ---------------------------------------------------------------------------------------------
# Jobs API

JobStatus = Literal["queued", "running", "done", "failed"]
JobStage = Literal[
    "queued",
    "downloading",
    "decoding",
    "separating",
    "beats",
    "key",
    "chords",
    "notes",
    "done",
    "failed",
]


class JobOptions(CamelModel):
    recognizer: str = Field(default="chordino", description="Chord recognizer to use.")
    separate: bool = Field(default=False, description="Run source separation first (slow).")
    transcribe: bool = Field(default=False, description="Transcribe notes for the tab mode.")


class JobSource(CamelModel):
    kind: Literal["upload", "url"]
    name: str = Field(description="File name or track title, for display only.")
    url: str | None = None


class JobInfo(CamelModel):
    """State of an analysis job; ``result`` is set once the job is done."""

    model_config = ConfigDict(title="JobInfo")

    id: str
    status: JobStatus
    stage: JobStage
    progress: float = Field(ge=0, le=1)
    error: str | None = None
    source: JobSource
    options: JobOptions
    created_at: float = Field(description="Unix time, seconds.")
    updated_at: float = Field(description="Unix time, seconds.")
    expires_at: float = Field(description="When the server deletes the job and its audio.")
    result: AnalysisResult | None = None


class JobCreated(CamelModel):
    model_config = ConfigDict(title="JobCreated")

    job_id: str


class ApiError(CamelModel):
    model_config = ConfigDict(title="ApiError")

    detail: str


class Features(CamelModel):
    model_config = ConfigDict(title="Features")

    url_import: bool
    recognizers: list[str] = Field(description="Chord recognizers, the default first.")
    separation: bool = Field(description="Whether jobs may ask for source separation.")
    transcription: bool = Field(description="Whether jobs may ask for notes (tab view).")
    max_upload_mb: int
    max_duration_sec: int


class Health(CamelModel):
    model_config = ConfigDict(title="Health")

    status: str
    version: str
    features: Features


class Candidate(CamelModel):
    """A YouTube video the user can pick for a link import."""

    model_config = ConfigDict(title="Candidate")

    video_id: str = Field(pattern=r"^[A-Za-z0-9_-]{11}$")
    title: str
    channel: str | None = None
    duration_sec: float | None = None
    url: str
    thumbnail: str | None = None


class Resolution(CamelModel):
    """What a link points to, and the videos the user can choose from."""

    model_config = ConfigDict(title="Resolution")

    title: str | None = None
    artist: str | None = None
    query: str | None = Field(default=None, description="The YouTube search, for a Spotify link.")
    candidates: list[Candidate]


class ResolveRequest(CamelModel):
    model_config = ConfigDict(title="ResolveRequest")

    url: str = Field(max_length=500)


class UrlJobRequest(CamelModel):
    model_config = ConfigDict(title="UrlJobRequest")

    video_id: str = Field(pattern=r"^[A-Za-z0-9_-]{11}$")
    title: str | None = Field(default=None, max_length=200)
    recognizer: str | None = None
    separate: bool = False
    transcribe: bool = False


#: Models exported next to AnalysisResult for the web app's API client: responses...
API_MODELS: tuple[type[CamelModel], ...] = (JobInfo, JobCreated, ApiError, Health, Resolution)
#: ...and request bodies, exported as the server validates them (fields with defaults optional).
REQUEST_MODELS: tuple[type[CamelModel], ...] = (ResolveRequest, UrlJobRequest)
