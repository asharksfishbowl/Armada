"""P11 — every route this phase adds is actually MOUNTED on the app.

THIS IS THE TEST THAT EXISTS BECAUSE THE DEFECT KEEPS RECURRING. Five times now this repo
has shipped a component that was written, unit-tested, and never called: `min_ram_gb` read
by nothing, `min_disk_gb` unknown to the schema, `validate_directory_location` never
invoked, agent routes never mounted, the agent file loader never called. A router that is
imported but never `include_router`'d is that failure in its most invisible form — the
module imports cleanly, every unit test for its handlers passes, and the endpoint 404s.

No TestClient and no HTTP: `app.routes` is the registration itself. Asserting against it
directly means this test cannot pass because a request happened to be routed somewhere
else.
"""

from __future__ import annotations

from typing import Any

import pytest

from armada_forge import main


def _flatten(routes: Any) -> list[Any]:
    """Every leaf route, in declaration order, across FastAPI versions.

    `include_router` used to copy the sub-router's routes straight onto the app, and newer
    FastAPI wraps them in an `_IncludedRouter` that keeps them behind `original_router`.
    Walking both shapes means this test asserts REGISTRATION rather than one version's
    internal representation of it — which is the whole reason it exists.
    """
    leaves: list[Any] = []
    for route in routes:
        if getattr(route, "path", None) is not None:
            leaves.append(route)
            continue
        inner = getattr(route, "original_router", route)
        leaves.extend(_flatten(getattr(inner, "routes", []) or []))
    return leaves


def _paths(method: str) -> list[str]:
    """Declared paths for one method, IN ORDER. Starlette matches in this order."""
    return [
        route.path
        for route in _flatten(main.app.routes)
        if method in (getattr(route, "methods", None) or set())
    ]


def _registered() -> set[tuple[str, str]]:
    """(method, path) for every route on the app."""
    pairs: set[tuple[str, str]] = set()
    for route in _flatten(main.app.routes):
        path = route.path
        methods = getattr(route, "methods", None) or set()
        if not methods:
            # A WebSocket route carries no methods.
            pairs.add(("WEBSOCKET", path))
            continue
        for method in methods:
            pairs.add((method, path))
    return pairs


# Every endpoint P11 owns, including the four build-plan Requirement 22 moved into this
# phase from P9.
P11_ROUTES = [
    ("POST", "/datasets"),
    ("GET", "/datasets"),
    ("GET", "/datasets/{dataset_id}"),
    ("POST", "/datasets/supplied"),
    ("GET", "/datasets/supplied"),
    ("POST", "/datasets/{dataset_id}/split"),
    ("POST", "/training/runs"),
    ("GET", "/training/runs"),
    ("GET", "/training/runs/{training_run_id}"),
    ("POST", "/training/runs/{training_run_id}/webhook"),
    ("GET", "/adapters"),
    ("GET", "/adapters/{adapter_id}"),
    ("POST", "/adapters/{adapter_id}/promote"),
]


@pytest.mark.parametrize("method,path", P11_ROUTES)
def test_p11_route_is_mounted(method: str, path: str) -> None:
    assert (method, path) in _registered(), (
        f"{method} {path} is not registered on the app. The handler existing is not the "
        "same as the endpoint existing."
    )


def test_earlier_phase_routes_are_still_mounted() -> None:
    """P11 must not unmount what P1 and P2 registered.

    Adding four `include_router` calls is exactly the kind of edit that reorders or drops
    an existing one, and nothing else in the suite would notice.
    """
    registered = _registered()
    for method, path in [
        ("GET", "/health"),
        ("GET", "/config/capabilities"),
        ("GET", "/corpora"),
        ("POST", "/corpora"),
        ("GET", "/models/bindings"),
        ("POST", "/embed"),
    ]:
        assert (method, path) in registered, f"{method} {path} was lost"


def test_p9_base_model_shortlist_route_is_mounted() -> None:
    """P9 — `GET /models/base` backs design-dashboard.md Requirement 129.

    Two of that table's five columns, `quantization` and `smoke_test`, have no other HTTP
    representation anywhere in the platform: they are shortlist-FILE properties and
    `GET /models/bindings` reads the `model_bindings` table. If this route stops being
    mounted, the dashboard does not fail loudly — it renders a BaseModel table with two
    empty columns, which is the quiet-degradation failure this file exists to catch.
    """
    assert ("GET", "/models/base") in _registered()


def test_base_model_route_is_read_only() -> None:
    """`config/base-models.yaml` records that the shortlist is file-configured only (R4).

    A GET does not weaken that; a POST, PUT, PATCH, or DELETE on the same path would. This
    asserts the constraint rather than trusting that nobody adds the obvious next route.
    """
    registered = _registered()
    for method in ("POST", "PUT", "PATCH", "DELETE"):
        assert (method, "/models/base") not in registered, (
            f"{method} /models/base is mounted. The BaseModel shortlist is file-configured "
            "only (Training R4) — it has no write surface by design."
        )


def test_supplied_listing_is_matched_before_the_dataset_id_route() -> None:
    """`/datasets/supplied` must be declared BEFORE `/datasets/{dataset_id}`.

    Starlette matches in registration order, so the parameterised route declared first
    would swallow `supplied` as a dataset_id and answer 404 for a path that exists. Route
    ordering is not something a handler test can observe.
    """
    paths = _paths("GET")
    assert paths.index("/datasets/supplied") < paths.index("/datasets/{dataset_id}")


def test_capabilities_uses_the_same_detection_the_backend_enforces() -> None:
    """R24/R24c — one detection function, not two.

    `GET /config/capabilities` reporting `local_backend_mode: quality` while
    LocalTrainingBackend selects smoke would offer the operator a run that is then refused.
    The endpoint must call `hardware.detect_mode`, not re-implement it.
    """
    import inspect

    from armada_forge.training import hardware

    source = inspect.getsource(main.config_capabilities)
    assert "hardware.detect_mode()" in source
    assert "torch.cuda.is_available" not in source, (
        "capabilities re-implements CUDA detection instead of calling hardware.detect_mode"
    )
    assert hardware.detect_mode() in ("smoke", "quality")
