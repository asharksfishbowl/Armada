"""Chunking strategies — Training R10 and edge 4.

Two strategies, selected by file type:

  code   — split on top-level function and class boundaries, NEVER splitting a function
           body across chunks
  prose  — split on heading and paragraph boundaries

Both target 512 tokens with 64 tokens of overlap, and hard-split any single unit above
1024 tokens, flagging the results `split_oversize: true` (edge 4).

WHY TWO STRATEGIES. A chunk is only useful if it is retrievable and self-contained. Half a
function is neither: it returns a signature with no body, or a body with no name, and the
embedding describes something that does not exist in the source. Prose has the same
property at paragraph granularity. Splitting on the wrong boundary is the single easiest
way to make retrieval quietly useless, which is why the boundary rule is spec'd rather
than left to a fixed window.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

TARGET_TOKENS = 512
OVERLAP_TOKENS = 64
MAX_UNIT_TOKENS = 1024


@dataclass(frozen=True)
class Chunk:
    content: str
    token_count: int
    start_line: int | None
    end_line: int | None
    split_oversize: bool


def estimate_tokens(text: str) -> int:
    """Approximate token count without loading a tokenizer.

    ~4 characters per token is the standard rough ratio for English and for code. The
    chunker only needs this to decide boundaries; the exact count stored on a chunk row
    comes from the same estimate, so the two never disagree with each other.

    Deliberately not the embedding model's tokenizer: that would make chunk boundaries
    depend on which embedding model is configured, so changing the model would silently
    change every chunk boundary in a re-ingestion.
    """
    return estimate_tokens_of(len(text))


def estimate_tokens_of(char_count: int) -> int:
    """The same estimate over a character count already known.

    Lets the packers track a running size instead of re-joining their buffer to measure it,
    which is the difference between linear and quadratic on a large file.
    """
    return max(1, char_count // 4)


# A top-level definition in the C-family, Python, Go, Rust, JS/TS, and JVM languages.
# Anchored at column zero: an indented `def` is a method inside a class, and the class is
# the unit we want to keep whole.
_TOP_LEVEL_DEF = re.compile(
    r"^(?:"
    r"(?:@\w[\w.]*.*\n)*"                      # decorators/annotations above the def
    r"(?:export\s+)?(?:default\s+)?"
    r"(?:public\s+|private\s+|protected\s+|internal\s+)?"
    r"(?:static\s+|final\s+|abstract\s+|async\s+|pub\s+)*"
    r"(?:def|class|func|fn|function|interface|struct|enum|impl|trait|type|const|let|var)"
    r"\b"
    r")",
    re.MULTILINE,
)

# Markdown/rst headings, or a blank-line-separated paragraph break.
_HEADING = re.compile(r"^(?:#{1,6}\s+\S|={3,}\s*$|-{3,}\s*$|\S.*\n[=-]{3,}\s*$)", re.MULTILINE)


def _hard_split(unit: str, start_line: int) -> list[Chunk]:
    """Edge 4 — a single unit above MAX_UNIT_TOKENS is split at that limit with overlap.

    Reached when one function or one paragraph is itself enormous. The result is flagged
    so a consumer can tell these chunks were cut mid-construct rather than on a boundary.

    Sizes are tracked as a running character count rather than by re-joining the buffer on
    every line: a 3000-line function would otherwise rebuild the whole string per line.
    """
    chunks: list[Chunk] = []
    current: list[str] = []
    current_chars = 0
    line_cursor = start_line

    def emit(lines_list: list[str], first_line: int) -> None:
        text = "\n".join(lines_list)
        if not text.strip():
            return
        chunks.append(
            Chunk(
                content=text,
                token_count=estimate_tokens(text),
                start_line=first_line,
                end_line=first_line + len(lines_list) - 1,
                split_oversize=True,
            )
        )

    for line in unit.split("\n"):
        current.append(line)
        current_chars += len(line) + 1

        if estimate_tokens_of(current_chars) >= MAX_UNIT_TOKENS:
            emit(current, line_cursor)

            # Carry OVERLAP_TOKENS worth of trailing lines into the next chunk so a
            # construct cut in half is still retrievable from either side.
            keep = 0
            kept_chars = 0
            for prev in reversed(current):
                keep += 1
                kept_chars += len(prev) + 1
                if estimate_tokens_of(kept_chars) >= OVERLAP_TOKENS:
                    break

            line_cursor += len(current) - keep
            current = current[-keep:]
            current_chars = kept_chars

    emit(current, line_cursor)
    return chunks


def _units_to_chunks(units: list[tuple[str, int]]) -> list[Chunk]:
    """Pack boundary-delimited units into TARGET_TOKENS chunks without splitting a unit.

    A unit is (text, first_line). Units are accumulated until adding the next would exceed
    the target; an oversize unit goes through _hard_split instead. This is what enforces
    "never split a function body" — the packer only ever joins whole units.
    """
    chunks: list[Chunk] = []
    batch: list[tuple[str, int]] = []
    batch_chars = 0

    def flush() -> None:
        nonlocal batch_chars
        if not batch:
            return
        text = "\n".join(t for t, _ in batch)
        batch_chars = 0
        if not text.strip():
            batch.clear()
            return
        first_line = batch[0][1]
        chunks.append(
            Chunk(
                content=text,
                token_count=estimate_tokens(text),
                start_line=first_line,
                end_line=first_line + text.count("\n"),
                split_oversize=False,
            )
        )
        batch.clear()

    for text, line in units:
        if estimate_tokens(text) > MAX_UNIT_TOKENS:
            flush()
            chunks.extend(_hard_split(text, line))
            continue

        # Running character count rather than re-joining the batch to measure it — the
        # join was rebuilding every accumulated unit once per additional unit.
        if batch and estimate_tokens_of(batch_chars + len(text) + 1) > TARGET_TOKENS:
            flush()
        batch.append((text, line))
        batch_chars += len(text) + 1

    flush()
    return chunks


def _boundary_lines(text: str, pattern: re.Pattern[str]) -> set[int]:
    """Line numbers where `pattern` matches.

    `text.count("\\n", 0, start)` rather than `text[:start].count("\\n")`: the slice copies
    the whole prefix per match, so a file with hundreds of definitions copies itself
    hundreds of times.
    """
    return {text.count("\n", 0, match.start()) for match in pattern.finditer(text)}


def _units_from_boundaries(lines: list[str], boundaries: set[int]) -> list[tuple[str, int]]:
    """Slice `lines` at every boundary into (text, first_line) units.

    Line numbers are 1-indexed to match `chunks.start_line` / `end_line`.
    """
    edges = sorted(boundaries | {0, len(lines)})
    units: list[tuple[str, int]] = []
    for start, end in zip(edges, edges[1:]):
        unit = "\n".join(lines[start:end])
        if unit.strip():
            units.append((unit, start + 1))
    return units


def chunk_code(text: str) -> list[Chunk]:
    """Split on top-level function and class boundaries (R10)."""
    lines = text.split("\n")
    return _units_to_chunks(_units_from_boundaries(lines, _boundary_lines(text, _TOP_LEVEL_DEF)))


def chunk_prose(text: str) -> list[Chunk]:
    """Split on heading and paragraph boundaries (R10)."""
    lines = text.split("\n")
    boundaries = _boundary_lines(text, _HEADING)

    # Paragraph breaks are boundaries too, so a long unheaded document still splits.
    boundaries |= {
        i + 1
        for i, line in enumerate(lines)
        if not line.strip() and 0 < i < len(lines) - 1 and lines[i + 1].strip()
    }

    return _units_to_chunks(_units_from_boundaries(lines, boundaries))


def chunk(text: str, is_code: bool) -> list[Chunk]:
    """Chunk one file's text with the strategy matching its type."""
    return chunk_code(text) if is_code else chunk_prose(text)
