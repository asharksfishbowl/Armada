"""POST /embed — the query-embedding contract the daemon calls at agent time.

WHY THIS LIVES IN FORGE. Platform boundary 1 assigns embeddings to armada-forge:
"armada-forge owns writing chunks and embeddings into armada-db. armada-daemon owns
querying them at agent time." The daemon needs a vector for the user's query text to run
R41's cosine channel, and it has no embedding model — bge-small is baked into the FORGE
image (roadmap F7).

THIS DOES NOT BREACH THE BOUNDARY'S SECOND CLAUSE. "The forge never serves a retrieval
query to an agent" still holds: this endpoint returns a VECTOR, not a retrieval. It never
touches the index, never sees a corpus_id, and never ranks anything. The daemon still owns
the query.

WHY NOT A SECOND MODEL IN THE DAEMON. Two copies must stay on the same model build or the
query vector and the indexed vectors stop being comparable — producing retrieval that is
SUBTLY WRONG rather than broken. One copy makes that unrepresentable. Never pick the
option whose failure mode is silent.

The hop costs nothing new: the daemon already calls forge on the agent path at Run start
(the R17 liveness check), and the same Step makes a model inference call that dwarfs an
embed round-trip.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from armada_forge.ingest.embedder import MODEL_ID, embed

router = APIRouter()

# Matches `chunks.embedding vector(384)` in migration 002. Returned to the caller so the
# daemon can assert compatibility rather than assume it.
EMBEDDING_DIM = 384

# A query is one short string; the batch exists so a future caller with many texts does not
# have to issue an N+1. Bounded so a malformed caller cannot ask forge to embed a corpus.
MAX_TEXTS = 64


class EmbedRequest(BaseModel):
    texts: list[str] = Field(..., min_length=1, max_length=MAX_TEXTS)


class EmbedResponse(BaseModel):
    embeddings: list[list[float]]
    # Returned so the daemon can ASSERT it is talking to a forge that indexed with the same
    # model at the same dimension — cheap insurance against being pointed at a mismatched
    # peer, which is exactly the silent-skew failure this endpoint exists to prevent.
    model: str
    dim: int


@router.post("/embed", response_model=EmbedResponse)
def embed_texts(payload: EmbedRequest) -> EmbedResponse:
    """Embed one or more texts with the same model that indexed the corpus."""
    if any(not text.strip() for text in payload.texts):
        raise HTTPException(status_code=400, detail="every entry in `texts` must be non-empty")

    vectors = embed(payload.texts)

    # A dimension mismatch here means the configured model does not match the schema, which
    # would silently produce uncomparable vectors. Fail loudly instead.
    if vectors and len(vectors[0]) != EMBEDDING_DIM:
        raise HTTPException(
            status_code=500,
            detail=(
                f"embedding model {MODEL_ID} produced dim {len(vectors[0])}, "
                f"but the chunks table stores vector({EMBEDDING_DIM})"
            ),
        )

    return EmbedResponse(embeddings=vectors, model=MODEL_ID, dim=EMBEDDING_DIM)
