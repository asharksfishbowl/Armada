# Design amendment: "Armada Oak" surface palette

**Status: ACCEPTED 2026-08-27 and folded into `specs/dashboard/design-dashboard.md` at Requirements 2, 3, 3a-3d, 139, 139a, and 140.** This document is retained as the rationale record; the design spec is authoritative. Contrast was independently recomputed on acceptance and every claim held.
**Amends:** `specs/dashboard/design-dashboard.md` Requirements 2, 3, and the informative
table under Requirement 139.
**Locked mock:** `design-references/playground-B.html` — `http://DEX_HOST:8765/armada/playground-B.html`
*(Per-user artifact, excluded by `.gitignore` and not present in a fresh clone. **This document is
the committed record of the decision** and is what `design-dashboard.md` R3a cites.)*
**Picked by:** the Director, 2026-08-27.

## What this is

`design-dashboard.md` was locked at 197 requirements when this was written; accepting it took the spec to 202. This document proposes a change to
**exactly one layer of it** — the surface, line, and foreground ramp — and states precisely
what must be re-verified before it lands. It exists so a roundtable does not have to
reconstruct the decision from a mock and a chat log.

The design spec's own Scope Boundary records that it was authored with no wireframe or mockup.
This amendment is the first change to it that originates from a visual artifact rather than
from the four implementable specs.

## Motivation

Operator-stated: Armada is a fleet, and the console should read as ship timber rather than as
generic slate. The name is doing work the palette was not.

This is an aesthetic motivation, not a functional defect. It is recorded as such — nothing in
the locked spec is wrong, and no requirement other than R2/R3 is deficient.

## The change

### Requirement 2 — surface elevation levels

| Token | Current | Proposed | Rationale |
|---|---|---|---|
| `--surface-0` | `#0A0C10` | `#0E0A07` | tarred hull — application background |
| `--surface-1` | `#10131A` | `#17110B` | dark oak — page and panel background |
| `--surface-2` | `#161A23` | `#1F1610` | oak plank — card, row group, table body |
| `--surface-3` | `#1E232E` | `#2B2016` | lit plank — row hover, editor gutter |
| `--surface-4` | `#272D3A` | `#38291C` | selected plank — selected row, menu, popover |
| `--line` | `#232936` | `#33261B` | grain hairline |
| `--line-strong` | `#323A4A` | `#5A4128` | brass-warm seam — section divider |

### Requirement 3 — foreground text ramp

| Token | Current | Proposed | Rationale |
|---|---|---|---|
| `--fg` | `#E6EAF2` | `#F2E8D8` | canvas |
| `--fg-muted` | `#9AA4B8` | `#B8A68C` | weathered rope |
| `--fg-dim` | `#6B7488` | `#85735E` | restricted by R140; below the floor by design |

### Requirement 139 — informative ratio table

The table is informative, not normative ("the test is the requirement"). Its values are
restated under **Verification** below and would be updated in place.

## What is deliberately NOT changed

This is the load-bearing half of the amendment. Every one of these stays exactly as ruled:

- **All six status hues** — `--status-live`, `--status-good`, `--status-neutral`,
  `--status-warn`, `--status-fault`, `--status-pending` (R21, R26, R29).
- **The accent and its closed use list** — `--accent` `#4C8DFF` on exactly four elements (R4, R5).
- **The six marks and the fill axis** (R19, R20), **chip anatomy** (R32), and the
  **achromatic flag-chip class** (R50a).
- **The five permitted alpha uses of a status hue** (R32d) and the 32c/32d split.
- **Motion and effects policy** in full (R12–R17), including the `rgba(255,255,255,.04)` inner
  top highlight of R14, which is achromatic and unaffected by a warmer ground.
- **All geometry** — spacing scale (R8), radii (R9), row heights (R10), type ramp (R7).

The status vocabulary is bit-for-bit identical. An operator who learned it on slate has
learned it on oak.

## Ruled against: brass as the accent

Brass is the obvious ship accent and was considered and rejected.

`#C9A227` sits **7° from `--status-warn` `#F2B33D`** on the hue wheel. R4 selects blue
*specifically* so that the accent "can never be confused with any status hue" — blue is 179°
away. A brass accent would render *this row is selected* and *the harness intervened* in
effectively the same colour, collapsing R4's stated rationale and, with it, R5's premise that
the accent is a closed signal for operator intent.

