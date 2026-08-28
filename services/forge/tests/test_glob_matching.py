"""`**/` must match zero directories as well as many — R6.

fnmatch has no globstar: it translates `**/*.md` into a regex needing a literal `/`, so
the idiomatic "all markdown files" pattern silently skipped every file at the root of a
Source. The smoke test found it only because its fixture happened to sit there, and it
took three CI runs to attribute correctly, because an empty result looks identical to a
Source with nothing in it.
"""

from armada_forge.ingest.sources import matches_globs


def test_globstar_matches_a_file_at_the_root() -> None:
    # The regression. Before the fix this returned False.
    assert matches_globs("guide.md", ["**/*.md"], []) is True


def test_globstar_still_matches_nested_files() -> None:
    assert matches_globs("docs/guide.md", ["**/*.md"], []) is True
    assert matches_globs("a/b/c/guide.md", ["**/*.md"], []) is True


def test_a_plain_star_still_only_matches_its_own_level() -> None:
    # `**/` gaining a meaning must not give plain `*` one it never had.
    assert matches_globs("guide.md", ["*.md"], []) is True


def test_non_matching_extensions_are_still_excluded() -> None:
    assert matches_globs("guide.txt", ["**/*.md"], []) is False
    assert matches_globs("docs/guide.txt", ["**/*.md"], []) is False


def test_exclude_wins_over_include_at_the_root_too() -> None:
    # The fix widens include; it must widen exclude identically, or a `**/`-excluded
    # file at the root would slip back in — a wider hole than the one being closed.
    assert matches_globs("secret.md", ["**/*.md"], ["**/secret.md"]) is False
    assert matches_globs("docs/secret.md", ["**/*.md"], ["**/secret.md"]) is False


def test_no_includes_still_admits_everything() -> None:
    assert matches_globs("guide.md", [], []) is True
