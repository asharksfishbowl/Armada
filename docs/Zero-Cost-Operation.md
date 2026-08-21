# Zero-Cost Operation

**No step on Armada's default path contacts a paid endpoint.** A fresh install is fully functional with no accounts, no credentials, and no egress to any model provider.

This is a platform invariant, not a trial tier. A change that makes the default path require a key or a GPU is a regression.

---

## The test

> On a fresh CPU-only installation with no credentials and **egress to external model providers blocked at the firewall**, an operator can ingest a Corpus, upload a JSONL, build a dataset, run a local smoke training run, and run an Agent against a real task with retrieval and sandboxed tools — with no errors attributable to a blocked request.

That is an acceptance criterion, and it applies to every phase, not just training. If a code path can reach a paid endpoint without the operator explicitly enabling it, that is a bug.

---

## What's free

| Concern | Implementation | Cost |
|---|---|---|
| Ingestion, chunking | Local — git clone, extraction | none |
| Embedding | `bge-small-en-v1.5` on CPU | none |
| Retrieval | pgvector + full-text + RRF | none |
| Agent runs | Base ModelBindings via Ollama | none |
| Team runs | Same | none |
| Dataset construction | Supplied JSONL and/or trajectories | none |
| Training | `LocalTrainingBackend` smoke mode | none |
| Evaluation gate | `mechanical` — perplexity + tool-call validity | none |
| Dashboard | Local | none |

A first `docker compose up` transfers **zero model bytes**. Registering a ModelBinding writes a record; materializing one is a separate, explicit act.

---

## The four defaults that enforce it

```yaml
# config/teacher.yaml
enabled: false        # corpus distillation is opt-in
provider: none        # none | local | remote — only `remote` spends money

# config/eval.yaml
mode: mechanical      # perplexity + tool-call validity, no teacher
```

Plus `LocalTrainingBackend` in smoke mode (CPU, `qwen3-0.6b`, 20 steps) and Agents bound with `model.adapter: none`.

While `teacher.enabled` is `false`:

- `POST /datasets` naming a `corpus_id` returns **HTTP 400** naming the two teacher-free sources — and makes **no outbound request**. The rejection happens before any connection is attempted, which is what the blocked-egress test verifies.
- `eval.mode: judge` **fails startup** naming both settings. An operator learns their gate is misconfigured before a training run, not after one.

---

## Getting training data without a teacher

Corpus distillation is the only dataset source that needs a teacher model, and it's off by default. Two sources remain:

**Operator-supplied JSONL** — `POST /datasets/supplied`. Each line is an object with `instruction` and `response`. These carry a real reference response, so unlike trajectories they are **eligible for the held-out evaluation split**.

**Captured trajectories** — flattened from Runs whose `run_end` records `outcome: success`. Free, self-reinforcing, and requires the runtime to exist first. Trajectory samples are never placed in the eval split, because their reference response is a small model's own prior output — scoring a candidate against itself measures nothing.

A trajectory-only dataset cannot be split, and therefore cannot produce a promotable adapter. It *can* still be used for a smoke run, because the split exists solely to gate promotion.

---

## What the free path does not give you

**Promoted adapters.** Smoke runs are unpromotable by design. A 0.6B model at 20 steps proves the pipeline executes end to end; it does not produce a model worth serving. A smoke adapter is rejected **before evaluation runs at all** — it carries no scores, because spending judge tokens on something that cannot be promoted under any outcome is never correct.

So on the zero-cost path, specialization comes entirely from **Corpus + persona + tool grants**, with every Agent bound to a base model.

This is a real tradeoff, honestly stated: the behavior half of the RAG/fine-tuning split is built and exercised, but produces nothing servable until one of the two upgrades below.

---

## Upgrade path 1 — add a GPU

**Cost: hardware only. No account, no config change.**

`LocalTrainingBackend` detects CUDA at startup and selects its mode:

| Mode | Trigger | Behavior |
|---|---|---|
| Smoke | No CUDA device | `smoke_test: true` models only, `max_steps` capped at 20, `max_samples` at 200, `run_kind: smoke`, never promotable |
| Quality | CUDA present | Any `trainable: true` model, requested hyperparameters uncapped, `run_kind: quality`, promotable |

Mode is **never operator-selectable**. Requesting a non-smoke model with no GPU present is an error, not a silent downgrade — a run must never be mistaken for a quality run it wasn't.

---

## Upgrade path 2 — add a teacher budget

**Cost: API spend, scaling with dataset size.**

```yaml
# config/teacher.yaml
enabled: true
provider: remote      # or `local` — see below
```

This unlocks corpus distillation and, optionally, `eval.mode: judge` for a stronger promotion gate. `RemoteTrainingBackend` becomes available for quality runs without local hardware.

### `provider: local` — the middle tier

A teacher served by `armada-models` costs nothing beyond CPU time. It is genuinely free and genuinely slow: a 4B teacher on CPU generates on the order of **thousands of samples per day**. Viable for a small corpus left running overnight; impractical for a large one.

### Rough spend, if you go remote

For a ~5,000-sample dataset (~10M input / 2M output tokens including the entailment check), and a 200-sample judge gate:

| Workload | Approach | Order of magnitude |
|---|---|---|
| Distillation | Mid-tier model via batch API (50% off) | ~$20–30 |
| Judge gate | Higher-tier model, 200 calls, rubric cached | ~$4 per gate |
| Remote LoRA training (≤16B) | Token-priced provider at ~$0.50/1M training tokens | single-digit dollars at these model sizes |

A complete train→agent→task cycle lands under $50. Verify current pricing before committing — these figures were accurate in August 2026 and model pricing moves.

---

## Guarding the invariant

Credentials are read from **environment variables only**, never from a file in the repo. Config files carry an `api_key_env` — a variable *name*, never a value. Event payloads redact any value sourced from a configured credential variable.

`grep`ping the repository for a provider API key value must return no matches. That is an acceptance criterion.
