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
# GGUF EXPORT TOOLING IS NOT IN THIS IMAGE (roadmap F6, deferred).
#
# R31's promotion path merges the adapter, converts to GGUF, and quantizes, which needs
# llama.cpp's convert_hf_to_gguf.py and a built llama-quantize — a C++ build, not a wheel.
# armada_forge/registry/export.py locates both through ARMADA_GGUF_CONVERT and
# ARMADA_LLAMA_QUANTIZE and REFUSES promotion naming the missing one, rather than
# registering an unconverted artifact.
#
# The zero-cost default path is unaffected. A smoke Adapter is rejected before evaluation
# (R33b) and never reaches export, so nothing on the CPU-only path needs this. Bake the
# toolchain in when a quality run becomes reachable — merging a 4B model in fp16 needs
# ~8-16 GB RAM, which is a second reason it belongs on a host that has a GPU.

FROM python:3.12-slim-bookworm

# git backs the `git` Source fetcher (depth-1 clone, Training R8).
# libpq5 backs psycopg's binary wheel. curl is the Compose healthcheck.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git libpq5 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The CPU torch wheel, explicitly. sentence-transformers pulls torch transitively, and the
# default wheel carries ~2 GB of CUDA libraries this image can never execute.
RUN pip install --no-cache-dir \
    --index-url https://download.pytorch.org/whl/cpu \
    torch==2.5.1

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Non-root. Nothing in forge needs elevated privileges — it talks to Postgres and, from
# the registry phase, to armada-models over HTTP.
#
# Created BEFORE the model download so the weights land in their final home once. Doing it
# after meant copying ~130 MB into the user's cache, which both committed the weights to
# the image TWICE (the original layer is immutable, so the copy adds rather than moves) and
# put a 130 MB operation downstream of the source COPY, where every code edit re-ran it.
RUN useradd --create-home --uid 10001 forge \
    && mkdir -p /data/datasets /data/adapters /data/supplied /data/uploads \
              /home/forge/.cache/huggingface \
    && chown -R forge:forge /data /app /home/forge

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HF_HOME=/home/forge/.cache/huggingface

USER forge

# ── ROADMAP F7: BAKE THE EMBEDDING WEIGHTS IN AT BUILD TIME ──────────────────
# sentence-transformers fetches BAAI/bge-small-en-v1.5 (~130 MB) from HuggingFace on first
# use. On an installation that has never been online — which is exactly what the
# blocked-egress acceptance test (AC 176) simulates — that fetch fails at the moment an
# operator triggers their first ingestion, long after startup reported healthy.
#
# Downloading here moves the network dependency to BUILD time, where it belongs. Run as
# `forge` with HF_HOME already set, so the cache is written where it will be read.
RUN python -c "\
from sentence_transformers import SentenceTransformer; \
SentenceTransformer('BAAI/bge-small-en-v1.5', device='cpu')"

# F7 — no runtime HuggingFace access. Set AFTER the download, so the build can fetch and
# the runtime cannot. A missing cache is now a loud failure at load rather than a silent
# network call that fails the blocked-egress test.
ENV HF_HUB_OFFLINE=1

# Last, so a code-only change rebuilds exactly one small layer instead of invalidating the
# model download and the dependency install behind it.
COPY --chown=forge:forge armada_forge ./armada_forge

EXPOSE 8000

CMD ["uvicorn", "armada_forge.main:app", "--host", "0.0.0.0", "--port", "8000"]
