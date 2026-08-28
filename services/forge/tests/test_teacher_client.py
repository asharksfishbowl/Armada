"""P11 — the teacher client. Training R16b, R16c, R25; invariants 7 and 8.

THIS IS THE ONLY MODULE IN armada-forge THAT CAN CONTACT A PAID ENDPOINT, so it gets the
strictest tests in the phase. Both properties are enforced by construction rather than
asserted from a message:

  * a disabled teacher raises BEFORE opening a socket — checked by severing every socket
    and requiring the call to still raise the right exception;
  * the credential is read from the environment variable NAMED in config, never from a
    file — checked by requiring the call to fail with the variable unset, before any
    request is built.
"""

from __future__ import annotations

import socket
from typing import Any

import pytest

from armada_forge.teacher import (
    TeacherClient,
    TeacherCredentialMissing,
    TeacherDisabled,
    TeacherSettings,
)

DISABLED = TeacherSettings.from_config({"enabled": False, "provider": "none"}, {})

REMOTE = TeacherSettings.from_config(
    {
        "enabled": True,
        "provider": "remote",
        "endpoint": {
            "base_url": "https://api.example.invalid/v1",
            "api_key_env": "ARMADA_TEACHER_API_KEY",
            "model": "big-teacher",
        },
    },
    {},
)


@pytest.fixture
def no_sockets(monkeypatch: pytest.MonkeyPatch) -> None:
    def forbidden(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("a socket was opened on a path that must not reach the network")

    monkeypatch.setattr(socket, "socket", forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)


# ── Invariant 7: disabled means unreachable, not merely unused ──────────────

def test_a_disabled_teacher_raises_before_opening_a_socket(no_sockets) -> None:
    """R16b / edge 22 — "no outbound request is made while `enabled` is `false`".

    The socket layer is severed, so a check performed after building a request would fail
    this test with an AssertionError rather than passing with a tidy message.
    """
    with pytest.raises(TeacherDisabled) as caught:
        TeacherClient(DISABLED).complete([{"role": "user", "content": "hi"}])

    message = str(caught.value)
    assert "supplied_file" in message and "include_trajectories" in message
    assert "mechanical" in message


def test_provider_none_is_refused_even_when_enabled_is_true(no_sockets) -> None:
    """config.py already refuses this combination at startup. Refused here too, so the
    client is safe on its own terms rather than only because something upstream checked."""
    settings = TeacherSettings.from_config({"enabled": True, "provider": "none"}, {})
    with pytest.raises(TeacherDisabled):
        TeacherClient(settings).complete([{"role": "user", "content": "hi"}])


# ── Invariant 8: the credential is a variable NAME ─────────────────────────

def test_an_unset_variable_fails_before_the_request_is_built(
    monkeypatch: pytest.MonkeyPatch, no_sockets
) -> None:
    monkeypatch.delenv("ARMADA_TEACHER_API_KEY", raising=False)

    with pytest.raises(TeacherCredentialMissing) as caught:
        TeacherClient(REMOTE).complete([{"role": "user", "content": "hi"}])

    assert "ARMADA_TEACHER_API_KEY" in str(caught.value)
    assert "no data was transmitted" in str(caught.value)


def test_the_credential_error_is_a_kind_of_unreachable() -> None:
    """Callers that only care "no judgement was obtained" need no extra branch — edge 19
    leaves the Adapter at pending_eval for either cause — while an operator still gets a
    message naming the variable."""
    from armada_forge.teacher import TeacherUnreachable

    assert issubclass(TeacherCredentialMissing, TeacherUnreachable)


def test_settings_carry_no_field_that_could_hold_a_secret() -> None:
    """Invariant 8, made structural. There is nowhere for a credential VALUE to be stored,
    so one cannot be persisted or logged by mistake."""
    assert "api_key" not in TeacherSettings.__dataclass_fields__
    assert "api_key_env" in TeacherSettings.__dataclass_fields__


# ── R16c: local resolves through models.yaml ───────────────────────────────

def test_a_local_teacher_resolves_its_url_by_backend_name() -> None:
    models = {"backends": {"ollama": {"base_url": "http://armada-models:11434/v1",
                                      "api_key_env": "ARMADA_MODELS_API_KEY",
                                      "request_timeout_seconds": 600}}}
    settings = TeacherSettings.from_config(
        {"enabled": True, "provider": "local",
         "endpoint": {"backend": "ollama", "model": "qwen3-4b-instruct"}},
        models,
    )

    assert settings.base_url == "http://armada-models:11434/v1"
    assert settings.request_timeout_seconds == 600


def test_a_local_teacher_does_not_demand_a_credential(
    monkeypatch: pytest.MonkeyPatch
) -> None:
    """Ollama ignores the key, and requiring one would make the free local teacher need a
    credential — which would break invariant 7 for the one provider that costs nothing."""
    models = {"backends": {"ollama": {"base_url": "http://armada-models:11434/v1",
                                      "api_key_env": "ARMADA_MODELS_API_KEY"}}}
    settings = TeacherSettings.from_config(
        {"enabled": True, "provider": "local",
         "endpoint": {"backend": "ollama", "model": "qwen3-4b-instruct"}},
        models,
    )
    monkeypatch.delenv("ARMADA_MODELS_API_KEY", raising=False)

    # The transport is stubbed rather than exercised: this asserts the call REACHES the
    # transport instead of being refused for a missing credential, and a unit test has no
    # business resolving a hostname to prove it.
    import urllib.error
    import urllib.request

    reached: list[str] = []

    def unreachable(request: Any, timeout: Any = None) -> Any:
        reached.append(request.full_url)
        raise urllib.error.URLError("no route in a unit test")

    monkeypatch.setattr(urllib.request, "urlopen", unreachable)

    from armada_forge.teacher import TeacherUnreachable

    with pytest.raises(TeacherUnreachable) as caught:
        TeacherClient(settings).complete([{"role": "user", "content": "hi"}])

    assert reached == ["http://armada-models:11434/v1/chat/completions"]
    assert not isinstance(caught.value, TeacherCredentialMissing)