**Brass is retained as chrome only.** R32b puts structural chrome on the `--line` ramp and
reserves status hues for status, so a brass-warm `--line-strong` `#5A4128` is legal and is
where the proposal places it. Seams and fittings, never meaning.

## Verification

Computed by the WCAG 2.1 relative-luminance formula against the proposed
`--surface-2` `#1F1610` and `--surface-3` `#2B2016`. Not judged by eye.

| Token | Hex | on `--surface-2` | on `--surface-3` | R139 |
|---|---|---|---|---|
| `--fg` | `#F2E8D8` | 14.66:1 | 13.10:1 | pass |
| `--fg-muted` | `#B8A68C` | 7.51:1 | 6.72:1 | pass |
| `--fg-dim` | `#85735E` | 3.91:1 | 3.49:1 | restricted (R140) |
| `--accent` | `#4C8DFF` | 5.56:1 | 4.97:1 | pass |
| `--status-live` | `#38BDF8` | 8.30:1 | 7.42:1 | pass |
| `--status-good` | `#34D399` | 9.25:1 | 8.27:1 | pass |
| `--status-warn` | `#F2B33D` | 9.56:1 | 8.55:1 | pass |
| `--status-fault` | `#F26D6D` | 6.09:1 | 5.44:1 | pass |
| `--status-pending` | `#A78BFA` | 6.54:1 | 5.84:1 | pass |
| `--status-neutral` | `#8B96AC` | 5.98:1 | 5.34:1 | pass |

**R139 holds.** Contrast marginally improves over slate: `--accent` moves 4.91:1 → **4.97:1**.

`--fg-dim` measures below 4.5:1 on both surfaces, as it does on slate. This is by design and
is governed by R140, which restricts it to non-essential text and forbids it carrying status.

**`--accent` on `--surface-3` remains the tightest margin in the system at 4.97:1 — 0.47 of
headroom.** It is the token most likely to break the automated contrast test on either
palette. Any future adjustment to `--accent` or `--surface-3` must be re-measured.

## Open questions for the roundtable

1. **`--status-neutral` `#8B96AC` is a cool grey on a warm ground.** It passes contrast at
   5.98:1 / 5.34:1 and is unchanged by this amendment, but it is the one status hue that now
   sits in a different temperature family from its surface. Is that acceptable as-is, is it
   desirable (it reads as pewter/iron against timber), or should a warm neutral be evaluated?
   Changing it would touch R21, R23a, R26, R29 and R142a's cross-family identities, so it is
   explicitly **out of scope for this amendment** and would need its own.
2. **Does the R14 inner top highlight `rgba(255,255,255,.04)` still read as depth on oak,**
   or does a warm highlight suit the ground better? Achromatic is the safer default and is
   what the mock uses.
3. **Should `docs/` screenshots or any brand surface follow?** Out of scope here; flagged so
   the answer is deliberate.

## Downstream work if accepted

1. Amend `design-dashboard.md` R2, R3, and the R139 informative table.
2. Re-run the automated token contrast test (R139) and the per-family desaturation test
   (R141, R142b) against the new ramp. Both are P9 exit criteria.
3. Update `services/dashboard/src/styles/tokens.css` — a P9 anchor, not yet written.
4. **Update `services/dashboard/public/index.html`.** The Phase 0 placeholder hardcodes its own
   palette and its comment states the colours are lifted from the design spec *"so this page
   does not read as a different product from the one that replaces it."* If the spec moves to
   oak and the placeholder does not, that comment becomes false. Note it currently carries
   near-copies rather than the spec values — `#0b0d10` vs `--surface-0` `#0A0C10`, `#16191f`
   vs `--surface-2` `#161A23`, `#e6e9ef` vs `--fg` `#E6EAF2`, `#8b93a1` vs `--fg-muted`
   `#9AA4B8`, `#262b33` vs `--line` `#232936` — so this drift predates the amendment and
   should be corrected in the same pass.
5. Update `design-references/tokens-reference.html`, which currently renders the slate ramp.

No other file in the repository hardcodes a value from R2 or R3; verified by grep over the
ten affected hexes across the whole tree excluding `.git` and `design-references/`.
