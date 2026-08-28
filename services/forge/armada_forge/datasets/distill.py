"""Corpus distillation — Training R16, R16b, R16c; edges 5 and 22.

OFF BY DEFAULT AND UNREACHABLE WHILE OFF. `config/teacher.yaml` ships `enabled: false`, and
every entry point here raises `TeacherDisabled` before any socket is opened. That is what
makes edge 22 literal: a `POST /datasets` naming a `corpus_id` on a default installation is
refused with no outbound connection attempted, not merely with no connection succeeding.

R16 has two teacher calls per chunk, not one. The second is the entailment check, and it is
not optional polish: a distilled pair whose response is not entailed by its source chunk
teaches the adapter to hallucinate confidently in the corpus's own domain, which is the
single worst failure mode for a knowledge-specialised model.
"""

from __future__ import annotations

import json
from typing import Any

from armada_forge import db
from armada_forge.teacher import TeacherClient, TeacherUnreachable

DISTILL_SYSTEM = (
    "You write training data. Given a document chunk, emit instruction/response pairs that "
    "are answerable using ONLY that chunk. Reply with a JSON array of objects, each with "
    "exactly the keys `instruction` and `response`. Emit nothing else."
)

ENTAILMENT_SYSTEM = (
    "You check grounding. Given a source chunk and a candidate response, reply with exactly "
    "one word: `yes` if every claim in the response is supported by the chunk, `no` "
    "otherwise."
)


def _parse_pairs(raw: str) -> list[dict[str, str]]:
    """Tolerate a model that wrapped its JSON in prose or a fence.

    A teacher that ignores "emit nothing else" is a normal occurrence, not a fault worth
    failing a dataset build over — so the outermost array is extracted rather than demanded.
    A response with no array at all yields zero pairs and is simply skipped.
    """
    text = raw.strip()
    start, end = text.find("["), text.rfind("]")
    if start == -1 or end <= start:
        return []
    try:
        parsed = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []

    pairs = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        instruction, response = item.get("instruction"), item.get("response")
        if isinstance(instruction, str) and instruction.strip() and isinstance(response, str) and response.strip():
            pairs.append({"instruction": instruction.strip(), "response": response.strip()})
    return pairs


def sample_chunks(corpus_id: str, limit: int) -> list[dict[str, Any]]:
    """Chunks to distil from.

    Ordered by `chunk_id` rather than at random so that re-running a build over an
    unchanged Corpus distils the same chunks. Reproducibility matters more here than
    coverage variety, because every re-run of a random sample costs teacher tokens for
    material the previous run already paid for.
    """
    return db.query(
        """
        SELECT chunk_id, content, source_path
          FROM chunks
         WHERE corpus_id = %s
         ORDER BY chunk_id
         LIMIT %s
        """,
        (corpus_id, limit),
    )


def distil(
    corpus_id: str,
    client: TeacherClient,
    distillation_config: dict[str, Any],
) -> list[dict[str, Any]]:
    """R16 — instruction/response pairs grounded in sampled chunks.

    RAISES ON AN UNREACHABLE TEACHER (edge 5). Partial samples are discarded by simply not
    being returned, and the caller writes no `datasets` row — a half-distilled dataset
    recorded as complete would be trained on without anyone knowing it was truncated.
    """
    max_chunks = int(distillation_config.get("max_chunks", 500))
    pairs_per_chunk = int(distillation_config.get("pairs_per_chunk", 3))
    entailment_check = bool(distillation_config.get("entailment_check", True))

    samples: list[dict[str, Any]] = []

    for chunk in sample_chunks(corpus_id, max_chunks):
        content = chunk["content"]

        # Propagated, not caught. Edge 5 requires the whole build to fail naming the
        # endpoint; swallowing this per chunk would produce a dataset silently missing
        # most of its corpus.
        raw = client.complete([
            {"role": "system", "content": DISTILL_SYSTEM},
            {
                "role": "user",
                "content": f"Emit {pairs_per_chunk} pair(s) from this chunk:\n\n{content}",
            },
        ])

        for pair in _parse_pairs(raw)[:pairs_per_chunk]:
            if entailment_check and not _entailed(client, content, pair["response"]):
                continue
            samples.append({
                "instruction": pair["instruction"],
                "response": pair["response"],
                # R16a — a distilled response is a REFERENCE response written by something
                # other than the model under test, so it is eligible for the held-out split
                # (R33) exactly as a supplied one is.
                "origin": "distilled",
                "source_path": chunk.get("source_path"),
            })

    return samples


def _entailed(client: TeacherClient, chunk: str, response: str) -> bool:
    """R16's second teacher call.

    An unreachable teacher propagates (edge 5). An unparseable verdict is treated as NOT
    entailed: the check exists to discard hallucinations, so its ambiguous case must fail
    closed or it stops being a filter.
    """
    verdict = client.complete([
        {"role": "system", "content": ENTAILMENT_SYSTEM},
        {"role": "user", "content": f"CHUNK:\n{chunk}\n\nRESPONSE:\n{response}"},
    ])
    return verdict.strip().lower().startswith("yes")


__all__ = ["distil", "sample_chunks", "TeacherUnreachable"]
