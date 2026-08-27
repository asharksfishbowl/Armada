"""Shared test fixtures for armada-forge.

`psycopg` is stubbed at import time so unit tests can import modules that reach the
database at module scope without requiring Postgres. Anything that actually exercises the
database is marked `@pytest.mark.integration` and uses a real connection instead.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

# Import armada_forge from the source tree without installing it.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Stub the database driver BEFORE any armada_forge import. db.py imports psycopg at module
# scope; without this, importing anything that touches db would need Postgres present just
# to collect the test.
for _name in ("psycopg", "psycopg_pool", "psycopg.rows"):
    if _name not in sys.modules:
        sys.modules[_name] = types.ModuleType(_name)
sys.modules["psycopg.rows"].dict_row = object()
sys.modules["psycopg_pool"].ConnectionPool = object
sys.modules["psycopg"].rows = sys.modules["psycopg.rows"]
sys.modules["psycopg"].Connection = object

# sentence-transformers is a heavy optional import used only when embedding actually runs.
if "sentence_transformers" not in sys.modules:
    _st = types.ModuleType("sentence_transformers")
    _st.SentenceTransformer = object
    sys.modules["sentence_transformers"] = _st


CONFIG_DIR = Path(__file__).resolve().parents[3] / "config"


@pytest.fixture
def config_dir() -> Path:
    """The REAL shipped config directory.

    Tests load the config the platform actually ships rather than a fixture copy. That is
    deliberate: the min_disk_gb defect was a disagreement between the shipped config and
    the validator, and a fixture copy would have agreed with the validator and passed.
    """
    return CONFIG_DIR


@pytest.fixture
def config_copy(tmp_path: Path) -> Path:
    """A writable copy of the shipped config, for mutation tests."""
    import shutil

    target = tmp_path / "config"
    target.mkdir()
    for source in CONFIG_DIR.glob("*.yaml"):
        shutil.copy(source, target / source.name)
    return target
