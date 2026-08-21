# Third-Party Notices

Armada is proprietary (see [LICENSE](LICENSE)). It depends on, and is configured to retrieve, third-party components licensed separately by their copyright holders. This file inventories them and the obligations each carries.

**This is an engineering inventory, not legal advice.** Confirm anything consequential with counsel before distributing Armada, offering it as a service, or publishing a trained model.

---

## The short version

Every code dependency is compatible with proprietary use. **Two of the five shipped base models are not open source**, and one Python dependency is copyleft. Neither is a problem today, because obligations attach on **distribution** and Armada is currently single-operator and self-hosted. Both become live the moment you ship a model or offer the platform to anyone else.

| Risk | Component | Bites when |
|---|---|---|
| Naming + attribution | Llama 3.2 | You distribute a model trained on it |
| Use restrictions, terms pass-through | Gemma 3 | You distribute or provide access |
| Copyleft (LGPL-3.0) | `psycopg` | You distribute a modified psycopg, or statically link it |

---

## Base models

Configured in `config/base-models.yaml`. Armada does not vendor weights — it retrieves them at materialization time — but retrieval and use are still governed by these terms.

| Model | License | Open source? |
|---|---|---|
| `Qwen/Qwen3-0.6B` | Apache 2.0 | Yes |
| `Qwen/Qwen3-1.7B` | Apache 2.0 | Yes |
| `Qwen/Qwen3-4B-Instruct-2507` | Apache 2.0 | Yes |
| `meta-llama/Llama-3.2-3B-Instruct` | **Llama 3.2 Community License** | **No** |
| `google/gemma-3-4b-it` | **Gemma Terms of Use** | **No** |

### Llama 3.2 — the naming obligation is the sharp edge

The Llama 3.2 Community License is a custom license, not an OSI-approved one. Relevant terms:

- **Attribution.** Distributing the model or a derivative requires displaying *"Built with Llama"* on a related website, interface, documentation, or product page.
- **Derivative naming.** If you distribute a model you have trained on Llama, **its name must begin with "Llama"**.
- **Acceptable Use Policy** applies to all use.
- **700M MAU threshold.** Above that, a separate license from Meta is required.
- **Gated access.** The HuggingFace repo requires accepting terms before download.

**Concrete consequence for Armada:** a LoRA adapter trained on `llama-3.2-3b-instruct` is a derivative work. Armada's ModelBinding tag scheme is `armada/{base_model_id}-{corpus_name}-v{version}` — for a Llama-derived model that renders as `armada/llama-3.2-3b-instruct-mycorpus-v1`, which does **not** begin with "Llama". That is fine while you never distribute it. If you ever publish or ship a Llama-derived adapter, the distributed artifact's name has to satisfy the requirement.

### Gemma 3

Governed by Google's Gemma Terms of Use and Prohibited Use Policy. Also not open source. Key points: use restrictions apply; if you distribute the model or a derivative you must pass the same terms downstream and supply the use restrictions to recipients; Google reserves the ability to restrict uses it determines violate the policy.

### If you want this problem to go away

Ship only the three Qwen3 entries. Apache 2.0 imposes no naming, attribution-on-derivative, or use restrictions, and is unambiguously compatible with proprietary and commercial use. Dropping `llama-3.2-3b-instruct` and `gemma-3-4b-it` from `config/base-models.yaml` removes both obligations entirely, at the cost of shortlist variety.

Nothing in the platform depends on either: the smoke-test model is `qwen3-0.6b`, and the shipped example Agents bind base ModelBindings by `base_model_id`.

---

## Embedding model

| Component | License | Notes |
|---|---|---|
| `BAAI/bge-small-en-v1.5` | MIT | No restrictions. Runs locally on CPU; never leaves the host. |

---

## Python dependencies (`services/forge/requirements.txt`)

| Package | License | Notes |
|---|---|---|
| `fastapi` | MIT | — |
| `uvicorn` | BSD-3-Clause | — |
| **`psycopg`** | **LGPL-3.0** | See below |
| `psycopg-pool` | LGPL-3.0 | Same |
| `pyyaml` | MIT | — |
| `sentence-transformers` | Apache 2.0 | Requires NOTICE preservation |
| `pypdf` | BSD-3-Clause | — |

### psycopg is LGPL-3.0

The only copyleft dependency. LGPL permits use in proprietary software provided the library remains replaceable by the end user and you don't distribute a modified version under different terms.

In Python this is generally satisfied — `psycopg` is imported at runtime from site-packages, not statically linked, and a user can swap the installed version. **Do not vendor, fork, or patch psycopg**, and do not bundle it in a way that prevents replacement. If either becomes necessary, get advice first.

Training dependencies (`peft`, `trl`, `transformers`, `torch`) are Apache 2.0 / BSD-3-Clause and are added in the training phase.

---

## Node dependencies (`services/daemon/package.json`)

| Package | License |
|---|---|
| `pg` | MIT |
| `typescript` | Apache 2.0 |
| `@types/node`, `@types/pg` | MIT |

All permissive.

---

## Infrastructure

| Component | License | Notes |
|---|---|---|
| PostgreSQL | PostgreSQL License | Permissive, BSD-like |
| pgvector | PostgreSQL License | — |
| Ollama | MIT | Run as a separate service over HTTP |
| Docker images (`pgvector/pgvector`, `postgres`, `ollama/ollama`, `nginx`) | Various, permissive | Consumed as images, not derived from |

---

## Prior art — no license obligation

Armada **reimplements** rather than depends on both:

| Project | License | Relationship |
|---|---|---|
| DeepSeek Harness | MIT | Architecture influence only — micro-kernel plugin decomposition, Standard/Code mode split, append-only event log. No code used. |
| OpenClaw | — | Architecture influence only — single-port gateway shape. No code used. |

Architectural influence does not create a derivative work. No attribution is legally required; the [Home](docs/Home.md) page credits both anyway because it is accurate and useful.

---

## Colibri (planned — ISSUE #2)

| Component | License | Notes |
|---|---|---|
| [Colibri](https://github.com/JustVugg/colibri) | Apache 2.0 | Integrated as a sibling service over its HTTP gateway, not vendored |

Apache 2.0 is compatible with proprietary use. If Colibri source is ever included or modified rather than consumed over HTTP, its NOTICE file must be preserved and modifications marked. Consuming it as a separate process over an HTTP interface — the planned integration — does not create a derivative work.

**Colibri's MoE models carry their own licenses**, separate from Colibri itself. OLMoE and Qwen3-family MoE entries must be checked individually before being added to the shortlist.

---

## Maintaining this file

Update it whenever a dependency is added or a base model enters the shortlist. The check that matters for a new base model is simply: *is it Apache 2.0 / MIT, or is it a custom license?* If custom, read the naming, attribution, and downstream-terms clauses before adding it.
