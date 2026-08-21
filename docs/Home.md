# Armada Wiki

Self-hosted platform for producing domain-specialized small language models and pairing each one with a purpose-built, tool-using agent.

If you are here to **run it**, start with [Getting Started](getting-started.md).
If you are here to **build on it**, start with [Architecture](Architecture.md).
If you are here to **change it**, start with [Specifications](Specifications.md).

---

## The one-paragraph version

Armada specializes a model two ways at once, and keeps them independent. A **Corpus** — ingested repos, docs, files — is chunked, embedded, and retrieved at agent time; that carries domain *knowledge*. A **LoRA Adapter** trained on instruction data carries domain *behavior*. An **Agent** is a YAML file binding a persona to a model, a corpus, a tool grant list, and a sandbox profile. Agents compose into **Teams** where a manager delegates to specialist workers. Every execution is a **Run**, which emits an append-only **Event** stream that is both the observability surface and the raw material for the next round of training.

---

## Pages

### Running it
| Page | What's in it |
|---|---|
| [Getting Started](getting-started.md) | Fresh install to first Run, model materialization, adding a GPU |
| [Configuration](Configuration.md) | Every config file and every knob |
| [Zero-Cost Operation](Zero-Cost-Operation.md) | What's free, what isn't, and both upgrade paths |

### Understanding it
| Page | What's in it |
|---|---|
| [Architecture](Architecture.md) | Five services, the plugin kernel, cross-service boundaries |
| [Concepts](Concepts.md) | Corpus, Adapter, ModelBinding, Agent, Team, Run, Event, Sandbox |
| [Invariants](Invariants.md) | The seven rules that hold across every spec |

### Changing it
| Page | What's in it |
|---|---|
| [Specifications](Specifications.md) | How specs are structured, requirement numbering, which spec owns what |
| [Contributing](Contributing.md) | Pipeline conventions, branch naming, the spec-first workflow |
| [Licensing](Licensing.md) | Proprietary posture, model-license constraints, what triggers obligations |

---

## Design commitments

These are not defaults you can drift away from. They are load-bearing.

**It costs nothing to run.** No step on the default path contacts a paid endpoint. A change that makes the default path require a key or a GPU is a regression, not a feature. See [Zero-Cost Operation](Zero-Cost-Operation.md).

**CPU-only is the target.** No service may require a GPU to start. A GPU makes training better; it is never required for anything to work.

**Single-operator, trusted-network, one host.** No authentication, no multi-tenancy, no hosted deployment. These are non-goals, not gaps. Do not expose Armada to an untrusted network.

**Success is never inferred.** A Run is `success` only when the agent explicitly reports it. Everything else terminates `incomplete`, `failed`, `cancelled`, `budget_exhausted`, or `no_progress`. This exists because trajectory training data is drawn only from successful runs — inferring success would train the next adapter on every run that failed to crash.

**Every Run terminates.** Four budgets plus a no-progress detector, checked before each Step and each tool dispatch. Not detected afterward — checked before, so a budget can never be exceeded.

---

## Prior art

Armada implements its own runtime. It does not depend on either project below.

**[DeepSeek Harness](https://github.com/deepseek-ai/dsh)** — a micro-kernel agent runtime where every runtime component is a swappable plugin, with Standard/Code/Minimal/Creator modes and an append-only event log. *Armada borrows:* the plugin decomposition, the Standard-vs-Code tool-calling split, and the event log as a first-class artifact.

**OpenClaw** (formerly Clawdbot/Moltbot) — a persistent background agent service whose central Gateway multiplexes WebSocket and HTTP on a single port and owns session lifecycle, tool dispatch, and orchestration. *Armada borrows:* the single-port gateway daemon shape and the model-agnostic adapter boundary.

**Why reimplement rather than depend?** Harness is in active preview and its extension contracts are documented as subject to breaking changes. Armada takes the architecture and accepts the build cost rather than the churn. This rationale is narrow and does not generalize — a component consumed across a *stable published HTTP interface* is a different case, which is why the [Colibri](Roadmap.md#colibri) evaluation reaches the opposite conclusion.
