"""Per-filetype text extraction and extension filtering — Training R9.

Ingestion extracts text from exactly these types and SKIPS everything else:

  .md .mdx .txt .rst .pdf .html   — spec'd directly in R9
  + any extension in config/code-extensions.yaml

The code-extension list does double duty (R9 and R10): it decides both whether a file is
ingested at all and which chunking strategy it gets. A file whose extension is on that
list is chunked on function/class boundaries; everything else on headings/paragraphs.
"""

from __future__ import annotations

import html.parser
import re
from dataclasses import dataclass
from pathlib import Path

# R9 — prose types, spec'd directly rather than configured. config/code-extensions.yaml
# ADDS to this set; it does not replace it.
PROSE_EXTENSIONS: frozenset[str] = frozenset({".md", ".mdx", ".txt", ".rst", ".pdf", ".html"})


@dataclass(frozen=True)
class ExtractedFile:
    """One file's text plus the classification the chunker needs."""

    source_path: str
    text: str
    is_code: bool


class _HtmlTextParser(html.parser.HTMLParser):
    """Strip tags, keeping text and block structure.

    Uses the standard library rather than adding BeautifulSoup: extraction here only needs
    readable text, and `web` Source crawling (which does need link parsing) handles its own
    HTML in sources.py.
    """

    # Content inside these is not prose and would pollute both the embedding and the
    # full-text index.
    _SKIP = frozenset({"script", "style", "noscript", "svg", "head"})
    # Tags whose boundaries are paragraph breaks, so the prose chunker can split on them.
    _BLOCK = frozenset({"p", "div", "br", "li", "tr", "section", "article",
                        "h1", "h2", "h3", "h4", "h5", "h6"})

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self._SKIP:
            self._skip_depth += 1
        elif tag in self._BLOCK:
            self._parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self._SKIP and self._skip_depth > 0:
            self._skip_depth -= 1
        elif tag in self._BLOCK:
            self._parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._skip_depth == 0:
            self._parts.append(data)

    def text(self) -> str:
        joined = "".join(self._parts)
        # Collapse the runs of blank lines the block handling produces, so paragraph
        # splitting sees real paragraph boundaries.
        return re.sub(r"\n{3,}", "\n\n", joined).strip()


def _extract_html(raw: bytes) -> str:
    parser = _HtmlTextParser()
    parser.feed(raw.decode("utf-8", errors="replace"))
    parser.close()
    return parser.text()


def _extract_pdf(path: Path) -> str:
    """Extract PDF text.

    pypdf is imported lazily: it is the only extraction dependency that is not stdlib, and
    a Corpus of pure Markdown should not fail to ingest because a PDF library is missing.
    """
    try:
        from pypdf import PdfReader
    except ImportError:
        print("\n⚠️  armada-forge: pypdf not installed, skipping PDF\n")
        return ""

    try:
        reader = PdfReader(str(path))
        return "\n\n".join(page.extract_text() or "" for page in reader.pages).strip()
    except Exception as exc:  # noqa: BLE001 - a malformed PDF must not fail the job
        print(f"\n⚠️  armada-forge: PDF extraction failed for {path}: {exc}\n")
        return ""


def is_ingestable(path: Path, code_extensions: frozenset[str]) -> bool:
    """R9 — is this file's extension one we extract text from?"""
    suffix = path.suffix.lower()
    return suffix in PROSE_EXTENSIONS or suffix in code_extensions


def extract(path: Path, source_path: str, code_extensions: frozenset[str]) -> ExtractedFile | None:
    """Extract one file's text, or None when it yields nothing usable.

    Returning None rather than raising is deliberate: edge 3 requires a file whose
    extracted text is empty or whitespace-only to count in `files_skipped` rather than
    fail the ingestion job.
    """
    suffix = path.suffix.lower()
    is_code = suffix in code_extensions

    if suffix == ".pdf":
        text = _extract_pdf(path)
    elif suffix == ".html":
        try:
            text = _extract_html(path.read_bytes())
        except Exception as exc:  # noqa: BLE001
            print(f"\n⚠️  armada-forge: HTML extraction failed for {path}: {exc}\n")
            return None
    else:
        try:
            # errors="replace" rather than strict: a stray invalid byte in one file should
            # not abort a repository-sized ingestion.
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            print(f"\n⚠️  armada-forge: read failed for {path}: {exc}\n")
            return None

    if not text.strip():
        return None

    return ExtractedFile(source_path=source_path, text=text, is_code=is_code)
