"""Startup configuration loading and validation for armada-forge.

Every check here FAILS STARTUP with a non-zero exit rather than deferring to first use.
That is deliberate and is spec'd twice:

  * Training R3   — an invalid `config/base-models.yaml` entry exits non-zero naming the
                    offending `id`.
  * Training edge 26 — `eval.mode: judge` against `teacher.enabled: false` fails at
                    STARTUP naming both settings, "rather than deferring the failure to
                    the first promotion attempt".

The shared reasoning: a misconfiguration that surfaces at first promotion surfaces after a
training run has already been paid for in wall-clock time. Failing at boot costs seconds.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

CONFIG_DIR = Path("/config")

# Training R1 — the required key set for a shortlist entry. Validated on EVERY entry,
# including operator-appended ones (R3).
BASE_MODEL_REQUIRED_KEYS: frozenset[str] = frozenset(
    {
        "id",
        "hf_id",
        "serving_ref",
        "context_window",
        "chat_template",
        "tool_format",
        "quantization",
        "min_ram_gb",
        "trainable",
        "lora_target_modules",
        "smoke_test",
    }
)

# R1 — `backend` carries a default, so its absence is legal and means `ollama`. It is
# still a known key, so it must be listed here or the unknown-key check would reject it.
BASE_MODEL_OPTIONAL_KEYS: frozenset[str] = frozenset({"backend"})

BASE_MODEL_KNOWN_KEYS: frozenset[str] = BASE_MODEL_REQUIRED_KEYS | BASE_MODEL_OPTIONAL_KEYS

DEFAULT_BACKEND = "ollama"

# R1b — `ollama` is the ONLY accepted value in this spec. The discriminator exists ahead
# of any second inference server because retrofitting one into a populated
# `model_bindings` table behind a live GET /models/bindings contract is expensive, while
# defaulting a column on empty tables is not (R1c). It commits to nothing about a second
# backend — so an unrecognised value is REJECTED rather than passed through as a
# forward-compatible unknown.
VALID_BACKENDS: frozenset[str] = frozenset({DEFAULT_BACKEND})

VALID_CHAT_TEMPLATES: frozenset[str] = frozenset({"qwen3", "llama3", "gemma3"})
VALID_TOOL_FORMATS: frozenset[str] = frozenset({"json_schema", "hermes"})
VALID_EVAL_MODES: frozenset[str] = frozenset({"mechanical", "judge"})
VALID_TEACHER_PROVIDERS: frozenset[str] = frozenset({"none", "local", "remote"})


class ConfigError(Exception):
    """A startup-fatal configuration fault.

    Carries every problem found rather than the first, so an operator fixing a config file
    sees the whole list in one boot instead of one error per restart.
    """

    def __init__(self, errors: list[str]) -> None:
        self.errors = errors
        super().__init__("\n".join(errors))


@dataclass(frozen=True)
class ArmadaConfig:
    base_models: list[dict[str, Any]]
    teacher: dict[str, Any]
    eval_config: dict[str, Any]
    seed_corpora: list[dict[str, Any]]
    code_extensions: list[str]


def _check_choice(
    errors: list[str],
    where: str,
    field: str,
    value: Any,
    valid: frozenset[str],
) -> None:
    """Record an error when `value` is outside `valid`.

    Five settings across two files are constrained to a fixed set, and every one of them
    needs the same message shape: what was given, and what was allowed. Writing it once
    keeps those messages identical, which matters because they are the operator's only
    signal when startup refuses to proceed.
    """
    if value not in valid:
        errors.append(
            f"{where}: `{field}` is `{value}`; expected one of "
            f"{', '.join(sorted(valid))}"
        )


def _load_yaml(path: Path, errors: list[str]) -> dict[str, Any] | None:
    if not path.exists():
        errors.append(f"{path}: missing required config file")
        return None
    try:
        loaded = yaml.safe_load(path.read_text()) or {}
    except yaml.YAMLError as exc:
        errors.append(f"{path}: invalid YAML: {exc}")
        return None
    if not isinstance(loaded, dict):
        errors.append(f"{path}: expected a mapping at the top level")
        return None
    return loaded


def _validate_base_models(raw: dict[str, Any], errors: list[str]) -> list[dict[str, Any]]:
    """Training R1, R2, R3.

    Each entry is validated independently so one bad entry does not mask the next.
    """
    entries = raw.get("models")
    if not isinstance(entries, list) or not entries:
        errors.append("config/base-models.yaml: `models` must be a non-empty list")
        return []

    seen_ids: set[str] = set()
    smoke_ids: list[str] = []
    valid_entries: list[dict[str, Any]] = []

    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            errors.append(f"config/base-models.yaml: entry {index} is not a mapping")
            continue
        valid_entries.append(entry)

        # R3 requires the offending `id` in the message. When `id` itself is what is
        # missing, fall back to the positional index so the error still points somewhere.
        raw_id = entry.get("id")
        entry_id = raw_id if isinstance(raw_id, str) and raw_id else None
        label = entry_id or f"<entry {index}, no id>"

        missing = BASE_MODEL_REQUIRED_KEYS - entry.keys()
        if missing:
            errors.append(
                f"config/base-models.yaml: entry `{label}` is missing required "
                f"key(s): {', '.join(sorted(missing))}"
            )

        unknown = entry.keys() - BASE_MODEL_KNOWN_KEYS
        if unknown:
            errors.append(
                f"config/base-models.yaml: entry `{label}` has unknown "
                f"key(s): {', '.join(sorted(unknown))}"
            )

        where = f"config/base-models.yaml: entry `{label}`"

        # R1b — reject an unrecognised backend rather than accepting it optimistically.
        # A shortlist entry naming a backend nothing can serve would otherwise register a
        # ModelBinding at startup (R4a) that fails only when an Agent tries to run against
        # it, which is exactly the deferred failure this file exists to prevent.
        _check_choice(errors, where, "backend", entry.get("backend", DEFAULT_BACKEND), VALID_BACKENDS)

        if entry_id:
            if entry_id in seen_ids:
                # `id` is embedded in every ModelBinding tag (R4a), so a duplicate would
                # make two different models share one tag.
                errors.append(f"config/base-models.yaml: duplicate id `{entry_id}`")
            seen_ids.add(entry_id)

        # Only check a value that is present; a missing key is already reported above as
        # missing, and reporting it twice would bury the actionable message.
        if "chat_template" in entry:
            _check_choice(errors, where, "chat_template", entry["chat_template"], VALID_CHAT_TEMPLATES)
        if "tool_format" in entry:
            _check_choice(errors, where, "tool_format", entry["tool_format"], VALID_TOOL_FORMATS)

        if entry.get("smoke_test") is True:
            smoke_ids.append(str(entry_id))

    # R2 — EXACTLY one. Zero means LocalTrainingBackend can train nothing in smoke mode,
    # which is the default mode on the CPU-only target host; more than one makes the
    # choice ambiguous.
    if len(smoke_ids) != 1:
        errors.append(
            "config/base-models.yaml: exactly one entry must have `smoke_test: true`, "
            f"found {len(smoke_ids)}"
            + (f" ({', '.join(smoke_ids)})" if smoke_ids else "")
        )

    return valid_entries


def _validate_teacher_and_eval(
    teacher: dict[str, Any], eval_config: dict[str, Any], errors: list[str]
) -> None:
    """Training R34b and edge 26 — the zero-spend cross-check.

    This is the single most load-bearing validation in the file. `mode: judge` issues one
    teacher call per held-out sample; with no teacher enabled that gate can never run. The
    spec is explicit that this fails at startup naming BOTH settings.
    """
    enabled = teacher.get("enabled")
    if not isinstance(enabled, bool):
        errors.append("config/teacher.yaml: `enabled` must be a boolean")
        enabled = False

    provider = teacher.get("provider")
    _check_choice(errors, "config/teacher.yaml", "provider", provider, VALID_TEACHER_PROVIDERS)

    mode = eval_config.get("mode")
    _check_choice(errors, "config/eval.yaml", "mode", mode, VALID_EVAL_MODES)

    if mode == "judge" and not enabled:
        errors.append(
            "config/eval.yaml sets `mode: judge` but config/teacher.yaml sets "
            "`enabled: false`. Judge mode issues one teacher call per held-out sample "
            "and cannot run without a teacher. Either set teacher.enabled: true "
            "(note: provider `remote` incurs external spend) or set eval.mode: mechanical."
        )

    # A teacher that is on but pointed at nothing is the other half of the same mistake.
    if enabled and provider == "none":
        errors.append(
            "config/teacher.yaml sets `enabled: true` with `provider: none`. "
            "Set provider to `local` (free, CPU-bound) or `remote` (incurs spend)."
        )


def load_config(config_dir: Path = CONFIG_DIR) -> ArmadaConfig:
    """Load and validate every startup-critical config file.

    Raises ConfigError carrying ALL problems found.
    """
    errors: list[str] = []

    base_models_raw = _load_yaml(config_dir / "base-models.yaml", errors)
    teacher_raw = _load_yaml(config_dir / "teacher.yaml", errors)
    eval_raw = _load_yaml(config_dir / "eval.yaml", errors)
    seed_raw = _load_yaml(config_dir / "seed-corpora.yaml", errors)
    extensions_raw = _load_yaml(config_dir / "code-extensions.yaml", errors)

    # Each of these runs only when its file parsed; a file that did not parse already
    # recorded an error, and the raise below is unconditional on any error at all.
    base_models = _validate_base_models(base_models_raw, errors) if base_models_raw else []
    if teacher_raw and eval_raw:
        _validate_teacher_and_eval(teacher_raw, eval_raw, errors)

    if errors:
        raise ConfigError(errors)

    # Past the raise, every _load_yaml returned a mapping — it returns None only on paths
    # that append an error. The assert narrows the types for the reader and the checker.
    assert teacher_raw is not None and eval_raw is not None
    assert seed_raw is not None and extensions_raw is not None
    return ArmadaConfig(
        base_models=base_models,
        teacher=teacher_raw,
        eval_config=eval_raw,
        seed_corpora=seed_raw.get("corpora", []),
        code_extensions=extensions_raw.get("extensions", []),
    )


def load_config_or_exit(config_dir: Path = CONFIG_DIR) -> ArmadaConfig:
    """Load config, or print every error and exit non-zero.

    Called from the FastAPI lifespan startup hook. Exiting here rather than raising means
    the container fails its healthcheck and Compose reports the failure, instead of the
    service staying up in a state where every request would fail.
    """
    try:
        return load_config(config_dir)
    except ConfigError as exc:
        print("\n🛑 armada-forge: configuration invalid, refusing to start\n", file=sys.stderr)
        for error in exc.errors:
            print(f"  - {error}", file=sys.stderr)
        print("", file=sys.stderr)
        sys.exit(1)
