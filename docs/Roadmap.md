# Roadmap

## Build phases

Decomposed in [`build-plan.md`](../specs/build-plan/build-plan.md). Ordering is driven by dependency, not by area — each phase unblocks the next.

| Phase | Contents |
|---|---|
| 0 | Compose topology, database schema, service skeletons, healthchecks |
| 1 | Forge ingestion, Corpus API, base ModelBindings, config-state endpoint |
| 2 | Daemon kernel, gateway, event log, sandbox provider |
| 3 | Agent Definition schema, validation, versioning, file loader |
| 4 | Agent loop, tools, model adapter, scheduler, budgets, Code mode |
| 5 | Retrieval provider, `search_knowledge`, auto-injection |
| 6 | Team orchestration |
| 7 | Datasets, training backends, evaluation gate, promotion |
| 8 | Dashboard |

Training lands late deliberately. It is the only area gated on optional external accounts, and the MVP is fully demonstrable without it using base ModelBindings.

## The MVP slice

The one path that must work end to end:

1. Create a Corpus, add a git repo Source, ingest it
2. Upload a supplied JSONL and build a dataset
3. Run a local smoke training run, proving the pipeline executes
4. Define an Agent binding a **base** ModelBinding, the Corpus, and a sandboxed toolset
5. Run it against a real task and watch the event stream
6. Compose it into a Team and run a manager-delegated task

Every requirement is either on this path or explicitly marked post-MVP. No step contacts a paid endpoint.

---

## Colibri

**Status: approved, needs its own spec.**

[Colibri](https://github.com/JustVugg/colibri) (Apache 2.0) is a mixture-of-experts inference engine in pure C. It treats NVMe, RAM, and VRAM as one memory hierarchy: dense layers stay RAM-resident while routed experts stream from disk behind a learned LRU cache with one-layer-ahead prefetch. CPU is the baseline; a GPU only makes it faster.

**Why it fits.** The daemon binds to models through exactly one seam — it consumes ModelBindings by tag over the OpenAI-compatible API. Colibri ships a gateway speaking that API, so it integrates as a sibling service behind the existing boundary with zero daemon changes. And it is CPU-first, which is the one hardware constraint that cannot bend.

**Integrate, do not reimplement.** The reimplement-prior-art precedent set by DeepSeek Harness does not transfer: that rationale is specifically about a plugin contract in active preview. Colibri is consumed across a stable published HTTP interface. Writing an MoE streaming engine in C is out of scope.

**Already landed:** the registry seam — `backend` discriminator and the `ollama_tag` → `serving_ref` rename — shipped ahead of the spec, because retrofitting a discriminator into a populated table behind a live API contract costs far more than adding a defaulted field to an empty one. `ollama` remains the only accepted value.

**Open before speccing:**
- Does Colibri's gateway emit tool calls in `json_schema` or `hermes`? If not, Standard mode cannot use it and the integration is much narrower.
- Throughput figures need confirming by running it, not by reading the README.

**Known knock-ons:** the scheduler needs per-backend concurrency limits (Colibri's `max_concurrent_per_tag: 1` is a capability, not a default — two concurrent requests evict each other's expert working set); default Run budgets are wrong at ~1.4 tok/s and need a throughput class with a validation warning; and lazy model materialization becomes mandatory rather than merely preferable, because a 7–20 GB model cannot be baked into an image.
