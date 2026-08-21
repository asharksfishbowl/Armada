# Contributing

Armada is spec-first and pipeline-driven. Code follows a spec; a spec follows a discussion.

---

## The workflow

```
User → Director (issue queue) → Researcher (build queue) → Builder (code)
```

| Stage | File | Who writes | Who reads |
|---|---|---|---|
| Issues | `issue-queue.groovy` | Director | Researcher |
| Findings and decomposition | `build-queue.groovy` | Researcher | Builder |
| Research notes | `research/*.md` | Researcher | Director |

Queue files, `research/`, and `transcripts/` are gitignored and per-user.

**Issue status is `DRAFT`, `READY`, or `PARKED`. Only the user promotes `DRAFT` to `READY`.** The Researcher processes `READY` items and leaves the others alone.

## Branches

Prefixes: `feature/`, `fix/`, `refactor/`, `chore/`, `debug/`.

Armada is a web/multi-service project, so the Builder branches directly in the main repo — no worktree, no test lane. Stay on the feature branch after pushing and open a PR against `main`.

**Never merge to `main`.** The user decides.

## Before any commit

- No hardcoded secrets. Config files carry `api_key_env` — a variable **name**, never a value.
- All user input validated at system boundaries.
- Parameterized queries only.
- Error messages don't leak stack traces or DB internals.
- No secrets in logs, and none in Event payloads — those redact configured credential variables.

## Working principles

**Root cause only.** Understand why before fixing. Never suppress a symptom.

**No bandaids.** No workarounds, no deduplication hacks, no "good enough" patches.

**No artificial delays.** No `setTimeout`, no retry loops, no arbitrary waits. Event-driven only — which is why the model scheduler admits on request completion rather than polling.

**No guessing.** When unsure, add structured debug logging, trace actual behavior, then fix on evidence.

**One function, one job.** Split anything that changes behavior based on a flag.

**Verify before claiming done.** When you say removed, fixed, or verified, run the check that would detect failure *first*. Claim based on what you observed, never on what you intended.

## Adding a spec

Use the `/spec` skill rather than hand-writing. It runs a formal audit loop that catches ambiguities and missing edge cases, and it requires two consecutive clean passes before a spec is considered complete.

Specs live at `specs/<feature-name>/<feature-name>.md`. Design specs go beside them as `design-<topic>.md`. Never put a spec file flat in `specs/`.
