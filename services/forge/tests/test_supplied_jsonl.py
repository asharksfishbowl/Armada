"""P11 — operator-supplied JSONL. Training R15a, R15b; edge 24.

THE ZERO-COST DATASET SOURCE. With `config/teacher.yaml` disabled by default this and
captured trajectories are the only two sources a fresh installation can build from, so its
validation is the boundary between "the free path works" and "the operator gets a confusing
error".
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from armada_forge.datasets import supplied


@pytest.fixture(autouse=True)
def supplied_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "supplied"
    monkeypatch.setattr(supplied, "SUPPLIED_ROOT", root)
    return root


def _line(instruction: str = "ask", response: str = "answer") -> str:
    return json.dumps({"instruction": instruction, "response": response})


# ── R15a: validation ─────────────────────────────────────────────────────────

def test_valid_upload_is_stored_and_stamped_supplied(supplied_root: Path) -> None:
    """R15b — `origin: supplied` is stamped at upload, not inferred later.

    It is what makes the sample eligible for the held-out split (R33), so losing it
    downstream would silently exclude every supplied sample from the eval set.
    """
    result = supplied.store("recipes", f"{_line()}\n{_line('b', 'c')}\n")

    assert result["sample_count"] == 2
    stored = [json.loads(line) for line in (supplied_root / "recipes.jsonl").read_text().splitlines()]
    assert all(sample["origin"] == "supplied" for sample in stored)


def test_extra_keys_are_ignored_not_rejected() -> None:
    """R15a — "any other key is ignored".

    Ignored rather than rejected: an operator's export tool carries ids and metadata, and
    refusing a real dataset over a harmless extra column would make the free path unusable.
    """
    samples = supplied.parse_jsonl(json.dumps({"instruction": "a", "response": "b", "id": 7}))
    assert samples == [{"instruction": "a", "response": "b", "origin": "supplied"}]


def test_blank_lines_are_not_records() -> None:
    """Rejecting a file for ending in a newline would be absurd."""
    assert len(supplied.parse_jsonl(f"{_line()}\n\n\n")) == 1


# ── Edge 24: one bad line rejects the WHOLE upload ───────────────────────────

@pytest.mark.parametrize(
    "bad,expected",
    [
        (json.dumps({"response": "b"}), "instruction"),
        (json.dumps({"instruction": "a"}), "response"),
        (json.dumps({"instruction": "", "response": "b"}), "instruction"),
        (json.dumps({"instruction": "a", "response": "   "}), "response"),
        ("{not json", "not valid JSON"),
        (json.dumps(["a", "b"]), "expected a JSON object"),
    ],
)
def test_a_malformed_line_rejects_the_upload_naming_its_number(bad: str, expected: str) -> None:
    """Edge 24 — the offending LINE NUMBER, because an operator cannot find it otherwise."""
    with pytest.raises(supplied.SuppliedValidationError) as caught:
        supplied.parse_jsonl(f"{_line()}\n{bad}\n{_line()}\n")

    problems = caught.value.problems
    assert len(problems) == 1
    assert problems[0].startswith("line 2:")
    assert expected in problems[0]


def test_every_offending_line_is_reported_not_just_the_first() -> None:
    """One upload per fault would turn a ten-line problem into ten round trips."""
    text = "\n".join([_line(), "{bad", json.dumps({"instruction": "a"}), _line()])

    with pytest.raises(supplied.SuppliedValidationError) as caught:
        supplied.parse_jsonl(text)

    assert len(caught.value.problems) == 2
    assert caught.value.problems[0].startswith("line 2:")
    assert caught.value.problems[1].startswith("line 3:")


def test_a_rejected_upload_leaves_the_directory_unchanged(supplied_root: Path) -> None:
    """Edge 24's other half, and the one a cleanup path could get wrong.

    Validation raises BEFORE any filesystem call, so this holds by construction rather than
    by a rollback that could itself fail.
    """
    supplied.store("good", _line())
    before = sorted(p.name for p in supplied_root.iterdir())

    with pytest.raises(supplied.SuppliedValidationError):
        supplied.store("bad", "{not json")

    assert sorted(p.name for p in supplied_root.iterdir()) == before


def test_an_empty_upload_is_refused() -> None:
    with pytest.raises(supplied.SuppliedValidationError) as caught:
        supplied.parse_jsonl("\n\n")
    assert "no samples" in caught.value.problems[0]


# ── The name becomes a filename, so it is a boundary ─────────────────────────

@pytest.mark.parametrize("name", ["../escape", "a/b", "with.dot", "UPPER", "", "-leading"])
def test_a_name_that_could_escape_the_root_is_refused(name: str) -> None:
    """Refused, not sanitised.

    A silently rewritten name stores the upload somewhere the operator did not ask for, and
    they would then not find it in the build-dataset modal.
    """
    with pytest.raises(supplied.SuppliedValidationError):
        supplied.store(name, _line())


def test_resolve_refuses_a_path_outside_the_root(supplied_root: Path) -> None:
    """`supplied_file` arrives from an HTTP request and becomes a filesystem read."""
    with pytest.raises(supplied.SuppliedValidationError) as caught:
        supplied.resolve("/etc/passwd")
    assert "resolves outside" in str(caught.value)


def test_resolve_accepts_a_bare_name_and_a_full_path(supplied_root: Path) -> None:
    supplied.store("recipes", _line())
    assert supplied.resolve("recipes") == supplied.resolve(str(supplied_root / "recipes.jsonl"))


def test_read_round_trips(supplied_root: Path) -> None:
    supplied.store("recipes", f"{_line('q1', 'a1')}\n")
    assert supplied.read("recipes") == [
        {"instruction": "q1", "response": "a1", "origin": "supplied"}
    ]
