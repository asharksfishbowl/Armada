"""P11 — `tool_call_validity`. Training R34, R35a; upstream defect D6(b).

THE WHOLE POINT IS THE NULL. D6(b) found that R35 required candidate >= baseline on a
metric whose denominator is 0 on supplied-JSONL held-out samples, because no tool schemas
are presented at generation time. Treating 0/0 as a score would either block every
promotion or pass every one depending on the comparison's direction; neither is a
judgement. The correction is null, and exclusion from the comparison.
"""

from __future__ import annotations

import json

import pytest

from armada_forge.eval import tool_calls


def _hermes(name: str, arguments: dict | str) -> str:
    return f"<tool_call>{json.dumps({'name': name, 'arguments': arguments})}</tool_call>"


# ── R35a: null, never zero ───────────────────────────────────────────────────

def test_no_tool_calls_gives_null_not_zero() -> None:
    """The acceptance criterion: "records tool_call_validity: null — NOT 0"."""
    result = tool_calls.validity(["a plain prose answer", "another one"])
    assert result is None
    assert result != 0


def test_an_empty_completion_set_gives_null() -> None:
    assert tool_calls.validity([]) is None


def test_all_valid_gives_one() -> None:
    assert tool_calls.validity([_hermes("read_file", {"path": "a.txt"})]) == 1.0


def test_all_invalid_gives_zero_not_null() -> None:
    """Zero is a real score when something WAS emitted. Conflating it with the empty case
    is exactly the defect."""
    assert tool_calls.validity(["<tool_call>{not json</tool_call>"]) == 0.0


def test_a_mixed_set_gives_the_fraction() -> None:
    completions = [
        _hermes("read_file", {"path": "a"}),
        "<tool_call>{broken</tool_call>",
        _hermes("write_file", {"path": "b", "content": "x"}),
        "<tool_call>[]</tool_call>",
    ]
    assert tool_calls.validity(completions) == 0.5


# ── What counts as EMITTED ───────────────────────────────────────────────────

def test_a_malformed_call_still_counts_in_the_denominator() -> None:
    """If only parseable calls counted, a model emitting nothing but garbage would score a
    perfect 1.0 over an empty denominator — the metric would reward the failure it exists
    to catch."""
    assert len(tool_calls.extract("<tool_call>{broken</tool_call>")) == 1


def test_ordinary_fenced_json_is_not_counted_as_a_tool_call() -> None:
    """A prose answer containing a JSON example must not be miscounted as an attempted
    call, or a model that never used tools would be scored on its formatting."""
    assert tool_calls.extract("Here is some data:\n```json\n{\"a\": 1}\n```") == []


def test_a_fenced_block_naming_a_tool_is_counted() -> None:
    """`tool_format: json_schema` entries produce this shape when asked for a call in
    text."""
    completion = '```json\n{"name": "read_file", "arguments": {"path": "a"}}\n```'
    assert tool_calls.validity([completion]) == 1.0


# ── Structural validity ──────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "body",
    [
        '{"arguments": {}}',                    # no name
        '{"name": "", "arguments": {}}',        # empty name
        '{"name": "x"}',                        # no arguments
        '{"name": "x", "arguments": 3}',        # arguments not an object
        '{"name": "x", "arguments": "{bad"}',   # nested arguments unparseable
        '"just a string"',                      # not an object
    ],
)
def test_structurally_broken_calls_are_invalid(body: str) -> None:
    assert tool_calls.validity([f"<tool_call>{body}</tool_call>"]) == 0.0


def test_arguments_nested_as_a_json_string_are_accepted() -> None:
    """Some formats nest the arguments as a JSON string. Parsed, not rejected."""
    assert tool_calls.validity([_hermes("read_file", json.dumps({"path": "a"}))]) == 1.0


# ── Declared schemas, when there are any ─────────────────────────────────────

SCHEMA = {
    "read_file": {
        "required": ["path"],
        "properties": {"path": {"type": "string"}, "lines": {"type": "integer"}},
    }
}


def test_a_missing_required_property_is_invalid() -> None:
    assert tool_calls.validity([_hermes("read_file", {"lines": 3})], SCHEMA) == 0.0


def test_a_wrong_property_type_is_invalid() -> None:
    assert tool_calls.validity([_hermes("read_file", {"path": 3})], SCHEMA) == 0.0


def test_a_boolean_is_not_an_integer() -> None:
    """`True` is an int in Python and is not a number in JSON Schema. Accepting it would
    let a model emit `lines: true` and be scored correct."""
    assert tool_calls.validity([_hermes("read_file", {"path": "a", "lines": True})], SCHEMA) == 0.0


def test_a_call_naming_an_undeclared_tool_is_judged_structurally() -> None:
    """With no schema for that name, structural validity is all that CAN be checked.
    Claiming more would be a fiction — which is precisely R35c's point about what the
    default gate does and does not measure."""
    assert tool_calls.validity([_hermes("unknown_tool", {"x": 1})], SCHEMA) == 1.0
