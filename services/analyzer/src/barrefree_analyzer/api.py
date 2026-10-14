"""Jobs API: upload a song, follow the analysis live (SSE), fetch the result and the audio.

POST   /api/jobs               multipart (file, recognizer?, separate?, transcribe?) → {jobId}
GET    /api/jobs/{id}          job state, with the result once it is done
GET    /api/jobs/{id}/events   Server-Sent Events: one "job" event per change, then "end"
GET    /api/jobs/{id}/audio    normalized mono MP3 copy for the player (HTTP Range supported)
DELETE /api/jobs/{id}          deletes the job, its audio, its result and its separated stems now

With ENABLE_URL_IMPORT (see urlimport.py):
POST   /api/import/resolve     {url} → the track and the YouTube videos to choose from
POST   /api/import/jobs        {videoId, title?, recognizer?, separate?, transcribe?} → {jobId}

Jobs may ask only for what is installed (``models.availability``): the default recognizer is
the first available one.
"""

import shutil
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Annotated

import anyio
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse
from fastapi.sse import EventSourceResponse, ServerSentEvent
from starlette.concurrency import run_in_threadpool

from barrefree_analyzer.audio import (
    MIN_DURATION_SEC,
    PLAYBACK_MEDIA_TYPE,
    PLAYBACK_NAME,
    AudioError,
    probe,
)
from barrefree_analyzer.config import Settings
from barrefree_analyzer.jobfiles import job_dir, remove_job_files
from barrefree_analyzer.jobs import Job, JobStore, new_job_id
from barrefree_analyzer.limits import RateLimiter
from barrefree_analyzer.models import availability
from barrefree_analyzer.schema import (
    AnalysisResult,
    ApiError,
    JobCreated,
    JobInfo,
    JobOptions,
    JobSource,
    Resolution,
    ResolveRequest,
    UrlJobRequest,
)
from barrefree_analyzer.uploads import UnsupportedAudioError, UploadTooLargeError, save_upload
from barrefree_analyzer.urlimport import (
    ImportFailedError,
    LinkError,
    VideoSource,
    resolve,
    youtube_url,
)

#: How often the event stream looks for changes.
_POLL_SEC = 0.5
_ERRORS: dict[int | str, dict[str, object]] = {
    400: {"model": ApiError},
    404: {"model": ApiError},
    409: {"model": ApiError},
    413: {"model": ApiError},
    415: {"model": ApiError},
    429: {"model": ApiError},
    502: {"model": ApiError},
    503: {"model": ApiError},
}


def resolve_options(
    settings: Settings, recognizer: str | None, separate: bool, transcribe: bool
) -> JobOptions:
    """The job's options, refused (HTTP error) when they ask for something not installed."""
    ready = availability(settings)
    if not ready.recognizers:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Chord recognition is not available on this server right now.",
        )
    chosen = recognizer or ready.recognizers[0]
    if chosen not in ready.recognizers:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"The recognizer '{chosen}' is not available here."
        )
    if separate and not ready.separation:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Source separation is not available here.")
    if transcribe and not ready.transcription:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Note transcription is not available here."
        )
    return JobOptions(recognizer=chosen, separate=separate, transcribe=transcribe)


def to_info(job: Job, settings: Settings) -> JobInfo:
    return JobInfo(
        id=job.id,
        status=job.status,
        stage=job.stage,
        progress=job.progress,
        error=job.error,
        source=JobSource.model_validate(job.source),
        options=JobOptions.model_validate(job.options),
        created_at=job.created_at,
        updated_at=job.updated_at,
        expires_at=job.updated_at + settings.temp_file_ttl_sec,
        result=AnalysisResult.model_validate_json(job.result) if job.result else None,
    )


