# armada-models — Ollama with the smoke model baked in.
#
# TRAINING R4g / build-plan Req 3. Exactly one shortlist entry — the `smoke_test: true`
# model — ships inside this image, so it is `materialized: true` from first boot.
#
# WHY BAKE ONE AND ONLY ONE. Registration writes records for all five entries and transfers
# no weights (R4c), which is what makes a first `docker compose up` cheap. But a platform
# where NOTHING can answer until the operator runs a materialize call is a platform whose
# first Agent Run fails on a fresh install, and whose smoke training path cannot execute
# offline. Baking the smallest entry buys both for ~400 MB of image, and it is the same
# model LocalTrainingBackend is restricted to in smoke mode — so the one model that is
# always present is exactly the one the zero-cost path needs.
#
# The other four register unmaterialized and are pulled on demand.
#
# KEEP THIS IN SYNC WITH config/base-models.yaml: the tag below must equal the
# `serving_ref` of the entry carrying `smoke_test: true`. Forge reconciles at startup
# (R4h), so a mismatch surfaces as that binding reporting materialized:false rather than as
# silent breakage — but it would still mean a fresh install has nothing servable.

FROM ollama/ollama:latest

# Pull at BUILD time. `ollama serve` is not running during a build, so start it, wait for
# it to answer, pull, and stop — all inside one layer so the weights land in the image.
#
# The loop polls a LOCAL process that has just been started, which is not an arbitrary
# delay standing in for event-driven logic: there is no readiness event to subscribe to
# from a shell, and the alternative is racing the server's socket.
RUN ollama serve & \
    for i in $(seq 1 60); do \
        ollama list >/dev/null 2>&1 && break; \
        sleep 1; \
    done; \
    ollama list >/dev/null 2>&1 || { echo "ollama did not start during build" >&2; exit 1; }; \
    ollama pull qwen3:0.6b && \
    pkill -f "ollama serve" || true

# Inherits ollama/ollama's entrypoint and CMD, so the served behaviour is unchanged.
EXPOSE 11434
