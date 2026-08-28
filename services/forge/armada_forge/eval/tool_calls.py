"""`tool_call_validity` — Training R34, R35a; upstream defect D6(b).

THE METRIC IS NULL WHEN ITS DENOMINATOR IS ZERO, AND NULL IS EXCLUDED FROM THE COMPARISON.
That is D6(b)'s correction, and it is the whole reason this module exists as its own file
rather than as three lines inside `mechanical.py`.

The denominator is the number of tool calls EMITTED across the generated completions. On a
dataset built from operator-supplied JSONL — the common case, and the only one available on
a zero-cost installation — no tool schemas are presented at generation time, so no tool
calls are emitted and the denominator is 0. Treating 0/0 as a score would either block
every promotion or pass every one depending on the comparison's direction, and neither of
those is a judgement.

The consequence, stated plainly because R35c requires it to be visible: with
`tool_call_validity` null, the default mechanical gate reduces to a single perplexity
comparison.

WHAT "VALID" MEANS HERE. R35a defines validity as parsing and validating against the
DECLARED schema. When no schemas are declared — again, the common case — validity reduces
to structural correctness: the call parses as JSON, names a tool, and carries an arguments
object. That is a weaker check than the spec's ideal and it is deliberately not dressed up
as more; when schemas ARE supplied, required properties and types are checked too.
"""

from __future__ import annotations

import json
import re
from typing import Any

# Hermes-style, which is what `tool_format: hermes` entries emit.
_HERMES = re.compile(r"<tool_call>\s*(.*?)\s*</tool_call>", re.DOTALL)
# A fenced JSON block naming a tool, which is what `tool_format: json_schema` entries
# produce when asked for a call in text. Matched only when it mentions "name", so ordinary
# fenced JSON in a prose answer is not miscounted as an attempted tool call.
_FENCED = re.compile(r"```(?:json)?\s*(\{.*?\"name\".*?\})\s*```", re.DOTALL)


def extract(completion: str) -> list[str]:
    """Every tool call the completion ATTEMPTED, as raw text.

    Attempted, not parsed: a malformed call still counts in the denominator, because a
    model that emits unparseable tool calls is exactly what this metric exists to catch. If
    only parseable calls counted, a model that emitted nothing but garbage would score a
    perfect 1.0 over an empty denominator.
    """
    return [match.strip() for match in (_HERMES.findall(completion) + _FENCED.findall(completion))]


def _validates(raw: str, schemas: dict[str, dict[str, Any]]) -> bool:
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return False
    if not isinstance(parsed, dict):
        return False

    name = parsed.get("name")
    if not isinstance(name, str) or not name:
        return False

    arguments = parsed.get("arguments")
    if isinstance(arguments, str):
        # Some formats nest the arguments as a JSON string. Accepted, then parsed.
        try:
            arguments = json.loads(arguments)
        except json.JSONDecodeError:
            return False
    if not isinstance(arguments, dict):
        return False

    schema = schemas.get(name)
    if schema is None:
        # No declared schema for this name. Structural validity is all that can be checked,
        # and claiming more would be a fiction.
        return True

    required = schema.get("required") or []
    if any(key not in arguments for key in required):
        return False

    properties = schema.get("properties") or {}
    for key, value in arguments.items():
        declared = properties.get(key)
        if not isinstance(declared, dict):
            continue
        expected = declared.get("type")
        if expected and not _type_matches(value, expected):
            return False
    return True


_JSON_TYPES: dict[str, Any] = {
    "string": str,
    "integer": int,
    "number": (int, float),
    "boolean": bool,
    "array": list,
    "object": dict,
}


def _type_matches(value: Any, expected: str) -> bool:
    python_type = _JSON_TYPES.get(expected)
    if python_type is None:
        return True
    if expected in ("integer", "number") and isinstance(value, bool):
        # `True` is an int in Python and is not a number in JSON Schema.
        return False
    return isinstance(value, python_type)


def validity(
    completions: list[str], schemas: dict[str, dict[str, Any]] | None = None
) -> float | None:
    """R35a — the fraction that validate, or None when nothing was emitted.

    NONE, NOT ZERO. The caller must exclude a null from R35's comparison rather than treat
    it as a failing score.
    """
    schemas = schemas or {}
    emitted = [call for completion in completions for call in extract(completion)]
    if not emitted:
        return None
    return sum(1 for call in emitted if _validates(call, schemas)) / len(emitted)
