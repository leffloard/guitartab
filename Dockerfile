# syntax=docker/dockerfile:1
# One image for both the API (which also serves the built web app) and the worker.
# Build context: repository root.
#
# Base images are build args so that a registry mirror can be used when Docker Hub
# rate-limits anonymous pulls, e.g. --build-arg NODE_IMAGE=mirror.gcr.io/library/node:24-slim
ARG NODE_IMAGE=node:24-slim
ARG PYTHON_IMAGE=python:3.12-slim-trixie

# ---- 1. Web app (static build) -------------------------------------------------------
FROM ${NODE_IMAGE} AS web
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
# Manifests first so the dependency layer is cached independently of source changes.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/theory/package.json packages/theory/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@barrefree/web..."
COPY apps/web apps/web
COPY packages/theory packages/theory
RUN pnpm --filter @barrefree/web build

# ---- 2. Python runtime ---------------------------------------------------------------
FROM ${PYTHON_IMAGE} AS runtime
COPY --from=ghcr.io/astral-sh/uv:0.13.0 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PYTHONUNBUFFERED=1
WORKDIR /app
COPY services/analyzer/pyproject.toml services/analyzer/uv.lock services/analyzer/README.md services/analyzer/LICENSE ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project
COPY services/analyzer/src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable

COPY --from=web /repo/apps/web/dist /app/web
RUN useradd --uid 10001 --no-create-home --home-dir /app --shell /usr/sbin/nologin barrefree \
    && mkdir -p /data /models \
    && chown barrefree /data /models
USER barrefree
ENV PATH="/opt/venv/bin:${PATH}" \
    WEB_DIST_DIR=/app/web \
    DATA_DIR=/data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=2)"]
CMD ["uvicorn", "barrefree_analyzer.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
