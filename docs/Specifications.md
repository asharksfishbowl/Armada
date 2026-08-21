# Specifications

Armada is spec-first. Every area has an owning spec, and requirements are numbered so they can be referenced across specs — "Agent Runtime R25", "Training Pipeline R37".

**Read the owning spec before touching an area.**

---

## The specs

| Spec | Owns |
|---|---|
| [`platform-overview`](../specs/platform-overview/platform-overview.md) | Shared vocabulary, service topology, spec boundaries. **Not implementable on its own** — every requirement lives in one of the four below. |
| [`model-training-pipeline`](../specs/model-training-pipeline/model-training-pipeline.md) | Corpus ingestion, indexing, dataset construction, training backends, model registry, evaluation gates |
| [`agent-runtime`](../specs/agent-runtime/agent-runtime.md) | Plugin kernel, agent loop, tool registry, sandboxing, MCP, retrieval query, event log, context management |
| [`agent-definition`](../specs/agent-definition/agent-definition.md) | Declarative agent format, persona, model/corpus/tool binding, validation, versioning, CRUD |
| [`team-orchestration`](../specs/team-orchestration/team-orchestration.md) | Manager/worker delegation, capability matching, model scheduling, run lifecycle, synthesis, termination |
| [`dashboard`](../specs/dashboard/design-dashboard.md) | **Design** spec — tokens, motion, status vocabulary, per-surface layout. Constrains what the UI looks like, never how the React is structured or which endpoints exist. |

Supporting documents: [`build-plan`](../specs/build-plan/build-plan.md) (phase decomposition) and [`platform-overview-roadmap`](../specs/platform-overview/platform-overview-roadmap.md) (feasibility rulings against the specs).

---

## How a spec is structured

Every implementable spec has the same sections:

| Section | Contains |
|---|---|
| **Overview** | What this is and why, in two or three sentences |
| **Goals** | What success looks like |
| **Non-Goals** | What this explicitly does *not* do — prevents scope creep |
| **Definitions** | Terms used precisely, defined once |
| **Requirements** | Numbered, discrete, testable statements with concrete nouns |
| **Data Flow** | Step-by-step sequence, actor by actor |
| **Edge Cases** | Numbered, each with a scenario **and** an expected behavior |
| **Acceptance Criteria** | Independently verifiable checklist |
| **Key Files** | Full relative paths, one line each |

Requirements use concrete nouns — file paths, endpoint names, field names. No pronouns without clear antecedents. An implementing agent that loses track of what "it" refers to writes the wrong thing.

## Requirement numbering

Requirements are numbered `1.`, `2.`, `3.` … Insertions use letter suffixes — `16a.`, `16b.` — so existing numbers never shift and cross-references stay valid. A requirement's number is a stable address.

## The audit standard

Every spec is audited until **two consecutive clean passes**. An audit looks for ambiguous language, missing error handling, undefined terms, implicit assumptions, conflicting requirements, gaps in the data flow, untestable acceptance criteria, bare filenames in Key Files, scope leaks, and missing edge cases.

Findings are batched — the whole audit completes before anything is reported — and answered together, because per-finding round-trips are the largest addressable cost in a spec session.

## When specs and code disagree

Sometimes the code is right. The migration ordering is the worked example: the specs assigned `runs` to migration 004 and `agent_versions` to 005, but `runs.agent_version_id` carries a real foreign key, so the schema could not build in that order. The implementation renumbered, and the specs were corrected to match.

A ruling like that belongs in the roadmap with its rationale, and the source spec gets synced. What must never happen is the two drifting apart silently.

## Tooling

The specs deliberately do not pin build tooling, test frameworks, package manager, or linters — those belong to an implementation spec. **Do not invent them.** When the first task in an area needs one, raise it through the pipeline rather than silently picking, and record the decision in `CLAUDE.md` once made.
