"""Adapter export and promotion — Training R30, R31; edges 13, 14, 16.

WHAT PROMOTION IS: merge the LoRA into the base weights, convert to GGUF, quantize with the
BaseModel's `quantization`, register the result with `armada-models` under
`armada/{base_model_id}-{corpus_name}-v{version}`, and only then set the Adapter
`status: promoted`. R30 makes the last step the gate on everything downstream — an Adapter
whose status is not `promoted` must not be registered with the model server, and the daemon
binds nothing else.

THE TAG COMES FROM THE `adapters` ROW, NOT FROM THE DATASET (R31, edge 16). `corpus_name`
and `version` are recorded on the Adapter at creation, so a Corpus deleted afterwards
leaves the tag intact and the model keeps serving. That is why `adapters.corpus_name` is
text rather than a foreign key.

TWO FAILURE MODES, DELIBERATELY DIFFERENT OUTCOMES:

  edge 13  GGUF conversion or quantization fails AFTER a passing evaluation → the Adapter
           is `rejected` with the conversion error and NO ModelBinding is registered. The
           artifact cannot be produced, so no amount of retrying the same inputs will help.
  edge 14  `armada-models` is unreachable at registration time → promotion fails, the
           Adapter is left `pending_eval`, and the operator retries with
           `POST /adapters/{adapter_id}/promote`. The artifact is fine; the environment is
           not.

TOOLING IS NOT BUNDLED. The merge/convert/quantize chain shells out to llama.cpp's
`convert_hf_to_gguf.py` and `llama-quantize`, located through two environment variables.
When they are absent this raises `ExportToolingMissing` naming both the variable and the
path it looked at, which surfaces through edge 13's path as a `rejected` Adapter carrying
an actionable message. It cannot silently register an unconverted artifact.
"""

from __future__ import annotations

import json
import os
import subprocess
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

# Located by environment variable so an operator can point at their own llama.cpp checkout
# without rebuilding the image. The defaults are where the Dockerfile would place them.
GGUF_CONVERT = Path(os.environ.get("ARMADA_GGUF_CONVERT", "/opt/llama.cpp/convert_hf_to_gguf.py"))
LLAMA_QUANTIZE = Path(os.environ.get("ARMADA_LLAMA_QUANTIZE", "/opt/llama.cpp/llama-quantize"))

ADAPTERS_ROOT = Path(os.environ.get("ARMADA_ADAPTERS_ROOT", "/data/adapters"))


class ExportError(Exception):
    """Edge 13 — the artifact could not be produced. The Adapter is REJECTED."""


class ExportToolingMissing(ExportError):
    """A subclass so the message can name the variable, while the outcome stays edge 13's.

    Rejecting rather than leaving `pending_eval` is the correct outcome even though the
    cause is environmental: a retry against the same image will fail identically, and
    leaving the Adapter retryable would invite an operator to keep pressing a button that
    cannot work.
    """


class RegistrationUnreachable(Exception):
    """Edge 14 — the artifact is fine and the model server is not.

    NOT an ExportError, and the difference is the whole point: this leaves the Adapter at
    `pending_eval` so `POST /adapters/{adapter_id}/promote` can retry it.
    """


def binding_tag(base_model_id: str, corpus_name: str, version: int) -> str:
    """R31 — `armada/{base_model_id}-{corpus_name}-v{version}`."""
    return f"armada/{base_model_id}-{corpus_name}-v{version}"


def _require_tooling() -> None:
    missing = []
    if not GGUF_CONVERT.exists():
        missing.append(
            f"ARMADA_GGUF_CONVERT points at `{GGUF_CONVERT}`, which does not exist"
        )
    if not LLAMA_QUANTIZE.exists():
        missing.append(
            f"ARMADA_LLAMA_QUANTIZE points at `{LLAMA_QUANTIZE}`, which does not exist"
        )
    if missing:
        raise ExportToolingMissing(
            "GGUF export tooling is not available in this image: "
            + "; ".join(missing)
            + ". Promotion converts and quantizes before registering (R31), so it cannot "
            "proceed. The smoke path is unaffected — a smoke Adapter is rejected before "
            "evaluation and never reaches export."
        )


