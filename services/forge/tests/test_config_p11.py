"""P11 — the startup validations this phase adds. Training R16c, R25, R33, R34b; edge 26.

CONFIG VALIDATION HAPPENS AT STARTUP, NEVER AT FIRST USE. Every check here refuses to boot
rather than deferring, for the reason the whole file exists: a misconfiguration that
surfaces at the first promotion surfaces AFTER a training run has already been paid for in
wall-clock time. Failing at boot costs seconds.

Every test loads the REAL shipped config or a copy of it, not a fixture, so a disagreement
between what the platform ships and what the validator knows fails here first. That is the
class of defect that produced ISSUE #5.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from armada_forge.config import ConfigError, load_config
from armada_forge.teacher import TeacherSettings


def set_key(path: Path, key: str, value: str, *, indent: str = "") -> None:
    """Rewrite a top-level-ish YAML setting, matching a whole LINE.

    A plain `str.replace` is wrong on these files and silently so: `config/teacher.yaml`
    documents `enabled: false` inside its banner comment, so replacing the first occurrence
    edits the comment and leaves the setting untouched. A test that then asserts a
    ConfigError still passes — for a different reason than the one it claims — which is
    exactly the failure mode this whole suite exists to catch.
    """
    text = path.read_text()
    pattern = re.compile(rf"(?m)^{re.escape(indent)}{re.escape(key)}:.*$")
    updated, count = pattern.subn(f"{indent}{key}: {value}", text, count=1)
    assert count == 1, f"no `{key}:` line found in {path.name}"
    path.write_text(updated)


# ── The shipped config still loads with the new files required ──────────────

def test_the_shipped_config_still_loads(config_dir: Path) -> None:
    """P11 adds `models.yaml` and `training-remote.yaml` to the required set. If either
    disagreed with the validator, forge could not start."""
    config = load_config(config_dir)
    assert "ollama" in config.models["backends"]
    assert config.training_remote["provider"] == "none"


def test_the_shipped_defaults_remain_zero_spend(config_dir: Path) -> None:
    """Invariant 7 — the default path contacts no paid endpoint. `provider: none` on BOTH
    the teacher and the remote training provider is what that reduces to in config."""
    config = load_config(config_dir)
    assert config.teacher["enabled"] is False
    assert config.eval_config["mode"] == "mechanical"
    assert config.training_remote["provider"] == "none"


def test_the_shipped_eval_fraction_is_usable(config_dir: Path) -> None:
    fraction = load_config(config_dir).eval_config["eval_fraction"]
    assert 0 < fraction < 1


# ── R33: a degenerate eval_fraction ─────────────────────────────────────────

@pytest.mark.parametrize("value", ["0", "1", "-0.2", "1.5", "'a lot'"])
def test_a_degenerate_eval_fraction_fails_startup(config_copy: Path, value: str) -> None:
    """0 reserves no held-out set for the gate to score; 1 leaves nothing to train on.
    Either way the failure would otherwise surface at the first split, after a dataset had
    already been built."""
    set_key(config_copy / "eval.yaml", "eval_fraction", value)

    with pytest.raises(ConfigError) as caught:
        load_config(config_copy)

    assert any("eval_fraction" in error for error in caught.value.errors)


# ── R16c: a `provider: local` teacher must resolve through models.yaml ──────

def test_a_local_teacher_naming_an_unknown_backend_fails_startup(config_copy: Path) -> None:
    """R16c — resolved through config/models.yaml BY NAME. An unknown name would otherwise
    surface as a connection failure to an empty URL, deep inside a distillation run."""
    path = config_copy / "teacher.yaml"
    set_key(path, "enabled", "true")
    set_key(path, "provider", "local")
    set_key(path, "backend", "colibri", indent="  ")

    with pytest.raises(ConfigError) as caught:
        load_config(config_copy)

    assert any("colibri" in error and "models.yaml" in error for error in caught.value.errors)


def test_a_disabled_teacher_is_not_endpoint_checked(config_dir: Path) -> None:
    """The shipped file has `provider: none` with a PLACEHOLDER base_url. Failing startup
    over a placeholder that is never read would make the zero-spend default configuration
    refuse to boot."""
    load_config(config_dir)  # must not raise


# ── R25 / invariant 8: the remote training provider ─────────────────────────

def test_a_configured_remote_provider_without_a_key_variable_fails_startup(
    config_copy: Path,
) -> None:
    """Invariant 8 — the field names an ENVIRONMENT VARIABLE. A provider configured without
    one has no credential to read, and edge 9 could then never produce its message."""
    path = config_copy / "training-remote.yaml"
    set_key(path, "provider", "example")
    set_key(path, "api_key_env", "''")

    with pytest.raises(ConfigError) as caught:
        load_config(config_copy)

    assert any("api_key_env" in error for error in caught.value.errors)


def test_a_non_positive_max_runtime_fails_startup(config_copy: Path) -> None:
    """Edge 10 cancels a run that exceeds this. A ceiling of 0 can never fire, which is the
    decorative-threshold failure again under a different key."""
    path = config_copy / "training-remote.yaml"
    set_key(path, "provider", "example")
    set_key(path, "max_runtime_minutes", "0")

    with pytest.raises(ConfigError) as caught:
        load_config(config_copy)

    assert any("max_runtime_minutes" in error for error in caught.value.errors)


def test_provider_none_is_not_checked(config_dir: Path) -> None:
    """A CPU-only installation runs LocalTrainingBackend and never reads that file."""
    load_config(config_dir)  # must not raise


# ── R34b: judge mode needs its rubric ───────────────────────────────────────

def test_judge_mode_without_the_rubric_file_fails_startup(config_copy: Path) -> None:
    """R34b grades every held-out sample against config/eval-rubric.md. The `config_copy`
    fixture copies only *.yaml, so the rubric is genuinely absent here."""
    set_key(config_copy / "eval.yaml", "mode", "judge")
    set_key(config_copy / "teacher.yaml", "enabled", "true")
    set_key(config_copy / "teacher.yaml", "provider", "local")

    with pytest.raises(ConfigError) as caught:
        load_config(config_copy)

    # The teacher IS enabled here, so edge 26 does not fire and the rubric is the only
    # fault. Asserting that keeps the test honest about what it proved.
    assert [error for error in caught.value.errors if "eval-rubric.md" in error]
    assert not any("enabled: false" in error for error in caught.value.errors)


def test_mechanical_mode_does_not_require_the_rubric(config_copy: Path) -> None:
    """A zero-cost installation must not be failed over a file it has no use for."""
    config = load_config(config_copy)
    assert config.eval_rubric == ""


# ── TeacherSettings: how config becomes a client ────────────────────────────

def test_a_local_teacher_takes_its_url_from_models_yaml(config_dir: Path) -> None:
    """The single source of truth for where armada-models lives."""
    config = load_config(config_dir)
    settings = TeacherSettings.from_config(
        {**config.teacher, "enabled": True, "provider": "local"}, config.models
    )
    assert settings.base_url == config.models["backends"]["ollama"]["base_url"]


def test_the_disabled_teacher_carries_no_endpoint(config_dir: Path) -> None:
    """`provider: none` resolves to an empty base_url, so even a caller that skipped the
    enabled check would have nowhere to connect."""
    config = load_config(config_dir)
    settings = TeacherSettings.from_config(config.teacher, config.models)
    assert settings.enabled is False
    assert settings.base_url == ""


def test_max_eval_samples_is_read_from_the_judge_block(config_dir: Path) -> None:
    """R34d — the hard bound on teacher spend per gate."""
    config = load_config(config_dir)
    assert TeacherSettings.from_config(config.teacher, config.models).max_eval_samples == 200
