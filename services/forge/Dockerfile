# armada-forge — CPU-only Python image.
#
# No CUDA base, no GPU runtime. `LocalTrainingBackend` detects CUDA at startup and selects
# smoke or quality mode (Training R24); on this image it finds none and runs smoke mode,
# which is the intended default on the target host.
#
# ROADMAP F8 — adding a GPU to the host is enough for Armada to switch to quality mode
# with no configuration change, but Compose must still GRANT the container a device. See
# the commented `deploy.resources.reservations.devices` block in docker-compose.yml.
#
# LATER PHASES ADD TO THIS FILE:
#   Phase 1 (F7)  bake BAAI/bge-small-en-v1.5 weights (~130 MB) at BUILD time and set
#                 HF_HUB_OFFLINE=1 at runtime. Fetching them at first use would fail the
#                 blocked-egress acceptance test; offline mode makes a missing cache fail
#                 loudly instead of silently reaching for the network.
#   Phase 7 (F6)  bake llama.cpp's convert_hf_to_gguf.py and llama-quantize for the
#                 merge -> GGUF -> quantize export path. Merging a 4B model in fp16 needs
#                 roughly 8-16 GB RAM.

FROM python:3.12-slim-bookworm

# git is needed by Phase 1's `git` Source fetcher (depth-1 clone, Training R8).
# libpq5 backs psycopg's binary wheel.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git libpq5 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY armada_forge ./armada_forge

# Non-root. Nothing in forge needs elevated privileges — it talks to Postgres and, from
# Phase 1, to armada-models over HTTP.
RUN useradd --create-home --uid 10001 forge \
    && mkdir -p /data/datasets /data/adapters /data/supplied \
    && chown -R forge:forge /data /app
USER forge

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

EXPOSE 8000

CMD ["uvicorn", "armada_forge.main:app", "--host", "0.0.0.0", "--port", "8000"]
