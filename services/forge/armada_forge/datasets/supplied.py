"""Operator-supplied JSONL — Training R15a, R15b; edge 24.

THIS IS THE TEACHER-FREE DATASET SOURCE. It requires no teacher model, no credential, and
no egress, which is what makes a dataset buildable on a default installation where
`config/teacher.yaml` has `enabled: false` (R16b).

VALIDATION IS ALL-OR-NOTHING (edge 24). One malformed line rejects the whole upload,
naming every offending line number, and `/data/supplied/` is left byte-for-byte unchanged.
Storing the good lines and reporting the bad ones would give an operator a file whose
contents they did not choose, and a `sample_count` they cannot reconcile against the file
they uploaded.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

SUPPLIED_ROOT = Path(os.environ.get("ARMADA_SUPPLIED_ROOT", "/data/supplied"))

# The stored filename is `{name}.jsonl` under SUPPLIED_ROOT, and `name` arrives from an
# HTTP request. Constrained rather than sanitised: a rejected name is a clear 400, whereas
# a silently rewritten one stores the upload somewhere the operator did not ask for. The
# pattern admits no `/`, no `.`, and no `..`, so traversal is unrepresentable rather than
# stripped.
NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


class SuppliedValidationError(Exception):
    """Carries every offending line number, not the first.

    An operator fixing a JSONL wants the whole list in one round trip. Reporting one line
    per attempt turns a ten-line problem into ten uploads.
    """

    def __init__(self, problems: list[str]) -> None:
        self.problems = problems
        super().__init__("; ".join(problems))


def validate_name(name: str) -> str | None:
    """Return a refusal message, or None when the name is storable."""
    if not NAME_PATTERN.match(name):
        return (
            f"supplied dataset name `{name}` must match ^[a-z0-9][a-z0-9-]{{0,63}}$ — "
            "it becomes a filename under /data/supplied/, so path separators and dots "
            "are refused rather than stripped"
        )
    return None


def parse_jsonl(text: str) -> list[dict[str, Any]]:
    """R15a — parse and validate every line, or raise with every line number that failed.

    `origin` is stamped here rather than at build time (R15b): a supplied sample carries a
    reference response written by something other than the model under test, which is
    exactly the property that makes it eligible for the held-out evaluation split (R33).
    Losing the distinction downstream would put a model's own prior output into its own
    eval set.
    """
    problems: list[str] = []
    samples: list[dict[str, Any]] = []

    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line:
            # A trailing newline is not a malformed record. Blank lines are skipped rather
            # than counted, because rejecting a file for ending in "\n" would be absurd.
            continue

        try:
            parsed = json.loads(line)
        except json.JSONDecodeError as exc:
            problems.append(f"line {number}: not valid JSON ({exc.msg})")
            continue

        if not isinstance(parsed, dict):
            problems.append(f"line {number}: expected a JSON object, got {type(parsed).__name__}")
            continue

        missing = [
            field
            for field in ("instruction", "response")
            if not isinstance(parsed.get(field), str) or not parsed[field].strip()
        ]
        if missing:
            problems.append(
                f"line {number}: `{'` and `'.join(missing)}` must be present and a non-empty string"
            )
            continue

        # R15a — "any other key is ignored". Ignored, not rejected: an operator's export
        # tool may carry ids or metadata, and refusing the file over a harmless extra
        # column would make real datasets unusable for no gain.
        samples.append(
            {
                "instruction": parsed["instruction"],
                "response": parsed["response"],
                "origin": "supplied",
            }
        )

    if problems:
        raise SuppliedValidationError(problems)

    if not samples:
        raise SuppliedValidationError(["the upload contained no samples"])

    return samples


def store(name: str, text: str) -> dict[str, Any]:
    """R15a — validate, then write. NEVER the other way round.

    The validation raises before any filesystem call, which is what makes edge 24's
    "`/data/supplied/` is unchanged" true by construction rather than by a cleanup path
    that could itself fail.
    """
    refusal = validate_name(name)
    if refusal:
        raise SuppliedValidationError([refusal])

    samples = parse_jsonl(text)

    SUPPLIED_ROOT.mkdir(parents=True, exist_ok=True)
    path = SUPPLIED_ROOT / f"{name}.jsonl"
    path.write_text("".join(json.dumps(sample) + "\n" for sample in samples), encoding="utf-8")

    return {"supplied_file": str(path), "name": name, "sample_count": len(samples)}


def resolve(supplied_file: str) -> Path:
    """Resolve a `supplied_file` request field to a path INSIDE SUPPLIED_ROOT.

    R15 describes `supplied_file` as "a path under /data/supplied/", and a request field
    that becomes a filesystem path is a boundary that has to be checked. Both a bare name
    and a full path are accepted, and both are re-resolved against the root, so `..` and an
    absolute path elsewhere resolve to something outside the root and are refused below.
    """
    candidate = Path(supplied_file)
    if not candidate.is_absolute():
        candidate = SUPPLIED_ROOT / candidate
    if candidate.suffix != ".jsonl":
        candidate = candidate.with_suffix(".jsonl")

    resolved = candidate.resolve()
    root = SUPPLIED_ROOT.resolve()
    if resolved != root and root not in resolved.parents:
        raise SuppliedValidationError(
            [f"`{supplied_file}` resolves outside {SUPPLIED_ROOT}; supplied files are read "
             "only from that directory"]
        )
    return resolved


def read(supplied_file: str) -> list[dict[str, Any]]:
    """R15b — read a stored upload back as samples with `origin: supplied`."""
    path = resolve(supplied_file)
    if not path.exists():
        raise SuppliedValidationError([f"no supplied dataset at `{path}`"])
    return parse_jsonl(path.read_text(encoding="utf-8"))


def listing() -> list[dict[str, Any]]:
    """Every stored upload, so the dashboard's build-dataset modal can offer them."""
    if not SUPPLIED_ROOT.exists():
        return []
    entries = []
    for path in sorted(SUPPLIED_ROOT.glob("*.jsonl")):
        entries.append({
            "name": path.stem,
            "supplied_file": str(path),
            "bytes": path.stat().st_size,
        })
    return entries
