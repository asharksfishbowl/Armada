"""Materialization — Training R4e, R4f; build-plan Req 4, 15, 16, 24, 26.

`POST /models/bindings/{tag}/materialize` transfers a registered binding's weights and
makes it servable. It is owned by forge because cross-service boundary 2 gives forge
responsibility for registering ModelBindings with the model server.

IT SHIPS AHEAD OF ITS UI ON PURPOSE (build-plan Req 5). P7's fail-fast will refuse a Run
against an unmaterialized binding; without this endpoint the operator would be told about a
state they had no way to exit until the dashboard lands in P9. Being curl-operable for a
few phases is the lesser problem.

CAPACITY IS ENFORCED BEFORE ANY TRANSFER (R4f). A refusal names BOTH the required and the
observed value for whichever limit was hit, because "not enough memory" is not actionable
and "needs 6 GB, host has 2.1 GB available" is.
"""

from __future__ import annotations

import asyncio
import shutil
import threading
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, HTTPException

from armada_forge import db
from armada_forge.progress import hub
from armada_forge.registry import base_bindings, models

router = APIRouter()

BYTES_PER_GB = 1024**3

# Where the model server keeps weights. Free space here is what min_disk_gb gates on.
MODELS_DATA_PATH = "/data"

_loop: asyncio.AbstractEventLoop | None = None
_entries: dict[str, models.ShortlistEntry] = {}
_client: "ModelServerClient | None" = None


def configure(
    loop: asyncio.AbstractEventLoop,
    entries: list[models.ShortlistEntry],
    client: "ModelServerClient",
) -> None:
    global _loop, _client
    _loop = loop
    _client = client
    _entries.clear()
    _entries.update({entry.id: entry for entry in entries})


@dataclass(frozen=True)
class Capacity:
    ram_available_gb: float
    disk_free_gb: float