def client_key(request: Request, settings: Settings) -> str:
    if settings.client_ip_header:
        forwarded = request.headers.get(settings.client_ip_header)
        if forwarded:
            return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def build_router(settings: Settings, store: JobStore) -> APIRouter:
    router = APIRouter(prefix="/api/jobs", tags=["jobs"], responses=_ERRORS)
    limiter = RateLimiter(settings.upload_rate_per_min, 60.0)

    def get_job(job_id: str) -> Job:
        # A dependency (FastAPI runs a plain def in the thread pool): it runs before the
        # response starts, so even the event stream can still answer 404.
        job = store.get(job_id)
        if job is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No such job (it may have expired).")
        return job

    existing_job = Annotated[Job, Depends(get_job)]

    @router.post("", status_code=status.HTTP_201_CREATED)
    async def create_job(
        request: Request,
        file: Annotated[UploadFile, File(description="MP3, WAV, FLAC, Ogg or M4A audio.")],
        recognizer: Annotated[str | None, Form()] = None,
        separate: Annotated[bool, Form()] = False,
        transcribe: Annotated[bool, Form()] = False,
    ) -> JobCreated:
        if not limiter.allow(client_key(request, settings)):
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS, "Too many uploads. Wait a minute."
            )
        options = resolve_options(settings, recognizer, separate, transcribe)
        if await run_in_threadpool(store.count_pending) >= settings.max_pending_jobs:
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE, "The server is busy. Try again later."
            )
        job_id = new_job_id()
        directory = job_dir(settings, job_id)
        try:
            path, kind, _sha = await save_upload(file, directory, settings.max_upload_mb * 2**20)
            info = await run_in_threadpool(probe, path, kind)
        except UploadTooLargeError as exc:
            shutil.rmtree(directory, ignore_errors=True)
            raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, str(exc)) from exc
        except (UnsupportedAudioError, AudioError) as exc:
            shutil.rmtree(directory, ignore_errors=True)
            raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, str(exc)) from exc
        if info.duration_sec < MIN_DURATION_SEC:
            shutil.rmtree(directory, ignore_errors=True)
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "The audio is too short to analyze."
            )
        if info.duration_sec > settings.max_duration_sec:
            shutil.rmtree(directory, ignore_errors=True)
            raise HTTPException(
                status.HTTP_413_CONTENT_TOO_LARGE,
                f"The song is longer than {settings.max_duration_sec // 60} minutes.",
            )
        name = Path(file.filename or "upload").name[:200]
        await run_in_threadpool(
            store.create,
            job_id=job_id,
            source=JobSource(kind="upload", name=name).model_dump(mode="json"),
            options=options.model_dump(mode="json"),
        )
        return JobCreated(job_id=job_id)

    @router.get("/{job_id}")
    async def read_job(job: existing_job) -> JobInfo:
        return to_info(job, settings)

    @router.get("/{job_id}/events", response_class=EventSourceResponse)
    async def job_events(job: existing_job) -> AsyncIterator[ServerSentEvent]:
        job_id = job.id
        last = None
        while True:
            state = (job.status, job.stage, round(job.progress, 3), job.updated_at)
            if state != last:
                last = state
                info = to_info(job, settings)
                # The result can be large; clients fetch it once with GET /api/jobs/{id}.
                yield ServerSentEvent(
                    event="job",
                    id=f"{job.updated_at:.6f}",
                    data=info.model_copy(update={"result": None}),
                )
            if job.status in ("done", "failed"):
                yield ServerSentEvent(event="end", data=job.status)
                return
            await anyio.sleep(_POLL_SEC)
            current = await run_in_threadpool(store.get, job_id)
            if current is None:
                yield ServerSentEvent(event="end", data="expired")
                return
            job = current

    @router.get(
        "/{job_id}/audio",
        response_class=FileResponse,
        responses={200: {"content": {PLAYBACK_MEDIA_TYPE: {}}}},
    )
    async def job_audio(job: existing_job) -> FileResponse:
        path = job_dir(settings, job.id) / PLAYBACK_NAME
        if not path.is_file():
            raise HTTPException(status.HTTP_404_NOT_FOUND, "The audio is not ready yet.")
        return FileResponse(
            path, media_type=PLAYBACK_MEDIA_TYPE, headers={"Cache-Control": "private"}
        )

    @router.delete("/{job_id}", status_code=status.HTTP_204_NO_CONTENT)
    async def delete_job(job: existing_job) -> None:
        if not await run_in_threadpool(store.delete_idle, job.id):
            if await run_in_threadpool(store.get, job.id) is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found.")
            raise HTTPException(status.HTTP_409_CONFLICT, "The job is still running.")
        await run_in_threadpool(remove_job_files, settings, job.id)

    return router


def build_import_router(
    settings: Settings, store: JobStore, source: Callable[[], VideoSource]
) -> APIRouter:
    """Link import (``ENABLE_URL_IMPORT``): resolve a link to videos, then queue the chosen one.

    Nothing is downloaded here: the worker downloads the confirmed video like an upload.
    """
    router = APIRouter(prefix="/api/import", tags=["import"], responses=_ERRORS)
    limiter = RateLimiter(settings.upload_rate_per_min * 2, 60.0)

    def allow(request: Request) -> None:
        if not limiter.allow(client_key(request, settings)):
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS, "Too many requests. Wait a minute."
            )

    @router.post("/resolve")
    async def resolve_link(body: ResolveRequest, request: Request) -> Resolution:
        allow(request)
        try:
            return await run_in_threadpool(resolve, body.url, source())
        except LinkError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
        except ImportFailedError as exc:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    @router.post("/jobs", status_code=status.HTTP_201_CREATED)
    async def create_url_job(body: UrlJobRequest, request: Request) -> JobCreated:
        allow(request)
        options = resolve_options(settings, body.recognizer, body.separate, body.transcribe)
        if await run_in_threadpool(store.count_pending) >= settings.max_pending_jobs:
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE, "The server is busy. Try again later."
            )
        job_id = new_job_id()
        name = (body.title or body.video_id).strip()[:200] or body.video_id
        await run_in_threadpool(
            store.create,
            job_id=job_id,
            source=JobSource(kind="url", name=name, url=youtube_url(body.video_id)).model_dump(
                mode="json"
            ),
            options=options.model_dump(mode="json"),
        )
        return JobCreated(job_id=job_id)

    return router
