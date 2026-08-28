"""Trajectory samples — Training R17; cross-service boundary 3.

THE ONLY PATH FROM AGENT BEHAVIOUR BACK INTO TRAINING, AND IT IS ONE-DIRECTIONAL. The
daemon writes Events; forge reads them. Nothing here writes to `events`, which invariant 5
makes structurally true anyway — migration 005 installs a trigger that rejects any UPDATE
or DELETE on that table.

INVARIANT 1 DECIDES WHAT IS ELIGIBLE. Only a Run whose `run_end` Event records
`outcome: success` contributes. `incomplete`, `failed`, `cancelled`, `budget_exhausted`,
and `no_progress` are all excluded, and `incomplete` in particular is excluded even though
it is a legitimate self-reported negative rather than a fault: training on a trajectory the
agent itself reported as not-done teaches it to stop early.

Read from `runs.outcome` rather than by unpacking the `run_end` payload. The two cannot
disagree — the daemon writes both in the same termination path and migration 005's
`runs_terminal_has_outcome` CHECK makes a terminal Run without an outcome unrepresentable —
and the column is indexed while a jsonb payload probe is not.
"""

from __future__ import annotations

import json
from typing import Any

from armada_forge import db

# R17 — the Event types that carry conversation content. Everything else in the R55 union
# (run_start, reasoning, retrieval, compaction, mode_downgraded, mcp_unavailable,
# delegation, error, run_end) is observability, not dialogue, and rendering it as a turn
# would teach the adapter to emit log lines.
CONTENT_EVENT_TYPES = ("user_message", "model_response", "tool_call", "tool_result")


def _tool_call_block(payload: dict[str, Any]) -> str:
    """One dispatched tool call, rendered format-neutrally.

    Taken from the `tool_call` Event rather than from `model_response.tool_calls`, which
    carries the same data. The two are NOT interchangeable: the daemon appends a
    `tool_call` Event only for a call it actually dispatched, so a response whose later
    calls were cut off by a budget lists calls that never ran. Reading the dispatched
    Events keeps every requested call paired with the result that followed it, and keeps
    the ordering R17 asks for exact.
    """
    arguments = payload.get("arguments")
    rendered = arguments if isinstance(arguments, str) else json.dumps(arguments or {})
    return f"<tool_call>{json.dumps({'name': payload.get('name'), 'arguments': rendered})}</tool_call>"


def flatten_run(system_prompt: str, events: list[dict[str, Any]]) -> list[dict[str, str]]:
    """R17 — one Run becomes ONE multi-turn sample, in original order."""
    messages: list[dict[str, str]] = []
    if system_prompt.strip():
        messages.append({"role": "system", "content": system_prompt})

    def push(role: str, content: str) -> None:
        if not content:
            return
        # Consecutive assistant turns are merged: an assistant text response followed by
        # its tool calls is one model turn that the Event log happens to record as several
        # rows. Emitting them separately would train a turn boundary that never existed.
        if messages and messages[-1]["role"] == role == "assistant":
            messages[-1]["content"] = f"{messages[-1]['content']}\n{content}"
            return
        messages.append({"role": role, "content": content})

    for event in events:
        event_type = event["type"]
        payload = event.get("payload") or {}

        if event_type == "user_message":
            push("user", str(payload.get("content", "")))
        elif event_type == "model_response":
            push("assistant", str(payload.get("content") or ""))
        elif event_type == "tool_call":
            push("assistant", _tool_call_block(payload))
        elif event_type == "tool_result":
            content = str(payload.get("content", ""))
            if payload.get("is_error"):
                # Retained, not dropped. A recovered tool error is exactly the behaviour
                # worth learning; hiding it would leave the adapter with a transcript in
                # which the recovery has no cause.
                content = f"[error] {content}"
            push("tool", content)

    return messages


# INVARIANT 1, IN SQL. `r.outcome = 'success'` is the whole eligibility rule: a Run that
# terminated any other way — including the self-reported `incomplete` — never becomes
# training data. `LIMIT ... NULL` returns every row in Postgres, so one statement serves
# both the bounded and unbounded cases without assembling the text.
ELIGIBLE_RUNS = """
    SELECT r.run_id,
           COALESCE(av.definition -> 'persona' ->> 'system_prompt', '') AS system_prompt
      FROM runs r
      JOIN agent_versions av ON av.agent_version_id = r.agent_version_id
     WHERE r.status = 'terminal' AND r.outcome = 'success'
     ORDER BY r.started_at DESC
     LIMIT %(limit)s
"""

ELIGIBLE_RUNS_FOR_AGENTS = """
    SELECT r.run_id,
           COALESCE(av.definition -> 'persona' ->> 'system_prompt', '') AS system_prompt
      FROM runs r
      JOIN agent_versions av ON av.agent_version_id = r.agent_version_id
     WHERE r.status = 'terminal' AND r.outcome = 'success'
       AND av.agent_id = ANY(%(agent_ids)s)
     ORDER BY r.started_at DESC
     LIMIT %(limit)s
"""


def _first(messages: list[dict[str, str]], role: str) -> str:
    return next((m["content"] for m in messages if m["role"] == role), "")


def _last(messages: list[dict[str, str]], role: str) -> str:
    return next((m["content"] for m in reversed(messages) if m["role"] == role), "")


def collect(agent_ids: list[str] | None = None, limit: int | None = None) -> list[dict[str, Any]]:
    """R15/R17 — every eligible Run, flattened, newest first.

    `agent_ids` filters by the Agent behind each Run's pinned version. Runs are joined to
    `agent_versions` for the system prompt because the Event log's `run_start` payload does
    not carry it, and a trajectory rendered without its persona trains the adapter on a
    conversation that never happened.
    """
    # TWO LITERAL STATEMENTS RATHER THAN ONE ASSEMBLED FROM FRAGMENTS. The optional filter
    # and the optional limit would otherwise be spliced into the SQL text, and while the
    # spliced pieces are constants and the values are bound, a query built by string
    # concatenation is the shape this repo has agreed not to write — it costs a reviewer
    # and a static analyser real effort to prove safe, every time either looks at it.
    # `agent_ids` and `limit` are both bound parameters below.
    params: dict[str, Any] = {"limit": limit, "agent_ids": list(agent_ids or [])}

    if agent_ids:
        sql = ELIGIBLE_RUNS_FOR_AGENTS
    else:
        sql = ELIGIBLE_RUNS

    samples: list[dict[str, Any]] = []
    for run in db.query(sql, params):
        events = db.query(
            """
            SELECT type, payload
              FROM events
             WHERE run_id = %s AND type = ANY(%s)
             ORDER BY seq
            """,
            (run["run_id"], list(CONTENT_EVENT_TYPES)),
        )
        messages = flatten_run(run["system_prompt"], events)

        # A "successful" Run with no dialogue at all is not a training sample. It can
        # happen — a Run whose only Turn was a finish call with no model text — and an
        # empty transcript would inflate `sample_count` with nothing to learn from.
        if not any(m["role"] == "assistant" for m in messages):
            continue

        samples.append({
            # R16a — a trajectory still carries instruction/response so every sample has
            # one shape. The REFERENCE RESPONSE here is a small model's own prior output,
            # which is precisely why R33 bars these from the held-out eval split: scoring a
            # candidate against its own predecessor's output measures nothing.
            "instruction": _first(messages, "user"),
            "response": _last(messages, "assistant"),
            "origin": "trajectory",
            "messages": messages,
            "run_id": str(run["run_id"]),
        })

    return samples
