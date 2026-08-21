# Invariants

Seven rules that hold across every spec. Changing one is a change to all of them.

---

### 1. Success is self-reported

Only an explicit `finish(success: true)` yields outcome `success`. Everything else terminates `incomplete`, `failed`, `cancelled`, `budget_exhausted`, or `no_progress`. No component ever infers success from termination.

**Why it matters:** `armada-forge` builds trajectory training datasets exclusively from Runs with `outcome: success`. Defaulting a merely-terminated Run to `success` would train the next Adapter on every run that failed to crash.

A Run terminated by budget, cancellation, or fault takes that outcome regardless of what the agent self-reported earlier.

### 2. References are pinned, never live

Agent and Team versions capture a resolved snapshot at save time. The runtime performs a **liveness check only** — it confirms the pinned binding tag still exists and is promoted; it never re-resolves.

**Why it matters:** a Run is reproducible against the exact definition that produced it. Promoting a new Adapter cannot silently change a running agent's behavior. Adopting one is an explicit `refresh-bindings` call that cuts a new version and reports what changed.

### 3. The sandbox boundary is one-directional

The daemon reaches into a sandbox. Nothing in a sandbox calls back out.

**Why it matters:** this is the reason Code mode is restricted to sandbox-local tools. A Code-mode program gets `shell`, `read_file`, `write_file`, `list_dir`, and `finish` — never MCP tools or `search_knowledge`, because reaching those would require an inbound channel into the daemon. The program communicates its result by writing a file the daemon reads after the process exits.

### 4. Corpora by `name`, models by `base_model_id` — both immutable

No definition file contains a generated uuid.

**Why it matters:** definition files are portable across installations and reviewable in a diff. A uuid in a YAML file is meaningless to a human and invalid on any other host.

### 5. Events are append-only and gapless per Run

`seq` is assigned by a transactional counter. No update, no delete.

**Why it matters:** the Event log is the audit trail *and* the training corpus. A mutable log is neither.

### 6. Every Run terminates

Four budgets plus a no-progress detector, checked **before** each Step and **before** each tool dispatch.

**Why it matters:** checked-before means a budget can never be exceeded, only prevented. Checked-after would mean discovering the overrun once you had already paid for it.

### 7. Zero external spend on the default path

No step on the default path contacts a paid endpoint. A default install is fully functional with no accounts, no credentials, no egress.

**Why it matters:** it makes Armada honestly self-hostable. A change that makes the default path require a key or a GPU is a regression, not a feature. See [Zero-Cost Operation](Zero-Cost-Operation.md).

---

## Two more that read like invariants

**No GPU-required code path in any default configuration.** A GPU makes training better. It is never required for anything to work.

**Smoke runs are never promotable.** By design, not by omission. A 0.6B model at 20 steps proves the pipeline; it does not produce a model worth serving. A smoke adapter is rejected before evaluation runs at all.
