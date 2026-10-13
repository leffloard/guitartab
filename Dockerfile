# One image for both the API (which also serves the built web app) and the worker.
# Build context: repository root.
# No "# syntax=" directive on purpose: it would pull the frontend image from Docker Hub
# on every build, defeating the base-image mirror args below.
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
COPY packages/contracts/package.json packages/contracts/
COPY data/voicings/package.json data/voicings/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@barrefree/web..."
COPY apps/web apps/web
COPY packages/theory packages/theory
COPY packages/contracts packages/contracts
COPY data/voicings data/voicings
RUN pnpm --filter @barrefree/web build

# ---- 2. Chordino Vamp plugin (GPL-2.0-or-later), built from pinned source commits ------
FROM ${PYTHON_IMAGE} AS vamp
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git g++ make libboost-dev \
    && rm -rf /var/lib/apt/lists/*
COPY services/analyzer/scripts/build-vamp-plugins.sh /tmp/build-vamp-plugins.sh
RUN /tmp/build-vamp-plugins.sh /opt/vamp

# ---- 3. Python environment (vamp ships only an sdist: it needs a compiler) -------------
# The "url" extra (yt-dlp with its Deno runtime) is installed so that link import can be
# switched on with ENABLE_URL_IMPORT alone; it stays unused while the flag is off.
FROM ${PYTHON_IMAGE} AS python-deps
RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.13.0 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /app
COPY services/analyzer/pyproject.toml services/analyzer/uv.lock services/analyzer/README.md services/analyzer/LICENSE ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project --extra url
COPY services/analyzer/src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable --extra url

# ---- 4. Runtime ----------------------------------------------------------------------
FROM ${PYTHON_IMAGE} AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY --from=python-deps /opt/venv /opt/venv
COPY --from=vamp /opt/vamp /opt/vamp
COPY --from=web /repo/apps/web/dist /app/web
RUN useradd --uid 10001 --no-create-home --home-dir /app --shell /usr/sbin/nologin barrefree \
    && mkdir -p /data /models \
    && chown barrefree /data /models
USER barrefree
# Model weights are not in the image: the worker downloads them into /models (a volume) on
# first start (barrefree-download-models), checking their SHA-256.
ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    WEB_DIST_DIR=/app/web \
    DATA_DIR=/data \
    MODEL_DIR=/models \
    VAMP_PATH=/opt/vamp \
    NUMBA_CACHE_DIR=/tmp/numba-cache
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
    CMD ["python", "-c", "import urllib.request as u; u.build_opener(u.ProxyHandler({})).open('http://127.0.0.1:8000/api/health', timeout=2)"]
CMD ["uvicorn", "barrefree_analyzer.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
