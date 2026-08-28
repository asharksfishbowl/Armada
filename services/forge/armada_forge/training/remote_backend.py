"""RemoteTrainingBackend — Training R25, R27; edges 9, 10, 11.

NOT ON THE DEFAULT PATH. A CPU-only installation runs `LocalTrainingBackend` in smoke mode
and needs no account and no credential (invariant 7). This backend exists so that an
operator who HAS a GPU provider can produce a promotable Adapter, and it is reached only by
an explicit `POST /training/runs` with `backend: remote`.

INVARIANT 8, ENFORCED FIRST AND LOUDEST. `config/training-remote.yaml` names an environment
VARIABLE, never a value. `submit` reads that variable before it serialises anything, so
edge 9 is literal: an unset variable fails the submission immediately and THE DATASET IS
NEVER TRANSMITTED. A misconfiguration therefore cannot leak training data to a provider
that would have rejected the request anyway.

R27 — PROGRESS IS EVENT-DRIVEN. When `webhook_url` is set the provider posts updates and
`ingest_webhook` records them. Polling is the fallback for a provider that offers no
webhook, and even then the interval is the PROVIDER's recommendation, carried in its own
response — there is no arbitrary sleep anywhere in this file.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from armada_forge.training.backend import (
    JobStatus,
    TrainingBackend,
    TrainingConfig,
    TrainingConfigRejected,
)

# The provider's own vocabulary mapped onto R23's five states. An unrecognised state is
# treated as `running` rather than guessed at: inventing a terminal state from an unknown
# string would end a run that is still going.
_PROVIDER_STATES = {
    "queued": "queued",
    "pending": "queued",
    "starting": "running",
    "running": "running",
    "succeeded": "succeeded",
    "completed": "succeeded",
    "failed": "failed",
    "error": "failed",
    "cancelled": "cancelled",
    "canceled": "cancelled",
}

# Used only on the polling fallback (R27), and only as a guard: `_POLL_FLOOR` stops a
# provider answering `poll_after_seconds: 0` from turning the fallback into a spin loop,
# and `_POLL_DEFAULT` applies until the provider has stated a preference.
_POLL_FLOOR = 5.0
_POLL_DEFAULT = 15.0


@dataclass(frozen=True)
class RemoteSettings:
    provider: str
    endpoint: str
    api_key_env: str
    gpu_type: str
    max_runtime_minutes: int
    webhook_url: str
    defaults: dict[str, Any]

    @classmethod
    def from_config(cls, raw: dict[str, Any]) -> "RemoteSettings":
        return cls(
            provider=str(raw.get("provider", "none")),
            endpoint=str(raw.get("endpoint", "")),
            api_key_env=str(raw.get("api_key_env", "")),
            gpu_type=str(raw.get("gpu_type", "")),
            max_runtime_minutes=int(raw.get("max_runtime_minutes", 120)),
            webhook_url=str(raw.get("webhook_url") or ""),
            defaults=dict(raw.get("defaults") or {}),
        )


class RemoteTrainingBackend(TrainingBackend):
    """R25 — submit to the provider in config/training-remote.yaml."""

    run_kind = "quality"

    def __init__(self, settings: RemoteSettings, dataset_path_for: Any) -> None:
        self.settings = settings
        # Injected so `submit` can read the dataset file without importing the builder,
        # and so a test can supply a temp path without a database.
        self._dataset_path_for = dataset_path_for
        self._submitted_at: dict[str, float] = {}
        self._last_status: dict[str, JobStatus] = {}
        self._poll_after: dict[str, float] = {}

    # ── Credential ───────────────────────────────────────────────────────────

    def _api_key(self) -> str:
        """Edge 9 — read the value from the variable NAMED in config, or fail immediately.

        Called before the dataset is opened, which is what makes "never transmits the
        dataset" a property of the ordering rather than of a cleanup path.
        """
        if not self.settings.api_key_env:
            raise TrainingConfigRejected(
                "config/training-remote.yaml sets no `api_key_env`; a remote submission "
                "has no credential to read"
            )
        value = os.environ.get(self.settings.api_key_env)
        if not value:
            raise TrainingConfigRejected(
                f"the environment variable `{self.settings.api_key_env}` named by "
                f"config/training-remote.yaml is unset. The submission was refused before "
                f"the dataset was read, so nothing was transmitted."
            )
        return value

    # ── R21's four methods ───────────────────────────────────────────────────

    def submit(self, config: TrainingConfig) -> str:
        if self.settings.provider == "none":
            raise TrainingConfigRejected(
                "config/training-remote.yaml has `provider: none`. Set a provider before "
                "submitting with `backend: remote`, or use `backend: local`."
            )

        # ORDER MATTERS (edge 9): credential first, dataset second.
        key = self._api_key()

        dataset_path = Path(self._dataset_path_for(config.dataset_id))
        if not dataset_path.exists():
            raise TrainingConfigRejected(f"dataset file `{dataset_path}` is missing")

        payload = {
            **config.as_dict(),
            "gpu_type": self.settings.gpu_type,
            "max_runtime_minutes": self.settings.max_runtime_minutes,
            "dataset": dataset_path.read_text(encoding="utf-8"),
        }
        # R27 — the webhook is offered when configured; polling is the fallback, not the
        # default.
        if self.settings.webhook_url:
            payload["webhook_url"] = self.settings.webhook_url

        handle = self._post("/training/jobs", payload, key).get("id")
        if not handle:
            raise TrainingConfigRejected(
                f"provider `{self.settings.provider}` returned no job id"
            )
        self._submitted_at[str(handle)] = time.monotonic()
        return str(handle)

    def poll(self, handle: str) -> JobStatus:
        # Edge 10 — exceeding max_runtime_minutes cancels and records the reason. Checked
        # here rather than on a timer because `poll` is already the only place the run's
        # elapsed time is observed.
        started = self._submitted_at.get(handle)
        if started is not None and self.settings.max_runtime_minutes > 0:
            elapsed_minutes = (time.monotonic() - started) / 60
            if elapsed_minutes > self.settings.max_runtime_minutes:
                self.cancel(handle)
                return JobStatus(state="cancelled", message="exceeded max_runtime_minutes")

        try:
            body = self._get(f"/training/jobs/{handle}", self._api_key())
        except (TrainingConfigRejected, urllib.error.URLError) as exc:
            # An unreachable provider is not a failed job. Reporting the LAST KNOWN state
            # keeps a transient outage from terminating a run that is still going.
            last = self._last_status.get(handle)
            if last is not None:
                return JobStatus(
                    state=last.state,
                    progress_steps=last.progress_steps,
                    total_steps=last.total_steps,
                    message=f"provider unreachable: {exc}",
                )
            return JobStatus(state="queued", message=f"provider unreachable: {exc}")

        return self._status_from(handle, body)

    def _status_from(self, handle: str, body: dict[str, Any]) -> JobStatus:
        """Translate one provider response into a JobStatus and record what it implies.

        ONE translation for both `poll` and `ingest_webhook`. Written twice, the two drifted
        immediately: only the polled path recorded `poll_after_seconds`, so a provider that
        stated its interval over a webhook was still polled at the default.
        """
        status = JobStatus(
            state=_PROVIDER_STATES.get(str(body.get("status", "")).lower(), "running"),
            progress_steps=int(body.get("progress_steps", 0) or 0),
            total_steps=int(body.get("total_steps", 0) or 0),
            message=body.get("message"),
        )
        self._last_status[handle] = status

        # R27 — the provider's OWN recommendation for when to ask again. Recorded rather
        # than replaced by a constant, so the only number on the fallback path is one the
        # provider chose. `_POLL_FLOOR` is a guard against a provider answering 0, not an
        # invented interval.
        recommended = body.get("poll_after_seconds")
        if isinstance(recommended, (int, float)) and not isinstance(recommended, bool) and recommended > 0:
            self._poll_after[handle] = float(recommended)

        return status

    def poll_interval_seconds(self, handle: str) -> float:
        """The provider's recommended interval, floored.

        Used ONLY when `webhook_url` is unset. R27 is explicit that polling is the fallback
        and that its interval is provider-recommended; the floor exists so a provider
        answering `poll_after_seconds: 0` cannot turn the fallback into a spin loop.
        """
        return max(_POLL_FLOOR, self._poll_after.get(handle, _POLL_DEFAULT))

    def ingest_webhook(self, handle: str, body: dict[str, Any]) -> JobStatus:
        """R27 — apply a provider-pushed update. The event-driven path.

        Separate from `poll` so the two cannot be confused: `poll` asks, this is told. They
        share `_status_from` so what a response MEANS is defined once.
        """
        return self._status_from(handle, body)

    def fetch_artifacts(self, handle: str, dest: Path) -> None:
        key = self._api_key()
        body = self._get(f"/training/jobs/{handle}/artifacts", key)
        files = body.get("files") or {}
        if not files:
            raise FileNotFoundError(f"provider job `{handle}` reported no artifacts")

        dest.mkdir(parents=True, exist_ok=True)
        for name, contents in files.items():
            # The provider names these; a name is not allowed to escape `dest`.
            target = (dest / name).resolve()
            if dest.resolve() not in target.parents:
                raise ValueError(f"provider artifact name `{name}` escapes {dest}")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(str(contents), encoding="utf-8")

    def cancel(self, handle: str) -> None:
        try:
            self._post(f"/training/jobs/{handle}/cancel", {}, self._api_key())
        except Exception:  # noqa: BLE001 - a cancel we could not deliver is still a cancel
            # The run is recorded `cancelled` locally regardless. A provider that cannot be
            # told is a billing problem for the operator, not a reason to keep a run alive
            # in our own state.
            pass

    # ── Transport ────────────────────────────────────────────────────────────

    def _request(self, method: str, path: str, key: str, body: dict[str, Any] | None) -> dict[str, Any]:
        request = urllib.request.Request(
            f"{self.settings.endpoint.rstrip('/')}{path}",
            method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
        )
        with urllib.request.urlopen(request, timeout=120) as response:
            raw = response.read()
        return json.loads(raw) if raw else {}

    def _post(self, path: str, body: dict[str, Any], key: str) -> dict[str, Any]:
        return self._request("POST", path, key, body)

    def _get(self, path: str, key: str) -> dict[str, Any]:
        return self._request("GET", path, key, None)