def _run(command: list[str], step: str) -> None:
    try:
        completed = subprocess.run(command, capture_output=True, text=True, check=False)
    except OSError as exc:
        raise ExportError(f"{step} could not be started: {exc}") from exc
    if completed.returncode != 0:
        # The tail rather than the whole log: llama.cpp is verbose and the actionable line
        # is at the end, while the full output would bury it in a database column.
        tail = (completed.stderr or completed.stdout or "").strip().splitlines()[-10:]
        raise ExportError(f"{step} failed (exit {completed.returncode}): " + " | ".join(tail))


def merge_convert_quantize(
    hf_id: str, adapter_path: Path, quantization: str, work_dir: Path
) -> Path:
    """R31 — merge, convert to GGUF, quantize. Returns the quantized file.

    Merging happens in-process through PEFT because that is the only step with no CLI, and
    the two conversion steps shell out because llama.cpp owns them. The import is local so
    this module stays importable without torch.
    """
    _require_tooling()

    merged_dir = work_dir / "merged"
    work_dir.mkdir(parents=True, exist_ok=True)

    try:
        from peft import PeftModel  # type: ignore[import-not-found]
        from transformers import AutoModelForCausalLM, AutoTokenizer  # type: ignore[import-not-found]

        base = AutoModelForCausalLM.from_pretrained(hf_id)
        merged = PeftModel.from_pretrained(base, str(adapter_path)).merge_and_unload()
        merged.save_pretrained(str(merged_dir))
        AutoTokenizer.from_pretrained(hf_id).save_pretrained(str(merged_dir))
    except ExportError:
        raise
    except Exception as exc:  # noqa: BLE001 - any merge failure is edge 13
        raise ExportError(f"adapter merge failed: {type(exc).__name__}: {exc}") from exc

    unquantized = work_dir / "model-f16.gguf"
    _run(
        ["python", str(GGUF_CONVERT), str(merged_dir), "--outfile", str(unquantized), "--outtype", "f16"],
        "GGUF conversion",
    )

    quantized = work_dir / f"model-{quantization}.gguf"
    _run(
        [str(LLAMA_QUANTIZE), str(unquantized), str(quantized), quantization],
        f"quantization to {quantization}",
    )

    if not quantized.exists():
        raise ExportError(f"quantization to {quantization} produced no file at {quantized}")
    return quantized


def register_with_model_server(base_url: str, tag: str, gguf_path: Path) -> None:
    """R31 — make the quantized model addressable under `tag`.

    Raises RegistrationUnreachable, never ExportError: a model server that is down is
    edge 14, and the Adapter must be left retryable rather than rejected.
    """
    body = json.dumps({
        "model": tag,
        "files": {gguf_path.name: str(gguf_path)},
        "from": str(gguf_path),
    }).encode()
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/api/create",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=3600) as response:
            response.read()
    except urllib.error.URLError as exc:
        raise RegistrationUnreachable(
            f"armada-models at `{base_url}` is unreachable, so `{tag}` was not registered. "
            "The Adapter is left at pending_eval; retry with "
            "POST /adapters/{adapter_id}/promote once the model server is back."
        ) from exc
    except Exception as exc:  # noqa: BLE001 - any registration failure is retryable
        raise RegistrationUnreachable(
            f"registering `{tag}` with armada-models at `{base_url}` failed: "
            f"{type(exc).__name__}: {exc}"
        ) from exc


def record_binding(tag: str, adapter: dict[str, Any], context_window: int, tool_format: str, backend: str) -> None:
    """R32 — the ModelBinding row the daemon reads.

    Written only AFTER registration succeeded. A row claiming a tag the model server does
    not have is exactly the stale state R4h exists to clean up, and writing one here would
    manufacture it deliberately.
    """
    from armada_forge import db

    db.execute(
        """
        INSERT INTO model_bindings (
            tag, backend, base_model_id, corpus_name, adapter_id, version,
            context_window, tool_format, status, materialized, materialization_status
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'promoted', true, 'present')
        ON CONFLICT (tag) DO UPDATE SET
            status = 'promoted',
            materialized = true,
            materialization_status = 'present',
            updated_at = now()
        """,
        (
            tag,
            backend,
            adapter["base_model_id"],
            adapter["corpus_name"],
            adapter["adapter_id"],
            adapter["version"],
            context_window,
            tool_format,
        ),
    )
