# Concepts

These nouns are used identically across every spec. Any spec or code that redefines one is in error.

---

## Corpus

A named collection of ingested **Sources**, chunked and embedded into pgvector. **Carries domain knowledge.**

Referenced by `name` — never by uuid — so a definition file authored on one installation is valid on another. The name is immutable after creation, because Agent definitions reference it and ModelBinding tags embed it.

Ingestion is idempotent per chunk, keyed on `(content_sha256, source_path)`. Re-ingesting unchanged content adds nothing; chunks present in a prior ingestion but absent from the current one are deleted.

## Source

One ingestion input belonging to a Corpus: a git repo, a docs URL, a local directory, or an uploaded file.

## BaseModel

An entry in the curated shortlist (`config/base-models.yaml`) describing a pretrained model plus its serving and training configuration.

File-configured only. There is no endpoint to add one at runtime — a curated shortlist that anything can write to is not curated.

## Adapter

A LoRA adapter produced by a training run, versioned, attached to **exactly one** BaseModel. **Carries domain behavior.**

Versions are monotonic per `(base_model_id, corpus_name)`. An Adapter is servable only in `status: promoted`, which requires passing the evaluation gate.

## ModelBinding

The resolved `(BaseModel, Adapter-or-none)` pair, registered with the model server under a unique tag:

```
armada/{base_model_id}-{corpus_name}-v{version}    # with an adapter
armada/{base_model_id}-base                        # base model, no adapter
```

Base bindings are registered for every shortlist entry at startup, which is what makes `adapter: none` work on a fresh install with no training run having happened.

**Registering a binding writes a record. It does not download a model.** Materialization is separate and explicit.

## Agent

A declarative YAML document binding a persona, a ModelBinding, a tool grant list, an optional Corpus, a sandbox profile, and runtime budgets.

The schema is **closed** — an unknown key at any level fails validation naming the offending path. Nothing in it privileges software engineering over any other domain; `agents/frontend-engineer.yaml` and `agents/chef.yaml` use identical machinery.

Every save creates a new immutable version carrying a **resolved snapshot**: the dereferenced tool list, binding tag, effective budgets, and any warnings. A Run executes against that snapshot and is unaffected by later edits.

## Team

One manager Agent, one or more worker Agents, plus delegation limits.

The manager gets `delegate` and `list_workers`; nothing else about how it runs changes. Delegation is one level deep. Workers share the workspace but not conversation history or tools — every delegated task must carry the paths, constraints, and report format it needs.

## Run

One execution of an Agent or Team. Produces an ordered Event stream and a terminal outcome.

| Outcome | Meaning |
|---|---|
| `success` | Agent called `finish(success: true)`. **The only path to this value.** |
| `incomplete` | Agent reported failure, or stopped without calling `finish` |
| `failed` | Infrastructure fault — unreachable model server, dead sandbox, daemon restart |
| `cancelled` | Operator cancelled |
| `budget_exhausted` | A budget was reached |
| `no_progress` | Identical tool call repeated past the threshold |

`incomplete` and `failed` are deliberately distinct: `incomplete` means the agent ran correctly and reported it didn't achieve the task; `failed` means something broke.

Only `success` runs become trajectory training data.

## Event

An append-only record within a Run, with a monotonic gapless `seq`. **No code path updates or deletes an Event.**

Fourteen types spanning messages, model exchanges, tool calls and results, retrievals, compactions, delegations, and terminal state. Payloads redact any value sourced from a configured credential environment variable.

The Event log is doing double duty: the live stream the dashboard renders, and the raw material the forge reads to build trajectory datasets.

## Sandbox

A per-Run Docker container providing the filesystem and shell that built-in tools operate on.

Non-root, no Docker socket, dropped capabilities, `network: none` or an allowlist. Two mounts only: the workspace bind at `/workspace` and a writable tmpfs at `/armada`.

**The boundary is one-directional.** The daemon reaches in; nothing reaches out.

---

## Two channels of specialization

The distinction that shapes the whole platform:

|  | Corpus | Adapter |
|---|---|---|
| Carries | Knowledge | Behavior |
| Produced by | Ingestion — free | Training — free only in smoke mode |
| Consumed at | Agent time, per query | Model load time |
| Changes | Continuously, by re-ingesting | Discretely, by promoting a version |
| Answers | "What do I know?" | "How do I act?" |

They are independent. An Agent can have either, both, or neither. On the zero-cost path it has a Corpus and no Adapter — which is a complete, useful agent, just not a fine-tuned one.
