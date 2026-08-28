"""Teacher model client — Training R16, R16b, R16c, R34b; invariant 7, invariant 8.

THE ONLY MODULE IN armada-forge THAT CAN CONTACT A PAID ENDPOINT, and only when
`config/teacher.yaml` sets `enabled: true` with `provider: remote`. Two properties are
enforced here rather than assumed:

  1. `enabled: false` makes every call site raise BEFORE opening a socket (R16b, edge 22).
     The blocked-egress acceptance criterion is that no outbound connection is *attempted*,
     which a check performed after building a request would not satisfy.
  2. The credential is read from the environment variable NAMED by `api_key_env`, never
     from a file in this repository (invariant 8, R25). An unset variable fails the call
     immediately and transmits nothing.

`provider: local` targets armada-models through the backend map in `config/models.yaml`,
costs nothing beyond CPU time, and is expected to be slow (R16c). It is resolved by NAME
rather than by URL so that moving armada-models stays a change to models.yaml alone.

NOTE ON THE EVALUATION GATE. Judge mode calls this module; MECHANICAL MODE NEVER DOES.
Build-plan Requirement 31 puts generation and scoring in-process, so the default gate has
no teacher dependency at all and therefore no incomplete outcome (R35).
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


class TeacherDisabled(Exception):
    """Raised when a teacher call is attempted while `enabled: false`.

    Raised BEFORE any network work. This is the exception the dataset route turns into
    R16b's HTTP 400 naming the two teacher-free sources.
    """


class TeacherUnreachable(Exception):
    """The teacher was configured and enabled, and could not be reached.

    Distinct from TeacherDisabled on purpose. Edge 5 fails a dataset build on this; edge 19
    leaves an Adapter at `pending_eval` rather than rejecting it, because an absent
    judgement is not a failing judgement (R35).
    """


class TeacherCredentialMissing(TeacherUnreachable):
    """Edge 9's shape, applied to the teacher: the named variable is unset.

    A subclass of TeacherUnreachable so callers that only care "no judgement was obtained"
    need no extra branch, while an operator still gets a message naming the variable.
    """


@dataclass(frozen=True)
class TeacherSettings:
    """The resolved teacher, or a disabled one. Built once at startup from config."""

    enabled: bool
    provider: str
    base_url: str
    model: str
    api_key_env: str
    request_timeout_seconds: int
    max_eval_samples: int

    @classmethod
    def from_config(
        cls, teacher: dict[str, Any], models_config: dict[str, Any]
    ) -> "TeacherSettings":
        endpoint = teacher.get("endpoint") or {}
        provider = teacher.get("provider", "none")

        base_url = ""
        api_key_env = ""
        timeout = int(endpoint.get("request_timeout_seconds", 120) or 120)

        if provider == "local":
            # Resolved through config/models.yaml BY NAME. Duplicating the base URL into
            # teacher.yaml is what that file's own comment warns against: an operator who
            # moved armada-models would edit models.yaml and this copy would keep pointing
            # at the old host, failing much later during distillation or a judge gate.
            backend_name = endpoint.get("backend", "ollama")
            backend = (models_config.get("backends") or {}).get(backend_name) or {}
            base_url = str(backend.get("base_url", ""))
            api_key_env = str(backend.get("api_key_env", ""))
            timeout = int(backend.get("request_timeout_seconds", timeout) or timeout)
        elif provider == "remote":
            base_url = str(endpoint.get("base_url", ""))
            api_key_env = str(endpoint.get("api_key_env", ""))

        return cls(
            enabled=bool(teacher.get("enabled", False)),
            provider=provider,
            base_url=base_url,
            model=str(endpoint.get("model", "")),
            api_key_env=api_key_env,
            request_timeout_seconds=timeout,
            max_eval_samples=int((teacher.get("judge") or {}).get("max_eval_samples", 200)),
        )


class TeacherClient:
    """One OpenAI-compatible chat completion call, and nothing else.

    Deliberately thin and built on `urllib`: adding an SDK for a code path that is disabled
    by default would put a dependency in the image for a feature a default installation
    never reaches.
    """

    def __init__(self, settings: TeacherSettings) -> None:
        self.settings = settings

    def require_enabled(self) -> None:
        """Raise TeacherDisabled unless a teacher is actually configured.

        PUBLIC, and called by `datasets/builder.py` BEFORE it collects anything. R16b
        rejects a `corpus_id` because the teacher is disabled, and that must not depend on
        the Corpus having chunks: an empty Corpus would otherwise distil zero samples,
        return quietly, and the refusal would never fire.
        """
        if not self.settings.enabled or self.settings.provider == "none":
            raise TeacherDisabled(
                "config/teacher.yaml has `enabled: false`, so no teacher call is possible. "
                "The teacher-free dataset sources are `supplied_file` and "
                "`include_trajectories`; the teacher-free evaluation gate is "
                "`mode: mechanical` in config/eval.yaml."
            )

    def _api_key(self) -> str:
        """Invariant 8 — read the value from the environment variable NAMED in config."""
        if not self.settings.api_key_env:
            return ""
        value = os.environ.get(self.settings.api_key_env)
        if not value:
            raise TeacherCredentialMissing(
                f"the environment variable `{self.settings.api_key_env}` named by "
                "config/teacher.yaml is unset; no request was made and no data was "
                "transmitted"
            )
        return value

    def complete(self, messages: list[dict[str, str]], temperature: float = 0.0) -> str:
        """Return the assistant message content, or raise.

        `require_enabled` runs FIRST, before the credential lookup and before the request
        is built, so a disabled teacher costs zero syscalls.
        """
        self.require_enabled()

        # `local` points inside the Compose network and its key is ignored by Ollama, but
        # the header still has to exist for OpenAI-compatible clients.
        key = self._api_key() if self.settings.provider == "remote" else (
            os.environ.get(self.settings.api_key_env, "unused") if self.settings.api_key_env else "unused"
        )

        body = json.dumps({
            "model": self.settings.model,
            "messages": messages,
            "temperature": temperature,
        }).encode()

        request = urllib.request.Request(
            f"{self.settings.base_url.rstrip('/')}/chat/completions",
            data=body,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
        )

        try:
            with urllib.request.urlopen(request, timeout=self.settings.request_timeout_seconds) as response:
                payload = json.loads(response.read())
        except urllib.error.URLError as exc:
            # Edge 5 / edge 19 both need the ENDPOINT named in the error, because the two
            # likely causes — wrong URL and a provider outage — are indistinguishable
            # without it.
            raise TeacherUnreachable(
                f"teacher endpoint `{self.settings.base_url}` is unreachable: {exc}"
            ) from exc
        except Exception as exc:  # noqa: BLE001 - any failure to obtain a completion
            raise TeacherUnreachable(
                f"teacher endpoint `{self.settings.base_url}` failed: {type(exc).__name__}: {exc}"
            ) from exc

        choices = payload.get("choices") or []
        if not choices:
            raise TeacherUnreachable(
                f"teacher endpoint `{self.settings.base_url}` returned no choices"
            )
        return str((choices[0].get("message") or {}).get("content", ""))
