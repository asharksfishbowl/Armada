"""Source fetchers — Training R8.

Four Source types, each resolving to a local directory the extractor walks:

  git        depth-1 clone to a temp directory
  web        same-origin crawl to depth 2
  directory  a path bind-mounted into the container
  upload     a previously uploaded blob

Edge 1 is the load-bearing behavior here: a Source that fails to fetch records `failed`
with its underlying error, the job CONTINUES with the remaining Sources, and the job ends
`partial` rather than `failed`. One unreachable repository must not discard the work done
for every other Source in the Corpus.
"""

from __future__ import annotations

import fnmatch
import os
import re
import shutil
import subprocess
import tempfile
import urllib.parse
import urllib.request
from collections import deque
from dataclasses import dataclass
from pathlib import Path

from armada_forge.ingest.directory_source import path_is_within, validate_directory_location

UPLOAD_ROOT = Path("/data/uploads")
WEB_CRAWL_DEPTH = 2
WEB_TIMEOUT_SECONDS = 30
GIT_TIMEOUT_SECONDS = 300


class SourceFetchError(Exception):
    """A Source could not be fetched. Caught per-Source; never aborts a job."""


@dataclass
class FetchedSource:
    """A fetched Source rooted at a local directory."""

    root: Path
    # Set when the fetch created a temp directory that the caller must clean up.
    cleanup: Path | None


def _run_git(args: list[str]) -> None:
    try:
        result = subprocess.run(
            ["git", *args],
            capture_output=True,
            text=True,
            timeout=GIT_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise SourceFetchError(f"git timed out after {GIT_TIMEOUT_SECONDS}s") from exc

    if result.returncode != 0:
        # git puts the actionable message (auth required, not found, DNS) on stderr.
        raise SourceFetchError(result.stderr.strip() or f"git exited {result.returncode}")


def _fetch_git(location: str) -> FetchedSource:
    """Depth-1 clone (R8).

    Depth 1 because ingestion reads the working tree, never history — a full clone of a
    large repository would cost minutes and gigabytes for content that is never extracted.
    """
    temp = Path(tempfile.mkdtemp(prefix="armada-ingest-git-"))
    try:
        _run_git(["clone", "--depth", "1", "--quiet", location, str(temp)])
    except SourceFetchError:
        shutil.rmtree(temp, ignore_errors=True)
        raise
    return FetchedSource(root=temp, cleanup=temp)


def _same_origin(base: str, candidate: str) -> bool:
    a, b = urllib.parse.urlparse(base), urllib.parse.urlparse(candidate)
    return (a.scheme, a.netloc) == (b.scheme, b.netloc)


def _extract_links(html_text: str, base_url: str) -> list[str]:
    links: list[str] = []
    for match in re.finditer(r'href=["\']([^"\']+)["\']', html_text, re.IGNORECASE):
        joined = urllib.parse.urljoin(base_url, match.group(1))
        # Drop the fragment: #section on the same page is the same document, and crawling
        # it again would duplicate every chunk on that page.
        joined, _ = urllib.parse.urldefrag(joined)
        if _same_origin(base_url, joined):
            links.append(joined)
    return links


def _fetch_web(location: str) -> FetchedSource:
    """Same-origin crawl to depth 2 (R8).

    Same-origin because a docs site links out to the whole internet, and depth-bounded
    because a crawl with no bound is not an ingestion, it is an outage.
    """
    temp = Path(tempfile.mkdtemp(prefix="armada-ingest-web-"))
    visited: set[str] = set()
    queue: deque[tuple[str, int]] = deque([(location, 0)])

    while queue:
        url, depth = queue.popleft()
        if url in visited or depth > WEB_CRAWL_DEPTH:
            continue
        visited.add(url)

        try:
            request = urllib.request.Request(url, headers={"User-Agent": "armada-forge"})
            with urllib.request.urlopen(request, timeout=WEB_TIMEOUT_SECONDS) as response:
                content_type = response.headers.get("Content-Type", "")
                body = response.read()
        except Exception as exc:  # noqa: BLE001 - one bad page must not end the crawl
            if url == location:
                # The seed URL failing means the Source is unusable; anything deeper is a
                # broken link, which is normal on a real docs site.
                shutil.rmtree(temp, ignore_errors=True)
                raise SourceFetchError(f"{url}: {exc}") from exc
            print(f"\n⚠️  armada-forge: skipping {url}: {exc}\n")
            continue

        if "html" not in content_type.lower():
            continue

        # Mirror the URL path into the temp tree so source_path stays meaningful in a
        # retrieval result — an operator seeing a citation needs to know which page it was.
        parsed = urllib.parse.urlparse(url)
        rel = parsed.path.lstrip("/") or "index"
        if rel.endswith("/"):
            rel += "index"
        if not rel.endswith(".html"):
            rel += ".html"
        target = temp / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)

        if depth < WEB_CRAWL_DEPTH:
            text = body.decode("utf-8", errors="replace")
            for link in _extract_links(text, url):
                if link not in visited:
                    queue.append((link, depth + 1))

    return FetchedSource(root=temp, cleanup=temp)


