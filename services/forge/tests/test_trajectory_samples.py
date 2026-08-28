"""P11 — trajectory samples and chat-template rendering. Training R17, R18; invariant 1.

CROSS-SERVICE BOUNDARY 3, EXERCISED. The daemon writes Events; forge reads them. This is
the only path from agent behaviour back into training, and INVARIANT 1 decides what is
eligible: only a Run whose outcome is `success` contributes. `incomplete` is excluded even
though it is a legitimate self-reported negative rather than a fault — training on a
trajectory the agent itself reported as not-done teaches it to stop early.
"""

from __future__ import annotations

from typing import Any

import pytest

from armada_forge.datasets import render, trajectory


class FakeDB:
    def __init__(self, runs: list[dict[str, Any]], events: dict[str, list[dict[str, Any]]]) -> None:
        self.runs = runs
        self.events = events
        self.run_sql: str = ""

    def query(self, sql: str, params: Any = None) -> list[dict[str, Any]]:
        flat = " ".join(sql.split())
        if "FROM runs" in flat:
            self.run_sql = flat
            return self.runs
        return self.events.get(str(params[0]), [])


def _event(event_type: str, **payload: Any) -> dict[str, Any]:
    return {"type": event_type, "payload": payload}


CONVERSATION = [
    _event("user_message", content="find the config"),
    _event("model_response", content="I will search.", tool_calls=[{"id": "1", "name": "grep"}]),
    _event("tool_call", tool_call_id="1", name="grep", arguments={"pattern": "config"}),
    _event("tool_result", tool_call_id="1", name="grep", content="config.yaml"),
    _event("model_response", content="Found it in config.yaml."),
]


# ── R17: what a flattened Run looks like ─────────────────────────────────────

def test_a_run_becomes_one_multi_turn_sample_in_original_order() -> None:
    messages = trajectory.flatten_run("You are a helper.", CONVERSATION)

    assert [m["role"] for m in messages] == ["system", "user", "assistant", "tool", "assistant"]
    assert messages[0]["content"] == "You are a helper."
    assert messages[1]["content"] == "find the config"
    assert messages[3]["content"] == "config.yaml"


def test_the_tool_call_is_read_from_the_dispatched_event_not_the_response() -> None:
    """The two carry the same data and are NOT interchangeable.

    The daemon appends a `tool_call` Event only for a call it actually dispatched, so a
    response whose later calls were cut off by a budget lists calls that never ran. Reading
    the dispatched Events keeps every requested call paired with the result that followed.
    """
    messages = trajectory.flatten_run("", CONVERSATION)
    assistant = messages[1]["content"]

    assert "<tool_call>" in assistant
    assert '"grep"' in assistant
    # The text turn and its tool call are ONE model turn that the Event log records as two
    # rows; emitting them separately would train a turn boundary that never existed.
    assert assistant.startswith("I will search.")


def test_a_tool_error_is_retained_and_marked() -> None:
    """A recovered tool error is exactly the behaviour worth learning. Dropping it leaves
    the adapter with a transcript in which the recovery has no cause."""
    messages = trajectory.flatten_run("", [
        _event("user_message", content="go"),
        _event("tool_call", name="read", arguments={}),
        _event("tool_result", name="read", content="no such file", is_error=True),
    ])
    assert messages[-1] == {"role": "tool", "content": "[error] no such file"}


def test_observability_events_are_not_rendered_as_turns() -> None:
    """`retrieval`, `compaction`, `error` and friends are observability, not dialogue.
    Rendering them as turns would teach the adapter to emit log lines."""
    messages = trajectory.flatten_run("", [
        _event("run_start", agent_version_id="a"),
        _event("user_message", content="go"),
        _event("retrieval", chunks=3),
        _event("model_response", content="done"),
        _event("run_end", outcome="success"),
    ])
    assert [m["role"] for m in messages] == ["user", "assistant"]


def test_only_the_content_event_types_are_queried() -> None:
    """The filter is applied in SQL, not after: an `events` table for a long Run carries
    far more observability rows than dialogue ones."""
    assert set(trajectory.CONTENT_EVENT_TYPES) == {
        "user_message", "model_response", "tool_call", "tool_result"
    }


# ── Invariant 1: eligibility ────────────────────────────────────────────────

