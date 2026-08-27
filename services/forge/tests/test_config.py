"""P0 backfill — startup configuration validation.

Training R1, R1b, R2, R3; edge 26.

WHY THIS FILE MATTERS MOST. config.py is the one place that decides whether armada-forge
starts at all, and its contract is that it collects EVERY fault and exits non-zero listing
all of them. The min_disk_gb defect lived exactly here: the shipped config carried a key
the validator did not know, and forge could not have started. These tests load the REAL
shipped config rather than a fixture, so that class of disagreement fails here first.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from armada_forge.config import ConfigError, load_config


# ── The shipped config must load ─────────────────────────────────────────────

def test_shipped_config_loads_cleanly(config_dir: Path) -> None:
    """The config the platform actually ships must be valid.

    This is the test that would have caught the min_disk_gb defect the moment the D1 spec
    correction added the key: a validator that does not know a shipped key fails here.
    """
    config = load_config(config_dir)
    assert len(config.base_models) == 5


def test_shipped_config_has_exactly_one_smoke_model(config_dir: Path) -> None:
    """R2 — exactly one, and R4g bakes that one into the armada-models image."""
    config = load_config(config_dir)
    smoke = [entry["id"] for entry in config.base_models if entry.get("smoke_test")]
    assert smoke == ["qwen3-0.6b"]


def test_shipped_zero_spend_defaults(config_dir: Path) -> None:
    """Invariant 7 — a default installation cannot reach a paid endpoint."""
    config = load_config(config_dir)
    assert config.teacher["enabled"] is False
    assert config.teacher["provider"] == "none"
    assert config.eval_config["mode"] == "mechanical"


# ── R3: a malformed entry exits non-zero naming its `id` ─────────────────────

def _append_entry(config_copy: Path, body: str) -> None:
    path = config_copy / "base-models.yaml"
    path.write_text(path.read_text() + body)


def test_missing_required_key_names_the_offending_id(config_copy: Path) -> None:
    """R3 — the error must name the entry, or an operator cannot find it."""
    _append_entry(
        config_copy,
        """
  - id: broken-model
    hf_id: Example/Broken
    serving_ref: broken:1b
    context_window: 8192
    chat_template: qwen3
    tool_format: hermes
    quantization: Q4_K_M
    min_ram_gb: 2
    trainable: true
    lora_target_modules: [q_proj]
    smoke_test: false
""",  # min_disk_gb deliberately omitted
    )

    with pytest.raises(ConfigError) as caught:
        load_config(config_copy)

    assert any("broken-model" in e and "min_disk_gb" in e for e in caught.value.errors)


def test_min_disk_gb_is_a_known_key(config_dir: Path) -> None:
    """The ISSUE #5 regression, pinned.

    min_disk_gb was absent from the known-key set, so the closed-schema check reported it
    unknown for every shipped entry and forge could not start.
    """
    config = load_config(config_dir)
    assert all("min_disk_gb" in entry for entry in config.base_models)


# ── R1b: `ollama` is the only accepted backend ───────────────────────────────

def test_unrecognised_backend_is_rejected_naming_it(config_copy: Path) -> None:
    """R1b — reject rather than accept optimistically.

    An entry naming a backend nothing can serve would otherwise register a ModelBinding at
    startup that fails only when an Agent runs against it.
    """
    path = config_copy / "base-models.yaml"
    path.write_text(path.read_text().replace("backend: ollama", "backend: colibri", 1))

    with pytest.raises(ConfigError) as caught:
        load_config(config_copy)

    assert any("colibri" in e for e in caught.value.errors)


# ── THE PROPERTY MOST LIKELY TO REGRESS SILENTLY ─────────────────────────────

def test_multiple_faults_are_reported_together(config_copy: Path) -> None:
    """R3/R12 — EVERY fault in one run, not the first.

    This is the property that degrades quietly: a refactor that returns early still passes
    every single-fault test above while forcing an operator to fix one error per restart.
    """
    path = config_copy / "base-models.yaml"
    text = path.read_text()
    text = text.replace("backend: ollama", "backend: colibri", 1)   # fault 1
    text = text.replace("min_ram_gb: 4", "min_ram_gb: -1", 1)       # fault 2
    path.write_text(text)

    eval_path = config_copy / "eval.yaml"
    eval_path.write_text(eval_path.read_text().replace("mode: mechanical", "mode: judge"))  # fault 3

    with pytest.raises(ConfigError) as caught:
        load_config(config_copy)

    errors = caught.value.errors
    assert len(errors) >= 3, f"expected every fault, got: {errors}"
    assert any("colibri" in e for e in errors)
    assert any("min_ram_gb" in e for e in errors)
    assert any("judge" in e and "enabled: false" in e for e in errors)


# ── Edge 26: the zero-spend cross-check ──────────────────────────────────────

def test_judge_mode_without_a_teacher_fails_naming_both(config_copy: Path) -> None:
    """Edge 26 — at STARTUP, never deferred to the first promotion.

    A misconfiguration that surfaces at first promotion surfaces after a training run has
    already been paid for in wall-clock time.
    """
    path = config_copy / "eval.yaml"
    path.write_text(path.read_text().replace("mode: mechanical", "mode: judge"))

    with pytest.raises(ConfigError) as caught:
        load_config(config_copy)

    message = " ".join(caught.value.errors)
    assert "eval.yaml" in message and "teacher.yaml" in message


def test_exactly_one_smoke_entry_is_enforced(config_copy: Path) -> None:
    """R2 — zero means smoke mode can train nothing; more than one is ambiguous."""
    path = config_copy / "base-models.yaml"
    head, _, tail = path.read_text().partition("- id: qwen3-1.7b")
    path.write_text(head + "- id: qwen3-1.7b" + tail.replace("smoke_test: false", "smoke_test: true", 1))

    with pytest.raises(ConfigError) as caught:
        load_config(config_copy)

    assert any("exactly one" in e and "found 2" in e for e in caught.value.errors)


@pytest.mark.parametrize("field,bad_value", [("min_ram_gb", 0), ("min_disk_gb", 0)])
def test_capacity_thresholds_must_be_positive(config_copy: Path, field: str, bad_value: int) -> None:
    """A threshold of zero can never refuse anything — the decorative-guard failure."""
    path = config_copy / "base-models.yaml"
    original = "min_ram_gb: 2" if field == "min_ram_gb" else "min_disk_gb: 2"
    path.write_text(path.read_text().replace(original, f"{field}: {bad_value}", 1))

    with pytest.raises(ConfigError) as caught:
        load_config(config_copy)

    assert any(field in e and "at least 1" in e for e in caught.value.errors)