def host_capacity() -> Capacity:
    """Observed host capacity.

    Reads MemAvailable rather than MemTotal: what matters is whether the model can be
    loaded now, not whether the machine theoretically has that much RAM. MemAvailable is
    the kernel's own estimate of what is obtainable without swapping.
    """
    available_kb = 0
    try:
        with open("/proc/meminfo", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("MemAvailable:"):
                    available_kb = int(line.split()[1])
                    break
    except OSError:
        available_kb = 0

    try:
        disk_free = shutil.disk_usage(MODELS_DATA_PATH).free
    except OSError:
        disk_free = 0

    return Capacity(
        ram_available_gb=available_kb * 1024 / BYTES_PER_GB,
        disk_free_gb=disk_free / BYTES_PER_GB,
    )


def check_capacity(entry: models.ShortlistEntry, capacity: Capacity) -> str | None:
    """R4f — return a refusal message naming BOTH values, or None when there is room."""
    if capacity.ram_available_gb < entry.min_ram_gb:
        return (
            f"insufficient memory to materialize `{entry.id}`: "
            f"requires min_ram_gb {entry.min_ram_gb}, "
            f"host has {capacity.ram_available_gb:.1f} GB available"
        )
    if entry.min_disk_gb and capacity.disk_free_gb < entry.min_disk_gb:
        return (
            f"insufficient disk to materialize `{entry.id}`: "
            f"requires min_disk_gb {entry.min_disk_gb}, "
            f"host has {capacity.disk_free_gb:.1f} GB free"
        )
    return None


class ModelServerClient:
    """The armada-models surface forge needs. Injected so it can be stubbed in tests."""

    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")

    def list_served(self) -> set[str] | None:
        """Serving refs the model server currently has, or None if unreachable.

        None is deliberately distinct from an empty set: "cannot ask" must not be read as
        "has nothing", or R4h would demote every binding whenever the server restarts.
        """
        import urllib.error
        import urllib.request
        import json

        try:
            with urllib.request.urlopen(f"{self.base_url}/api/tags", timeout=10) as response:
                payload = json.loads(response.read())
        except Exception:  # noqa: BLE001 - unreachable for any reason is still unreachable
            return None

        return {model.get("name", "") for model in payload.get("models", [])}

    def pull(self, serving_ref: str, on_progress) -> None:
        """Transfer weights. Streams progress lines so the caller can report them."""
        import json
        import urllib.request

        request = urllib.request.Request(
            f"{self.base_url}/api/pull",
            data=json.dumps({"model": serving_ref}).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=3600) as response:
            for raw_line in response:
                line = raw_line.decode().strip()
                if not line:
                    continue
                try:
                    on_progress(json.loads(line))
                except json.JSONDecodeError:
                    continue


def _emit(message: dict[str, Any]) -> None:
    if _loop is not None:
        hub.broadcast_threadsafe(_loop, message)


def _run_materialization(tag: str, entry: models.ShortlistEntry) -> None:
    """Transfer weights in a worker thread and record the outcome."""
    assert _client is not None

    db.execute(
        """
        UPDATE model_bindings
           SET materialization_status = 'materializing', materialization_error = NULL,
               updated_at = now()
         WHERE tag = %s
        """,
        (tag,),
    )
    _emit({"channel": "job", "job_kind": "materialization", "tag": tag, "status": "materializing"})

    try:
        def on_progress(frame: dict[str, Any]) -> None:
            # Req 24/26 — progress rides the forge channel built in P1.
            _emit({
                "channel": "job",
                "job_kind": "materialization",
                "tag": tag,
                "status": "materializing",
                "detail": frame.get("status"),
                "completed": frame.get("completed"),
                "total": frame.get("total"),
            })

        _client.pull(entry.serving_ref, on_progress)

    except Exception as exc:  # noqa: BLE001 - any transfer failure is a failed materialization
        base_bindings.mark_materialized(tag, False, error=f"{type(exc).__name__}: {exc}")
        _emit({
            "channel": "job", "job_kind": "materialization", "tag": tag,
            "status": "failed", "error": str(exc),
        })
        return

    # Confirm the server actually has it rather than trusting the transfer returned. This
    # is the same distrust R4h encodes, applied at the moment the claim is first made.
    served = _client.list_served()
    present = served is not None and entry.serving_ref in served
    base_bindings.mark_materialized(
        tag, present, None if present else "transfer completed but the model server does not report the model"
    )
    _emit({
        "channel": "job", "job_kind": "materialization", "tag": tag,
        "status": "present" if present else "failed",
    })


@router.post("/models/bindings/{tag:path}/materialize", status_code=202)
def materialize(tag: str) -> dict[str, Any]:
    """R4e — start a transfer. Returns BEFORE it completes."""
    binding = models.get_binding(tag)
    if binding is None:
        raise HTTPException(status_code=404, detail=f"no ModelBinding with tag `{tag}`")

    if binding["status"] == "retired":
        raise HTTPException(
            status_code=409,
            detail=f"binding `{tag}` is retired; it cannot be materialized",
        )

    entry = _entries.get(binding["base_model_id"])
    if entry is None:
        raise HTTPException(
            status_code=409,
            detail=(
                f"`{binding['base_model_id']}` is no longer in config/base-models.yaml, "
                "so its serving reference is unknown"
            ),
        )

    if binding["materialized"]:
        # Already present. Idempotent rather than an error — an operator retrying should
        # not have to distinguish "already done" from "failed".
        return {"tag": tag, "status": "present", "already_materialized": True}

    if binding["materialization_status"] == "materializing":
        raise HTTPException(status_code=409, detail=f"`{tag}` is already materializing")

    # R4f — REFUSE BEFORE TRANSFERRING. Checking afterwards would mean discovering the host
    # is too small only after spending the bandwidth.
    refusal = check_capacity(entry, host_capacity())
    if refusal:
        db.execute(
            """
            UPDATE model_bindings
               SET materialization_status = 'failed', materialization_error = %s,
                   updated_at = now()
             WHERE tag = %s
            """,
            (refusal, tag),
        )
        raise HTTPException(status_code=507, detail=refusal)

    db.execute(
        "UPDATE model_bindings SET materialization_status = 'pending', updated_at = now() WHERE tag = %s",
        (tag,),
    )

    threading.Thread(
        target=_run_materialization,
        args=(tag, entry),
        name=f"materialize-{entry.id}",
        daemon=True,
    ).start()

    return {"tag": tag, "status": "pending"}


@router.get("/models/bindings")
def get_bindings() -> list[dict[str, Any]]:
    """R32 — what the daemon reads at Agent save time and at Run start."""
    return models.list_bindings()