def _fetch_directory(location: str) -> FetchedSource:
    """A path bind-mounted into the container (R8).

    RE-VALIDATED HERE, not only at registration. R8b rejects a bad path when the operator
    registers it, but registration-time-only means the `sources` table is never swept
    again: a row written before R8b existed, or under a different ARMADA_INGEST_ROOT, would
    otherwise be walked unbounded at ingestion time. Checking at the point of USE is what
    makes the rule hold for rows the gate never saw.

    Delegating rather than repeating the checks also keeps one definition of what a valid
    `directory` Source is. This function previously carried its own exists/is_dir pair and
    no containment check at all, which is exactly the drift that gets missed.
    """
    problem = validate_directory_location(location)
    if problem:
        # SourceFetchError, so edge 1 applies: this Source records `failed` with the
        # message and the remaining Sources still ingest.
        raise SourceFetchError(problem)

    # No cleanup — this is the operator's directory, not ours.
    return FetchedSource(root=Path(location).resolve(), cleanup=None)


def _fetch_upload(location: str) -> FetchedSource:
    """A previously uploaded blob (R8)."""
    path = UPLOAD_ROOT / location
    # An upload location is operator-supplied, so confine it to UPLOAD_ROOT rather than
    # trusting it — `../../etc` would otherwise ingest the filesystem. Same containment
    # helper the ingest root uses: one rule, one implementation. Two idioms for "confine a
    # path to a root" had already drifted apart on `strict=`, and a rule this load-bearing
    # should not be strengthened in one place and missed in the other.
    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise SourceFetchError(f"upload not found under {UPLOAD_ROOT}: {location}") from exc

    if not path_is_within(resolved, UPLOAD_ROOT.resolve()):
        raise SourceFetchError(f"upload not found under {UPLOAD_ROOT}: {location}")

    if resolved.is_dir():
        return FetchedSource(root=resolved, cleanup=None)

    # A single uploaded file is presented as a one-file directory so the walker is uniform.
    temp = Path(tempfile.mkdtemp(prefix="armada-ingest-upload-"))
    shutil.copy2(resolved, temp / resolved.name)
    return FetchedSource(root=temp, cleanup=temp)


_FETCHERS = {
    "git": _fetch_git,
    "web": _fetch_web,
    "directory": _fetch_directory,
    "upload": _fetch_upload,
}


def fetch(source_type: str, location: str) -> FetchedSource:
    fetcher = _FETCHERS.get(source_type)
    if fetcher is None:
        raise SourceFetchError(f"unknown source type `{source_type}`")
    return fetcher(location)


def matches_globs(rel_path: str, include: list[str], exclude: list[str]) -> bool:
    """Apply a Source's include/exclude globs (R6).

    Exclude wins over include: an operator listing `**/*.md` and excluding `vendor/**`
    means the vendor copies stay out, not that the include re-admits them.
    """
    if any(fnmatch.fnmatch(rel_path, pattern) for pattern in exclude):
        return False
    if include:
        return any(fnmatch.fnmatch(rel_path, pattern) for pattern in include)
    return True


# Directories that are never worth walking. .git especially: a depth-1 clone still has one,
# and it is full of binary objects that every extension filter would reject one file at a
# time.
SKIP_DIRS: frozenset[str] = frozenset(
    {".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv",
     "dist", "build", ".next", ".cache", "target", ".mypy_cache", ".pytest_cache"}
)


def walk_files(root: Path, include: list[str], exclude: list[str]) -> list[tuple[Path, str]]:
    """Yield (absolute_path, source_relative_path) for every candidate file.

    Uses os.walk with IN-PLACE directory pruning so SKIP_DIRS are never descended into.
    rglob would walk `.git` and `node_modules` in full and stat every entry before
    rejecting them one at a time — a depth-1 clone still carries thousands of git objects,
    and a checked-in node_modules carries six figures of files.
    """
    results: list[tuple[Path, str]] = []

    for dirpath, dirnames, filenames in os.walk(root):
        # Mutating dirnames in place is what prunes the descent; replacing the list object
        # would not, because os.walk reads the same list it handed us.
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)

        base = Path(dirpath)
        for filename in sorted(filenames):
            path = base / filename
            rel = path.relative_to(root).as_posix()
            if matches_globs(rel, include, exclude):
                results.append((path, rel))

    return results


def cleanup(fetched: FetchedSource) -> None:
    if fetched.cleanup is not None:
        shutil.rmtree(fetched.cleanup, ignore_errors=True)
