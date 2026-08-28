"""Registration-time validation for `directory` Sources — Training R8a, R8b.

WHY THIS EXISTS. A `directory` Source names a host path, but forge reads it from inside a
container. A path that is not mounted simply is not there — so ingestion walked an empty
tree, produced no chunks, and reported success. The operator was told their corpus
ingested fine when nothing had been read at all.

R8a fixes the mechanism: ARMADA_INGEST_ROOT is bind-mounted READ-ONLY into forge at the
same path it occupies on the host, so a path the operator types is the path forge opens.
This module is the gate that makes a misconfiguration fail at REGISTRATION, where the
operator is standing, rather than silently at ingestion time.

IT IS NOT THE DAEMON'S WORKSPACE ROOT. That root exists so the daemon can hand Docker a
host path when provisioning a sandbox — a runtime concern, and writable. This one is
read-only source material. Sharing one mount would give sandboxes write access to corpus
inputs, which is a different trust boundary entirely.

ON THE ERROR MESSAGES. Every rejection is one sentence of FAULT plus one sentence of
REMEDY, over a single shared sentence of context. That shape is deliberate: an earlier
draft appended one generic block of mount advice to every branch, which produced messages
that told an operator to "move the content under the root" when their path was ALREADY
under the root, and called `/etc` unreadable when it is merely out of bounds. Advice that
does not apply to the fault at hand is worse than no advice — it sends someone to fix the
wrong thing. Each branch below owns its own remedy for exactly that reason.
"""

from __future__ import annotations

import os
from pathlib import Path

DEFAULT_INGEST_ROOT = "/var/lib/armada/ingest"


def ingest_root() -> Path:
    """Read live rather than cached — docs tell operators a change needs a forge restart,
    and caching would quietly make that instruction untrue for anything but the mount."""
    return Path(os.environ.get("ARMADA_INGEST_ROOT", DEFAULT_INGEST_ROOT))


def path_is_within(candidate: Path, root: Path) -> bool:
    """Containment for an already-resolved path.

    `os.path.commonpath` rather than a string prefix: `/var/lib/armada/ingest-evil` starts
    with the root's text but is not inside it. Both arguments must already be resolved —
    this decides containment only, and does not touch the filesystem.
    """
    try:
        return os.path.commonpath([candidate, root]) == str(root)
    except ValueError:
        # Different drives, or a relative/absolute mix — not comparable, so not contained.
        return False


def _context(root: Path) -> str:
    """The one fact every rejection shares. No remedy here — see the module docstring."""
    return (
        f"armada-forge opens `directory` Sources from INSIDE its container, and "
        f"ARMADA_INGEST_ROOT (`{root}`) is the only host path mounted in, read-only."
    )


def validate_directory_location(location: str) -> str | None:
    """Return an error message, or None when the location is usable.

    Returns rather than raises so the caller owns the HTTP shape and NO `sources` row is
    written on rejection — a rejected registration that leaves a row behind would
    reproduce the original defect one layer down.
    """
    if not location:
        return "`location` is required for a `directory` Source."

    # Resolved up front so every message names paths consistently. An unresolved root and
    # a resolved candidate in the same sentence would print the root two different ways
    # whenever ARMADA_INGEST_ROOT itself contains a symlink.
    root = ingest_root().resolve(strict=False)

    candidate = Path(location)
    if not candidate.is_absolute():
        return (
            f"`{location}` must be an absolute path. {_context(root)} "
            f"Register the path as it appears on the host, for example `{root}/my-docs`."
        )

    # resolve() follows symlinks and normalises `..`, so an escape by either route is
    # caught by the containment check below — the same discipline the sandbox uses for
    # workspace paths. strict=False so a missing path resolves rather than raising; the
    # existence check reports that case with a better message.
    resolved = candidate.resolve(strict=False)

    if not path_is_within(resolved, root):
        escaped = str(resolved) != str(candidate)
        return (
            f"`{location}` "
            + (f"resolves to `{resolved}`, which is " if escaped else "is ")
            + f"outside ARMADA_INGEST_ROOT (`{root}`). {_context(root)} "
            f"Copy the content under `{root}` and register it there, or point "
            f"ARMADA_INGEST_ROOT at a directory you have mounted and restart armada-forge. "
            f"Paths that leave the root by `..` or through a symlink are refused on the "
            f"same terms, because forge cannot read them either."
        )

    if not resolved.exists():
        # Under the root but absent, so telling them to move it under the root — which the
        # generic advice used to do — would be a no-op. These are the two real causes.
        return (
            f"`{location}` is under ARMADA_INGEST_ROOT but does not exist inside "
            f"armada-forge. Either the content has not been copied there yet, or "
            f"ARMADA_INGEST_ROOT was changed without restarting armada-forge, so the "
            f"running container still has the old mount."
        )

    if not resolved.is_dir():
        return (
            f"`{location}` is a file, not a directory. A `directory` Source names a "
            f"directory to walk — register its parent and narrow with `include_globs`."
        )

    # The mount is READ-ONLY (:ro), so readability is the property to check. Requiring
    # writability would reject every correctly-configured Source.
    if not os.access(resolved, os.R_OK | os.X_OK):
        return (
            f"`{location}` exists but armada-forge cannot read it. Grant read and execute "
            f"to the user forge runs as. Write access is neither needed nor possible — "
            f"ARMADA_INGEST_ROOT is mounted read-only."
        )

    return None
