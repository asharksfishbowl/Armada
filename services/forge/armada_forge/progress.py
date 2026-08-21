"""Forge WebSocket progress channel at /ws — Unresolved Dependency 4.

Training R27 already requires training-run progress to reach the dashboard, so forge needs
a push channel regardless of this dependency. Ingestion progress rides the same channel at
near-zero marginal cost, which is what makes the design spec's live ingestion bar (R126)
buildable instead of the degraded polling form (R127).

R127's degraded form is RETAINED — it becomes the state the dashboard shows while the
socket is down, rather than a permanent fallback.

The hub holds no per-connection job state: a client that reconnects re-subscribes and
resumes receiving updates. Job state lives in `ingestion_jobs`, and the dashboard reads
the authoritative status over REST. This mirrors the daemon's gateway rule (Runtime R7)
for the same reason — a socket is a delivery mechanism, never a source of truth.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import WebSocket


class ProgressHub:
    """Fan-out to every connected dashboard client.

    No lock: every mutation of `_clients` happens on the single event loop. `connect` and
    `disconnect` are coroutines, and `broadcast_threadsafe` marshals onto the loop via
    `run_coroutine_threadsafe` rather than touching the set from the worker thread. The
    `list()` copy in `broadcast` is not a lock substitute — it exists because the loop
    below awaits, so the set may legitimately change mid-iteration.
    """

    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self._clients.add(websocket)

    async def disconnect(self, websocket: WebSocket) -> None:
        self._clients.discard(websocket)

    async def broadcast(self, message: dict[str, Any]) -> None:
        """Send to every client, dropping any that have gone away.

        A send failure means that client is gone, not that the message is bad — so it is
        discarded rather than re-raised into the ingestion job. An ingestion must not fail
        because a browser tab closed.
        """
        payload = json.dumps(message)

        for client in list(self._clients):
            try:
                await client.send_text(payload)
            except Exception:  # noqa: BLE001 - a dead socket is not an ingestion error
                self._clients.discard(client)

    def broadcast_threadsafe(self, loop: asyncio.AbstractEventLoop, message: dict[str, Any]) -> None:
        """Broadcast from a worker thread.

        Ingestion runs in a thread (it is CPU- and IO-bound and would otherwise block the
        event loop), so its progress updates cross a thread boundary to reach the loop.
        Fire-and-forget: the ingestion never waits on delivery.
        """
        try:
            asyncio.run_coroutine_threadsafe(self.broadcast(message), loop)
        except RuntimeError:
            # Loop already closed during shutdown. Losing a progress frame at that point is
            # correct behavior, not an error worth surfacing.
            pass


hub = ProgressHub()
