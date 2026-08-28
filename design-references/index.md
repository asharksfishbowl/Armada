# Armada — design references index

Read this file FIRST on restart or lost context. It records what exists here and what is
authoritative. It is an anchor of build-queue task **P9 — Dashboard core**.

**Server:** `http://DEX_HOST:8765/armada/` — port 8765 is shared with another project, which
holds the root paths; Armada is mounted under `/armada/`.

## The design is locked. Do not re-derive visual decisions.

`specs/dashboard/design-dashboard.md` is **complete and locked**: 202 requirements. It is the
single source of truth for every visual and interaction decision in `armada-dashboard`.

If an implementation question looks like a design question, it is answered in that spec. If it
genuinely is not, raise it — do not invent an answer here.

## Current palette: "Armada Oak" — MERGED

**Adopted 2026-08-27, merged 2026-08-28.** R2/R3 carry the ship-timber ramp. Recorded in the
spec at **R3a–R3d** and **R139/R139a**.

| Token | Value | |
|---|---|---|
| `--surface-0` | `#0E0A07` | tarred hull |
| `--surface-1` | `#17110B` | dark oak |
| `--surface-2` | `#1F1610` | oak plank |
| `--surface-3` | `#2B2016` | lit plank, hover |
| `--surface-4` | `#38291C` | selected plank |
| `--line` | `#33261B` | grain hairline |
| `--line-strong` | `#5A4128` | brass-warm seam |
| `--fg` | `#F2E8D8` | canvas |
| `--fg-muted` | `#B8A68C` | weathered rope |
| `--fg-dim` | `#85735E` | restricted by R140 |

**Scoped to one layer.** Status hues, the accent and its closed use list, the six marks, chip
anatomy, the flag-chip class, the five permitted alpha uses, motion, and all geometry are
unchanged. The status vocabulary is bit-for-bit identical to the pre-oak spec.

### Settled — do not relitigate

- **R3b — brass is never the accent.** `#C9A227` sits ~6° from `--status-warn`; `--accent`
  sits 179° away. Brass survives as structural chrome only, in `--line-strong` `#5A4128`.
- **R3c — `--status-neutral` `#8B96AC` stays as-is.** Now the only status hue in a different
  temperature family from its ground; reads as pewter against timber. Re-hueing it would touch
  R21, R23a, R26, R29 and R142a and needs its own amendment.
- **R3d — R14's `rgba(255,255,255,.04)` inner highlight stays achromatic** on the warm ground.
- **R139a — `--accent` on `--surface-3` is the tightest margin in the system at 4.97:1**, 0.47
  above the floor. It was also tightest on slate (4.91:1), so this is a property of the accent,
  not of the oak amendment. It is the token most likely to fail the R139 build test under any
  future change to `--accent` or `--surface-3`.

## Files here

| File | What it is | Authoritative? |
|---|---|---|
| `tokens-reference.html` | Live rendering of the **merged oak** tokens, the six marks, and all four status families. Computes R139 contrast and runs the R141/R142b desaturation test in-browser. Regenerated 2026-08-28; token values verified equal to the spec. | **No** — the spec is. An instrument for checking the build against it. |
| `playground-B.html` | **The locked mock. [LOCKED ★]** Cited by spec R3a as the provenance of the oak ramp. Carries a slate ⇄ oak toggle for comparison. | **No** — but do not delete; R3a names it. |
| `playground-A.html` | Four-preset exploration, pre-dates the design spec. Superseded. Retained as a record only. | No |
| `index.md` | This file. | — |

**Caveat on `tokens-reference.html`:** R6 specifies Inter and JetBrains Mono; neither is vendored,
so it falls back to system faces and type metrics do not match the real build. Use it for
**colour and geometry only** — never to judge type.

## Verified 2026-08-28

- All ten R2/R3 token values in `tokens-reference.html` compared programmatically against
  `design-dashboard.md`. **All match.**
- **R139 holds on oak.** All nine meaning-bearing tokens clear 4.5:1 against both `--surface-2`
  and `--surface-3`, by WCAG 2.1 relative luminance. `--fg-dim` measures 3.91:1 / 3.49:1 —
  below the floor by design, restricted by R140.

## Related

- `specs/dashboard/design-dashboard.md` — the design spec. Authoritative.
- `specs/dashboard/design-dashboard-oak-amendment.md` — the roundtable input document that
  produced R3a–R3d and R139a. Historical; the spec now carries the decisions.
- `build-queue.groovy` — P9 (Dashboard core), P10 (Run inspection), P11 (Training + adapters).
  P9's scope fence: **no TrainingPage, no adapter table, no capabilities call.** ModelsPage
  ships its BaseModel shortlist table only.
- `services/dashboard/public/index.html` — Phase 0 placeholder. **Still hardcodes the old slate
  palette** (`#0b0d10`, `#16191f`, `#e6e9ef`, `#8b93a1`, `#262b33`) while its own comment claims
  the colours are lifted from the design spec so the page "does not read as a different product
  from the one that replaces it." That claim is now false. Outstanding.
