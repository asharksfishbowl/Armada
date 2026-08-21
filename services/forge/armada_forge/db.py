"""Database access for armada-forge.

One connection pool for the process. Phase 0's health probe opened a fresh connection per
call, which is fine at one probe every ten seconds and wasteful once ingestion is issuing
thousands of writes.

armada-forge OWNS writes to `corpora`, `sources`, `chunks`, and `ingestion_jobs`
(platform boundary 1). armada-daemon only ever reads `chunks`, and only for retrieval.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Any, Iterator

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

DATABASE_URL = os.environ.get("DATABASE_URL", "")

_pool: ConnectionPool | None = None


def init_pool() -> ConnectionPool:
    """Create the pool. Called once from the lifespan startup hook."""
    global _pool
    if _pool is None:
        _pool = ConnectionPool(
            DATABASE_URL,
            min_size=1,
            max_size=8,
            # Do not block startup on the database being up — Compose already gates forge
            # behind armada-db's healthcheck and the migrate job, and a pool that raises
            # here would turn a transient blip into a container crash loop.
            open=False,
            kwargs={"row_factory": dict_row},
        )
        _pool.open()
    return _pool


def close_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


@contextmanager
def connection() -> Iterator[psycopg.Connection]:
    """Borrow a pooled connection.

    psycopg commits on clean exit from the connection context and rolls back on exception,
    so callers get transactional writes without managing it themselves.
    """
    if _pool is None:
        raise RuntimeError("db.init_pool() has not been called")
    with _pool.connection() as conn:
        yield conn


def query(sql: str, params: tuple[Any, ...] | dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Run a read and return every row.

    Parameters are always bound, never interpolated — no caller builds SQL by
    concatenation.
    """
    with connection() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        if cur.description is None:
            return []
        return cur.fetchall()


def query_one(sql: str, params: tuple[Any, ...] | dict[str, Any] | None = None) -> dict[str, Any] | None:
    rows = query(sql, params)
    return rows[0] if rows else None


def execute(sql: str, params: tuple[Any, ...] | dict[str, Any] | None = None) -> int:
    """Run a write and return the affected row count."""
    with connection() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.rowcount


def reachable() -> bool:
    """Health probe. Any failure means unreachable."""
    try:
        with connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT 1")
        return True
    except Exception as exc:  # noqa: BLE001 - any failure means unreachable
        print(f"\n⚠️  armada-forge: database probe failed: {exc}\n")
        return False
