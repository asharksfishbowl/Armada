# Configuration

Every file in `config/`. All are read at startup; invalid values fail startup with a non-zero exit rather than degrading silently.

| File | Owns |
|---|---|
| [`base-models.yaml`](#base-modelsyaml) | The curated model shortlist |
| [`models.yaml`](#modelsyaml) | Inference endpoints and concurrency limits |
| [`teacher.yaml`](#teacheryaml) | Distillation and judge-mode teacher — **the spend switch** |
| [`eval.yaml`](#evalyaml) | Evaluation gate mode and held-out split |
| [`eval-rubric.md`](#eval-rubricmd) | Pass/fail rubric text for judge mode |
| [`runtime.yaml`](#runtimeyaml) | Run budgets, ceilings, context management |
| [`sandbox-profiles.yaml`](#sandbox-profilesyaml) | Per-Run container profiles |
| [`plugins.yaml`](#pluginsyaml) | Which implementation backs each kernel interface |
| [`mcp-servers.yaml`](#mcp-serversyaml) | Available MCP servers |
| [`training-remote.yaml`](#training-remoteyaml) | Remote GPU provider |
| [`code-extensions.yaml`](#code-extensionsyaml) | Extensions treated as code when chunking |
| [`seed-corpora.yaml`](#seed-corporayaml) | Corpora created on first startup |

---

## base-models.yaml

The curated BaseModel shortlist. Keys per entry:

| Key | Notes |
|---|---|
| `id` | Unique. Embedded in every ModelBinding tag. |
| `hf_id` | HuggingFace repo, used by training and the eval gate |
| `backend` | Default `ollama`. Which inference server serves this entry. |
| `serving_ref` | Identifier the named backend uses. For `ollama`, the tag. |
| `context_window` | int |
| `chat_template` | `qwen3` \| `llama3` \| `gemma3` |
| `tool_format` | `json_schema` \| `hermes` |
| `quantization` | Applied on GGUF export at promotion |
| `min_ram_gb` | Compared against host memory at startup |
| `trainable` | `false` rejects a training run naming the constraint |
| `lora_target_modules` | list |
| `smoke_test` | Exactly one entry is `true` |

**Why `serving_ref` and not `ollama_tag`:** the shortlist is a curated list of *models*. A specific inference server's addressing scheme is a deployment detail and must not leak into it. `backend` is the discriminator that keeps that separation honest — `config/models.yaml` maps a backend name to its base URL, so a binding stays a logical reference and no endpoint URL is ever persisted.

Operators may append entries. Appended entries are validated against the same schema on startup.

---

## teacher.yaml

**This is where zero external spend is enforced.**

```yaml
enabled: false     # opt-in. While false, no outbound request is ever made.
provider: none     # none | local | remote — only `remote` spends money
```

`enabled: false` is not a placeholder. While disabled:

- `POST /datasets` naming a `corpus_id` returns HTTP 400 naming the teacher-free sources, **before any connection is attempted**
- `eval.mode: judge` fails startup naming both settings

| `provider` | Cost | Notes |
|---|---|---|
| `none` | — | Default. Distillation and judge mode both unavailable. |
| `local` | CPU time only | A model served by `armada-models`. Genuinely free, genuinely slow. |
| `remote` | **API spend** | External OpenAI-compatible endpoint. The only option that costs money. |

Also carries `distillation.max_chunks`, `distillation.pairs_per_chunk`, `distillation.entailment_check`, and `judge.max_eval_samples` (a hard bound on teacher spend per gate).

`api_key_env` is a variable **name**, never a value. Nothing reads a credential from this file.

---

## eval.yaml

```yaml
mode: mechanical    # mechanical | judge
eval_fraction: 0.1  # held-out fraction reserved by the split
```

| Mode | Metrics | Teacher required |
|---|---|---|
| `mechanical` | `held_out_perplexity` + `tool_call_validity` | no |
| `judge` | `task_success_rate` + `tool_call_validity` | yes |

Both modes generate completions **in-process**, not through Ollama. Two reasons, and neither is incidental: at gate time an unpromoted candidate has no GGUF and no Ollama tag, so generating through the model server is circular; and generating the baseline through Ollama would compare a quantized baseline against an fp16 candidate, letting the quantization delta swamp the adapter delta. The gate would measure the wrong thing and reject good adapters.

Perplexity is not computable through Ollama at all — it returns no per-token logprobs.

---

## runtime.yaml

Run budgets and their hard ceilings.

| Budget | Default | Ceiling |
|---|---|---|
| `max_steps` | 40 | 200 |
| `max_model_tokens` | 200,000 | 2,000,000 |
| `max_wall_clock_seconds` | 1,800 | 14,400 |
| `max_tool_calls` | 120 | 600 |

Plus `tree_budget_ceilings` for the two cross-Run budgets Team Orchestration defines, `no_progress_threshold` (default 3), `reserved_output_tokens`, `always_retain_messages`, and `max_tool_result_tokens`.

An Agent may lower a budget below the default but never raise one above its ceiling.

---

## sandbox-profiles.yaml

Per-Run container profiles.

| Key | Notes |
|---|---|
| `image` | Container image |
| `cpu_limit`, `memory_limit` | Resource caps |
| `network` | `none` \| `egress_allowlist` |
| `allowed_hosts` | Used when `network: egress_allowlist` |
| `read_only_root` | bool |
| `armada_tmpfs_size` | Default `64m` |
| `timeout_seconds` | Per tool call |

Every sandbox mounts a writable tmpfs at `/armada` regardless of `read_only_root`, so oversize tool results and Code-mode artifacts always have somewhere to go.

---

## models.yaml

Inference endpoint base URLs (keyed by backend name) and the scheduler's concurrency limits:

- `max_concurrent_per_tag` — default 1
- `max_concurrent_total` — default 2
- `code_mode_min_context` — default 16384

---

## plugins.yaml

Selects the implementation backing each kernel interface: `ModelAdapter`, `ToolProvider`, `SandboxProvider`, `RetrievalProvider`, `EventSink`.

A declared plugin that fails to load, or a required interface left unregistered, fails startup naming the plugin.

---

## mcp-servers.yaml

Per server: `name`, `transport` (`stdio` \| `http`), `command` or `url`, and `env_keys` — a list of environment variable **names** carrying credentials.

MCP credentials are read from those variables and never persisted to the database or written into an Event.

---

## training-remote.yaml

`provider`, `endpoint`, `api_key_env`, `gpu_type`, `max_runtime_minutes`.

Only consulted when a training run names `backend: remote`. The credential is read from the environment variable named by `api_key_env` and never from a file in the repo — if that variable is unset, submission fails immediately and **never transmits the dataset**.

---

## code-extensions.yaml

File extensions treated as code during chunking. Code chunks on function and class boundaries and never splits a function body; prose chunks on headings and paragraphs.

---

## seed-corpora.yaml

Corpora created on first startup so the shipped example Agents validate on a fresh install. Ships `frontend-docs` and `recipes`. Seeding is idempotent and never touches an existing Corpus.

A seeded Corpus has zero chunks, so the shipped Agents validate with a zero-chunk warning rather than failing — runnable immediately, with retrieval returning nothing until you add Sources and ingest.
