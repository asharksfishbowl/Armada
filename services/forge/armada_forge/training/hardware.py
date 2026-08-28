"""CUDA detection and smoke/quality mode selection — Training R24, R24c; edge 27.

ONE DETECTION FUNCTION FOR THE WHOLE SERVICE. `GET /config/capabilities` reports
`local_backend_mode` and `LocalTrainingBackend` enforces it, and those two must never be
able to disagree: a dashboard that offers a quality run the backend will refuse is worse
than one that offers nothing.

MODE IS NEVER OPERATOR-SELECTABLE (R24c). There is deliberately no config key, no
environment override, and no request field. Requesting a non-smoke model while no CUDA
device is present is an ERROR, not a silent downgrade (edge 26) — a caller who was quietly
given the 0.6B model would believe they had trained the 4B one they asked for.

Edge 27 falls out of this for free: add a GPU, restart forge, and the same function returns
`quality` with no configuration change. Runs already recorded `run_kind: smoke` keep it and
stay unpromotable, because `run_kind` is persisted per run rather than re-derived.
"""

from __future__ import annotations

SMOKE = "smoke"
QUALITY = "quality"


def cuda_available() -> bool:
    """True when torch reports a usable CUDA device.

    The import is guarded because a CPU-only image is a supported configuration, not a
    broken one: a missing torch must report "no GPU" rather than raise out of a capabilities
    endpoint.
    """
    try:
        import torch
    except ImportError:
        return False

    try:
        return bool(torch.cuda.is_available())
    except Exception:  # noqa: BLE001 - a driver that fails to probe is a driver we cannot use
        return False


def detect_mode() -> str:
    """R24 — `quality` when a CUDA device is present, `smoke` otherwise."""
    return QUALITY if cuda_available() else SMOKE
