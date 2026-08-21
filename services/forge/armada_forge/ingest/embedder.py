"""CPU embedding with BAAI/bge-small-en-v1.5 — Training R11.

384 dimensions, matching `chunks.embedding vector(384)` in migration 002.

ROADMAP F7 — THE WEIGHTS ARE BAKED INTO THE IMAGE AT BUILD TIME AND HF_HUB_OFFLINE=1 IS
SET AT RUNTIME. sentence-transformers would otherwise fetch from HuggingFace on first use,
which fails the blocked-egress acceptance test (AC 176) on an installation that has never
been online. Offline mode turns a missing cache into a loud startup failure instead of a
silent network reach — the failure an operator can act on, rather than one that looks like
a hang.
"""

from __future__ import annotations

import os
import threading
from typing import Any

MODEL_ID = "BAAI/bge-small-en-v1.5"

# Loading the model costs seconds and a few hundred MB. Load once, on first use, and guard
# with a lock so two concurrent ingestion jobs cannot both pay for it.
_model: Any = None
_model_lock = threading.Lock()


def _load_model() -> Any:
    global _model
    if _model is not None:
        return _model

    with _model_lock:
        if _model is not None:
            return _model

        # F7 — belt and braces. The Dockerfile sets this, but an operator running forge
        # outside the image should get the same offline guarantee rather than a surprise
        # network call.
        os.environ.setdefault("HF_HUB_OFFLINE", "1")

        from sentence_transformers import SentenceTransformer

        # device="cpu" is explicit rather than inferred: a host that happens to have CUDA
        # must not silently start using it, because the platform's CPU-only guarantee is
        # about what is REQUIRED, and an accidental GPU dependency here would make
        # embedding behave differently between hosts.
        _model = SentenceTransformer(MODEL_ID, device="cpu")
        return _model


def embed(texts: list[str]) -> list[list[float]]:
    """Embed a batch of chunk texts.

    Batched rather than per-chunk: sentence-transformers amortizes tokenization and the
    forward pass across a batch, which is the difference between minutes and hours on a
    repository-sized corpus.

    normalize_embeddings=True so cosine distance in pgvector (the HNSW index in migration
    002 uses vector_cosine_ops) operates on unit vectors.
    """
    if not texts:
        return []

    model = _load_model()
    vectors = model.encode(
        texts,
        batch_size=32,
        normalize_embeddings=True,
        show_progress_bar=False,
        convert_to_numpy=True,
    )
    return [vector.tolist() for vector in vectors]