def test_only_successful_runs_are_collected(monkeypatch: pytest.MonkeyPatch) -> None:
    """Invariant 1 — read from the indexed `runs.outcome` column, which cannot disagree
    with the `run_end` payload: migration 005's CHECK makes a terminal Run without an
    outcome unrepresentable."""
    db = FakeDB(
        [{"run_id": "r1", "system_prompt": "persona"}],
        {"r1": CONVERSATION},
    )
    monkeypatch.setattr(trajectory, "db", db)

    trajectory.collect()

    assert "r.outcome = 'success'" in db.run_sql
    assert "r.status = 'terminal'" in db.run_sql


def test_a_run_with_no_assistant_turn_is_skipped(monkeypatch: pytest.MonkeyPatch) -> None:
    """A successful Run whose only Turn was a finish call with no model text has nothing to
    learn from, and would otherwise inflate `sample_count` with an empty transcript."""
    db = FakeDB(
        [{"run_id": "r1", "system_prompt": ""}],
        {"r1": [_event("user_message", content="go")]},
    )
    monkeypatch.setattr(trajectory, "db", db)

    assert trajectory.collect() == []


def test_a_collected_sample_carries_origin_trajectory(monkeypatch: pytest.MonkeyPatch) -> None:
    """R16a/R33 — this is the field that bars the sample from the held-out eval split. Its
    reference response is a small model's own prior output."""
    db = FakeDB([{"run_id": "r1", "system_prompt": "p"}], {"r1": CONVERSATION})
    monkeypatch.setattr(trajectory, "db", db)

    sample = trajectory.collect()[0]
    assert sample["origin"] == "trajectory"
    assert sample["instruction"] == "find the config"
    assert sample["response"] == "Found it in config.yaml."


def test_the_agent_filter_is_applied_in_sql(monkeypatch: pytest.MonkeyPatch) -> None:
    db = FakeDB([], {})
    monkeypatch.setattr(trajectory, "db", db)

    trajectory.collect(agent_ids=["a1"])

    assert "av.agent_id = ANY" in db.run_sql
    # Bound, never spliced. Two literal statements rather than one assembled from
    # fragments, so neither a reviewer nor a static analyser has to prove it safe.
    assert "a1" not in db.run_sql


# ── R18: the three chat templates ───────────────────────────────────────────

MESSAGES = [
    {"role": "system", "content": "persona"},
    {"role": "user", "content": "hello"},
    {"role": "assistant", "content": "hi"},
    {"role": "tool", "content": "result"},
]


def test_qwen3_is_chatml() -> None:
    text = render.render(MESSAGES, "qwen3")
    assert text.startswith("<|im_start|>system\npersona<|im_end|>\n")
    assert "<|im_start|>tool\nresult<|im_end|>" in text


def test_llama3_uses_ipython_for_tool_results() -> None:
    """Sending them as `user` would misattribute machine output to the operator."""
    text = render.render(MESSAGES, "llama3")
    assert text.startswith("<|begin_of_text|>")
    assert "<|start_header_id|>ipython<|end_header_id|>" in text
    assert "<|start_header_id|>tool<|end_header_id|>" not in text


def test_gemma3_folds_the_system_prompt_into_the_first_user_turn() -> None:
    """Gemma has two roles and no system role. Dropping the persona would train the adapter
    on a conversation that never happened."""
    text = render.render(MESSAGES, "gemma3")
    assert "<start_of_turn>user\npersona\n\nhello<end_of_turn>" in text
    assert "<start_of_turn>model\nhi<end_of_turn>" in text
    assert "system" not in text


def test_gemma3_renders_a_system_only_conversation() -> None:
    text = render.render([{"role": "system", "content": "persona"}], "gemma3")
    assert "persona" in text


def test_an_unknown_template_raises_rather_than_guessing() -> None:
    """config.py rejects a fourth value at startup, so this is unreachable — and it raises
    rather than falling through to a plausible default, because a dataset rendered with the
    wrong template trains silently and badly."""
    with pytest.raises(render.UnknownChatTemplate):
        render.render(MESSAGES, "mistral")


def test_an_instruction_response_pair_renders_through_the_same_path() -> None:
    """ONE renderer for both sample shapes. Two code paths would drift."""
    messages = render.messages_for({"instruction": "q", "response": "a", "origin": "supplied"})
    assert messages == [
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": "a"},
    ]


def test_a_trajectory_sample_keeps_its_own_message_list() -> None:
    sample = {"origin": "trajectory", "messages": [{"role": "system", "content": "p"}]}
    assert render.messages_for(sample) == [{"role": "system", "content": "p"}]
