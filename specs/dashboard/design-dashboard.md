# Spec: Armada Dashboard Design

## Overview
This spec defines the visual and interaction design language for `armada-dashboard`, the single-operator web UI for Armada. It establishes design tokens, a motion policy, a status vocabulary covering all three of Armada's status families, and the layout and interaction behavior of every dashboard surface enumerated by the four implementable specs. It is a design spec: it constrains what the UI looks like and how it behaves, not how the React code is structured.

## Goals
- Establish a complete, buildable visual identity from scratch — tokens, type, density, motion — with no adjectives left to interpretation.
- Make the platform's six cross-cutting invariants legible in the UI without a legend, so that an operator learns them by using the product.
- Keep a run's append-only event stream readable at 300+ events, and make the single failure inside it findable without scrolling.
- Express the manager/worker run tree without destroying the manager's own timeline.
- Anchor every validation error to a location in raw YAML, including errors whose field path does not exist in the operator's text.
- Make a long-running training run legible while nothing visibly changes, and make "stalled" distinguishable from "slow".
- Never present a degraded or incomplete view as a healthy one.

## Non-Goals
- Component API design, state management, file structure, build tooling, or test strategy. Those belong to the implementation spec.
- Any page, feature, or state beyond the Scope Boundary below.
- Authentication, authorization, multi-user, theming, or internationalization. Armada is single-operator on a trusted network.
- A light theme. See Requirement 1.
- Defining or altering any API endpoint. Where a surface requires an endpoint the four implementable specs do not define, this spec records it under Unresolved Dependencies and does not assume it into existence.
- Mobile or tablet layouts. The dashboard targets a desktop browser at ≥1280px viewport width.

## Scope Boundary

No wireframe or mockup exists for Armada. The scope of this spec is exactly the surfaces below and nothing else.

**Enumerated by the four implementable specs:**

| Surface | Owning spec |
|---|---|
| `services/dashboard/src/pages/CorporaPage.tsx` | Model & Training Pipeline |
| `services/dashboard/src/pages/TrainingPage.tsx` | Model & Training Pipeline |
| `services/dashboard/src/pages/ModelsPage.tsx` | Model & Training Pipeline |
| `services/dashboard/src/pages/AgentsPage.tsx` | Agent Definition R33 |
| `services/dashboard/src/components/AgentEditor.tsx` | Agent Definition R33 |
| `services/dashboard/src/components/AgentVersionHistory.tsx` | Agent Definition R33 |
| `services/dashboard/src/pages/TeamsPage.tsx` | Team Orchestration |
| `services/dashboard/src/components/TeamRunTree.tsx` | Team Orchestration R44 |
| Live run inspection over WebSocket | Agent Runtime R1, R6, R7 |

**Added deliberately during the design audit, approved by the Director:**

| Surface | Justification |
|---|---|
| `services/dashboard/src/pages/RunsPage.tsx` | `GET /api/runs` (Agent Runtime R3b) defines filters, `parent_run_id`, and cursor pagination that no enumerated surface consumed. |
| `services/dashboard/src/pages/RunDetailPage.tsx` | `TeamRunTree.tsx` is in the enumerated list and had no mount point; a completed run's event stream is otherwise unreachable because a WebSocket subscription needs a `run_id` the operator has no way to retrieve. |
| Run launcher modal | `POST /api/runs` (Agent Runtime R2) had no trigger surface. |
| Build-dataset modal | `platform-overview.md` MVP step 2 ("upload an operator-supplied JSONL") had no trigger surface. |

These four are surfacings of endpoints and flows the specs already define. Nothing else is added.

## Requirements

### Foundation — theme and surfaces

1. The dashboard ships exactly one theme, dark. No light theme, no theme toggle, no `prefers-color-scheme` branch. Rationale: a single-operator local ops console gains no user from a second theme and doubles the token surface and the visual QA matrix.
2. Five surface elevation levels are defined as CSS custom properties, and elevation is expressed by surface colour only. Box-shadow is never used to create elevation between page-level surfaces; it is reserved for overlays (Requirement 14).

| Token | Value | Use |
|---|---|---|
| `--surface-0` | `#0E0A07` | Tarred hull — application background |
| `--surface-1` | `#17110B` | Dark oak — page and panel background |
| `--surface-2` | `#1F1610` | Oak plank — card, row group, table body |
| `--surface-3` | `#2B2016` | Lit plank — row hover, editor gutter |
| `--surface-4` | `#38291C` | Selected plank — selected row, menu, popover body |
| `--line` | `#33261B` | Grain hairline |
| `--line-strong` | `#5A4128` | Brass-warm seam — section divider |

3. The foreground text ramp is exactly three tokens: `--fg` `#F2E8D8` (canvas), `--fg-muted` `#B8A68C` (weathered rope), `--fg-dim` `#85735E`.
3a. Requirements 2 and 3 are the **"Armada Oak"** surface ramp, adopted 2026-08-27. Its provenance, the full before/after token table, and the reasoning behind every decision below are recorded in `specs/dashboard/design-dashboard-oak-amendment.md`. That document is the citable record because it is committed; the mock it was derived from, `design-references/playground-B.html`, is a per-user artifact excluded by `.gitignore` and must not be cited as though it ships. The motivation is stated as aesthetic rather than corrective: Armada is a fleet and the console should read as ship timber. **The amendment is scoped to exactly one layer — surface, line, and foreground.** Every status hue (Requirements 21, 26, 29), the accent and its closed use list (Requirements 4, 5), the six marks and the fill axis (Requirements 19, 20), chip anatomy (Requirement 32), the flag-chip class (Requirement 50a), the five permitted alpha uses (Requirement 32d), the motion policy (Requirements 12–17), and all geometry (Requirements 7–10) are unchanged. **The status vocabulary is bit-for-bit identical: an operator who learned it on slate has learned it on oak.**
3b. **Brass was considered as the accent and is ruled against permanently.** `#C9A227` measures 6° from `--status-warn` `#F2B33D` on the hue wheel, where `--accent` `#4C8DFF` measures 179°. Requirement 4 selects blue specifically so the accent can never be confused with a status hue; a brass accent would render *this row is selected* and *the harness intervened* in effectively the same colour, collapsing Requirement 4's rationale and Requirement 5's premise. Brass survives as structural chrome only, in `--line-strong` `#5A4128`, which Requirement 32b permits because chrome is not status.
3c. `--status-neutral` `#8B96AC` is deliberately left unchanged and is now the only status hue in a different temperature family from its ground. It measures 5.98:1 and 5.34:1 on oak and passes comfortably; it reads as pewter against timber. Re-hueing it would touch Requirements 21, 23a, 26, 29, and the cross-family identities of Requirement 142a, so it is out of scope for a surface-layer amendment and requires its own if ever wanted.
3d. The `rgba(255,255,255,.04)` inner top highlight of Requirement 14 stays achromatic on the warm ground. Achromatic is the safer default, it is what the locked mock renders, and warming it would make the depth language ground-dependent for no gain.
4. Exactly one accent colour is defined: `--accent` `#4C8DFF`, `--accent-hover` `#6FA4FF`, and `--accent-wash` = `--accent` at 12% alpha. The accent is blue specifically so that it can never be confused with any status hue (cyan, green, amber, red, violet, slate). `--accent` and `--status-live` (Requirement 21) are deliberately different blues carrying different kinds of meaning: the accent signals operator intent — what is selected, focused, or primary — while `--status-live` signals machine activity. Neither value may be set equal to the other.
5. The accent appears on exactly these elements and nowhere else: primary buttons, the focus ring, the active navigation item, and the left edge of a selected row.
6. Two type families are used. `Inter` for all UI text. `JetBrains Mono` for every value an operator may need to copy, diff, or transcribe: identifiers, binding tags, field paths, YAML, event payloads, and numeric counters.
7. The type ramp is exactly six sizes, each with a fixed line height, and exactly three weights (400, 500, 600):

| Name | Size/line-height | Use |
|---|---|---|
| micro | 11/16 | Badges, `seq` numbers |
| mono-body | 12/18 | Monospace body text |
| body-sm | 13/20 | **Default table and event row text** |
| body | 15/22 | Prose, empty-state headline |
| section | 18/26 | Section title |
| page | 24/32 | Page title |

8. The spacing unit is 4px. The permitted spacing steps are exactly 4, 8, 12, 16, 24, 32, and 48. Values of 6, 10, and 14 are not permitted.
9. Corner radius is 6px for cards, inputs, and buttons; 4px for chips and badges; 10px for modals, drawers, and popovers; and `999px` exclusively for the status mark disc. No other radius value is used. Radius and blur are separate concerns: this grouping does not imply that a drawer is blurred, which Requirement 38a forbids.
10. Default row heights are: 32px for table rows, 28px for event rows in Comfortable density, 24px for tree child rows and version rows.
11. Every numeral that can change in place — token counts, step counts, wall-clock, percentages, `seq` — is rendered with `font-variant-numeric: tabular-nums` so that its width does not change as it updates.

### Motion and effects policy

12. The governing rule is stated and enforced as written: **motion and depth belong to state transitions and navigation chrome, never to streaming data.** Operationally, any element that can appear more than approximately twenty times on one screen, or that can be appended to at high frequency, receives zero entrance animation, zero box-shadow, and zero blur.
13. The second governing rule is: **if it moves, it is live.** Motion is a truth-carrier, not decoration. When a run, training run, or ingestion job reaches a terminal state, all motion on its surface stops within 200ms. The inverse is binding and is the mechanism behind Requirement 112.
14. The following surfaces carry motion or depth:
    - **Navigation:** the active-item indicator slides on `transform` over 180ms, `cubic-bezier(.2, 0, 0, 1)`.
    - **Panels and cards:** a 1px `--line` hairline plus `inset 0 1px 0 rgba(255,255,255,.04)`. That inner top highlight is the entire depth language for static surfaces.
    - **Overlays only:** modals and popovers use `backdrop-filter: blur(12px)` over `--surface-0` at 70% alpha. This is the only blur in the application.
    - **Live status surfaces** (run header, training run card, ingestion row): a status-tinted radial bloom behind the surface at 6–10% opacity, plus a 2px top-border shimmer sweep on a 2s linear loop. Both render **only** while the entity's status is running.
    - **Counters:** a 150ms crossfade on value change. No odometer roll, no digit animation.
    - **Focus ring:** 2px `--accent` at 40% alpha plus a 1px solid inner ring, applied instantly. The focus ring is never animated.
15. The following are forbidden:
    - Event stream rows: no entrance animation, no stagger, no per-row shadow, no height transition. Rows appear without animating. The sole exception is Requirement 16.
    - Table rows, tree rows, editor lines, and chips: no shadow and no transition other than `background-color 80ms`.
    - No page transition animation between routes. Navigation is instant.
    - No parallax, no scroll-reveal, no gradient text, and no blur or glass effect on any scrollable surface.
16. The single permitted event-row effect: the newest arriving event row renders a 600ms accent left-edge fade-out. Exactly one row carries this at a time. It marks position in a live stream; it is not decoration.
17. Under `prefers-reduced-motion: reduce`, the radial bloom and shimmer render as static fills, counter crossfades snap, and the rotating `◐` mark renders static. No information is lost in reduced-motion mode; the connection and liveness signals in Requirements 112 and 113 must remain readable from text and chrome alone.

### Status vocabulary — one system, three families

18. Status is encoded on three independent channels: **hue = valence**, **mark shape = kind of judgement**, and **fill = whether a verdict exists**. Colour is never the sole carrier of meaning (Requirement 141).
19. The fill axis is defined exactly once and applies to every status family: **filled (`●`) means a verdict exists; hollow (`○`) means the entity was stopped before a verdict could be reached; half-filled (`◐`) means a verdict is pending.** Fill has meaning only within the disc family. `▲`, `✕`, and `◌` are separate shape classes and carry no fill meaning.
20. Status marks are rendered as SVG geometry, never as font glyphs or Unicode text, so they remain legible at 12px and survive desaturation.
21. Run outcome marks are:

| State | Hue token | Hex | Mark | Chip label |
|---|---|---|---|---|
| running | `--status-live` | `#38BDF8` | `◐` rotating, 1.2s linear | `RUNNING` |
| `success` | `--status-good` | `#34D399` | `●` | `SUCCESS` |
| `incomplete` | `--status-neutral` | `#8B96AC` | `●` | `INCOMPLETE` |
| `budget_exhausted` | `--status-warn` | `#F2B33D` | `○` | `BUDGET` |
| `no_progress` | `--status-warn` | `#F2B33D` | `○` | `NO PROGRESS` |
| `cancelled` | `--status-neutral` | `#8B96AC` | `○` with a slash | `CANCELLED` |
| `failed` | `--status-fault` | `#F26D6D` | `▲` | `FAILED` |

22. The rotating `◐` on a running entity is the only rotating element in the application.
23. `incomplete` is filled because `finish(success: false)` is a verdict — the agent judged the task and reported that it did not achieve it (Agent Runtime edge 20a). `budget_exhausted` and `no_progress` are hollow because the harness stopped the run before any self-report (Agent Runtime R32, R33, edge 20d).
23a. There is no `--status-muted` token. `incomplete`, `cancelled`, and `rejected` all render in `--status-neutral` `#8B96AC` and are distinguished entirely by the fill axis of Requirement 19 and by their mandatory labels: `incomplete` is `●` (a verdict exists), `cancelled` is `○` with a slash (stopped before one), `rejected` is `●` (the gate judged). `--fg-dim` `#85735E` never carries status, per Requirement 140.
24. `incomplete` renders `--status-neutral`, not `--status-fault`. Agent Runtime edge 20a reserves `failed` for infrastructure faults; rendering a legitimate self-reported negative in the fault colour trains the operator to ignore the fault colour.
25. `budget_exhausted` and `no_progress` share a hue and a mark. They are distinguished by a **mandatory inline qualifier** appended to the chip, naming the cause the runtime is already required to record: `BUDGET · max_steps`, `NO PROGRESS · shell ×3`. The qualifier is not optional and is not a tooltip.
26. Adapter status marks are:

| State | Hue | Mark | Chip label |
|---|---|---|---|
| `pending_eval` | `--status-pending` `#A78BFA` | `◐` | `PENDING EVAL` |
| `promoted` | `--status-good` | `●` | `PROMOTED` |
| `rejected` | `--status-neutral` | `●` | `REJECTED` |

27. `pending_eval` uses `--status-pending` and the pending mark because Model & Training Pipeline R35 states that an absent judgement is not a failing judgement. It must not share a hue or a mark with `rejected`. `rejected` is filled and `--status-neutral` — the gate completed and returned a negative verdict — and is deliberately not `--status-fault`, because a rejected adapter is the gate working correctly.
28. An adapter row with status `pending_eval` is the only adapter row that renders a **Retry promotion** action, corresponding to `POST /adapters/{adapter_id}/promote` (Model & Training Pipeline R30a).
29. ModelBinding status marks are:

| State | Hue | Mark | Additional treatment |
|---|---|---|---|
| `promoted` | `--status-good` | `●` | none |
| `retired` | `--status-neutral` | `○` | the binding tag renders struck-through |
| `missing` | `--status-fault` | `✕` in a square | 2px `--status-fault` row edge and a persistent inline banner on the row |

30. `missing` is the only status in the entire product that is never an expected state — the database reports the binding as `promoted` while `armada-models` does not serve it (Model & Training Pipeline edge 15). It is therefore the only status that escalates beyond its own row: it raises a count badge on the Models navigation item. No other status raises a navigation badge.
31. The learnable rule is **two-part, and neither channel alone is the meaning: hue names the family, fill names the verdict, and they are read as a pair.**
    - **Hue** — red: fault · amber: the harness intervened · green: judged good · **neutral: judged not-good, or stopped — the non-alarming family** · violet: awaiting judgement · cyan: live. This bullet is the operator-facing mnemonic and is deliberately in plain English; the tokens it names are tabulated in Requirements 21, 26, and 29.
    - **Fill** — `●` a verdict exists · `○` stopped before one · `◐` a verdict is pending. `▲` and `✕` are fault shapes and carry no fill.
31a. Read as a pair, `--status-neutral` `●` (Requirement 21) means that something entitled to judge did so and returned a negative — `incomplete` and `rejected`. Neutral `○` means the entity was stopped or never started and nobody judged it — `cancelled`, a `retired` binding, and a queued delegation. These are two meanings stated by the pair, not four unrelated states sharing a hue, and together they are invariant 1 rendered.
32. A status chip is rendered as the mark, a 12% tint of its hue as background, the hue as text colour, and a text label. There is no filled-pill chip and there is no bare status dot anywhere in the product. The two exceptions to "no bare dot" are the minimap (Requirement 51), which is a spatial index rather than a status readout, and the service health strip of Requirement 35a, which is a spatial status index rather than a labelled readout.

32a. The same (hue, mark) pair may be reused across and within families. Ambiguity is prevented by three rules, all binding:
    1. **Every chip carries mandatory label text.** There is no bare mark, per Requirement 32.
    2. **States sharing a pair never co-occur in one column.** `cancelled`, `retired`, and a queued delegation belong to different families rendered in different tables.
    3. **Within a family, a shared pair is always resolved in words.** `budget_exhausted` and `no_progress` are both `--status-warn` `○` and are resolved by the mandatory qualifiers of Requirement 25. The rule is not that no two states share a pair; it is that a shared pair is always resolved in text.

32b. **Status hues encode status and nothing else.** Structural chrome — rails, borders, dividers, and indentation guides — uses `--line`, `--line-strong`, or the `--fg-*` ramp. A status hue never appears on chrome that does not represent a state.
32c. **Status hues in foreground.** A status hue used as a **mark, as text, or as a status-bearing border** appears only at its declared value. No dimmed, tinted, or alpha-modified foreground variant exists; emphasis varies by type weight and by mark, never by opacity. Requirement 139's ≥4.5:1 floor applies to foreground use only, because foreground use is what a contrast ratio measures. A dimmed foreground status hue would reopen from the other side the contrast hole that Requirement 140 closes.
32d. **Status hues in background and index.** A status hue may be alpha-modified in exactly these five uses and no others:
    1. Status chip background tint — 12% (Requirement 32).
    2. `error` notice background tint — 8% (Requirement 48).
    3. Live-surface radial bloom — 6–10% (Requirement 14).
    4. Minimap normal tick — 60% (Requirement 52).
    5. Minimap filtered-out tick — 25% (Requirement 58b).
    No sixth use may be added without amending this list.
32e. The split between Requirements 32c and 32d is not arbitrary: **nothing in the 32d class is a sole carrier of meaning.** Each is redundant with a foreground element in the same component — the chip tint sits beneath the chip's own mark and label; the `error` tint beneath a `--status-fault` `▲` and `--status-fault` text; the bloom beneath the status chip it echoes; and minimap ticks encode severity as width per Requirement 52, with hue as reinforcement only. Because nothing must be read off them, no contrast floor applies. Desaturating every item in the 32d class loses no information, which is what Requirement 141 asserts and what the desaturation test of Requirement 142b checks.
32f. Any new use of a status hue must be classified as Requirement 32c or Requirement 32d before it is added. A use that fits neither — a status hue at partial opacity that is nonetheless the sole carrier of its meaning — is a design defect rather than a token exception, and is corrected by adding a foreground mark, not by amending the 32d list.
32g. **Normative requirements name tokens.** Plain-English colour words appear in a Requirement only inside explanatory rationale, never as an instruction. The Data Flow, Edge Cases, and Acceptance Criteria sections describe observable outcomes for a human verifier and therefore use plain-English colour words throughout; each resolves to the token named by the Requirement it verifies.

### App shell and navigation

33. The shell is a fixed 200px left navigation rail against `--surface-1`, not a top bar.
34. Navigation destinations are ordered to teach the platform's pipeline: **Corpora → Training → Models → Agents → Teams → Runs.**
35. The active navigation item is marked by a 2px accent left edge plus `--accent-wash` background, with the indicator sliding per Requirement 14.
35a. The navigation rail carries a **service health strip** of exactly three dots: `daemon`, `forge`, `models`. It is 8px dots at 8px gap; hover reveals an 11px label, and the strip is one tooltip target listing all three with their last-checked time.
35b. Health dot marks reuse the locked vocabulary and introduce none: `--status-good` `●` reachable, `--status-fault` `▲` unreachable, and `◌` unknown, reusing the connection mark of Requirement 114 for the pre-first-response and failed-probe states. `◌` remains a connection mark rather than an outcome, which holds here because the strip is chrome and not a list.
35c. There are three dots rather than five. A `db` dot could only ever mirror `daemon` — a daemon answering `GET /api/health` has a reachable database by definition — and `sandbox` has no persistent process to be up or down, Docker availability being a daemon-health property. A dot that cannot independently change state is decoration wearing a status mark, and is rejected for the same reason Requirement 57c rejects a filter chip for a family with no events.
35d. The health strip raises **no** navigation badge. A `missing` ModelBinding remains the only status that escalates to the navigation rail, per Requirement 30.
36. The content area is a single column with a page header (page title, entity count, primary action button), a filter row, and the page body.

### List and detail pattern

37. Every list page uses one repeated pattern: a header, a filter row, and a 32px-row table.
38. Selecting a table row opens a 480px right-hand **detail drawer that overlays the list**, not a route change. The list remains visible and its scroll position is preserved. The drawer closes on `Esc` and on an explicit close control.
38a. **Modals block; drawers do not.** Blur plus the 70% `--surface-0` wash of Requirement 14 is the "deal with this before continuing" treatment and is reserved for modals and popovers. A drawer is additive detail: the list behind it stays fully legible, fully scrolled, and **fully interactive**. There is no scrim and no blur behind a drawer.
38b. Drawer separation is carried entirely by the drawer's own surface — `--surface-2` over the page's `--surface-1`, a 1px `--line-strong` left edge, and a left-edge shadow. That shadow is the only shadow outside a modal or popover, consistent with Requirement 2 reserving shadow for overlays.
38c. Because the list stays interactive, **clicking another row swaps the drawer's contents rather than closing the drawer.** An operator comparing several adapters never closes and reopens. This is the behavioural reason there is no scrim.
39. The drawer is used rather than a route because every entity in Armada is inspected while something else is running; navigating away destroys that context.
40. There are exactly two kinds of exception that are full-width routes rather than drawers: **editor routes** and **run inspection** at `/runs/:runId`. The editor routes are enumerated in Requirement 40a. `AgentEditor` is a route because a YAML editor plus a 320px problems panel does not fit in 480px.
40a. The editor routes are exactly four: `/agents/:agentId/edit`, `/agents/new`, `/teams/:teamId/edit`, and `/teams/new`. They are routes rather than drawers because a YAML editor plus a 320px problems panel does not fit in 480px.
41. Destructive actions never appear as row-hover icons. Every destructive action lives in the detail drawer footer or behind an explicit overflow control, so that the operator is looking at the entity's detail when triggering it (Requirement 99).

### Event stream

42. The event stream renders as a **rail**, not a log: a fixed 56px left gutter carrying the event `seq` (micro type, `--fg-dim`) and the event's type mark, with a 1px vertical rail line separating the gutter from content, so the eye tracks a single vertical axis.
43. Events are not rendered as peers. The default grouping unit is a **Step block** with a header reading `Step 3 · 4 tools · 1.8k tok · 12.4s`, containing that Step's `model_request`, `model_response`, `tool_call`, and `tool_result` events.
44. Default render state per event type:

| Event type | Default state | Render |
|---|---|---|
| `run_start` | expanded | Agent name and version, pinned `binding_tag`, mode, `workspace_path`, effective budgets, resolved tool list |
| `user_message` | expanded | Full text, accent left border |
| `model_request` | rail line | `→ {tag} · {prompt_tokens} tok · queued {queued_ms}` |
| `model_response` | expanded | Response prose; token counts right-aligned |
| `reasoning` | **collapsed** | `reasoning · {tokens} tok ▸` |
| `tool_call` | header expanded, arguments collapsed | Tool name plus first 80 characters of arguments; `▸` reveals full JSON |
| `tool_result` | collapsed when `is_error` is false; **expanded when `is_error` is true** | See Requirements 47–49 |
| `retrieval` | collapsed | `retrieval · k={k} · {n} chunks · top {score}`; expands to the chunk list with fused scores and `source_path` |
| `compaction` | full-width divider | `─── compacted {messages_compacted} msgs · {tokens_before} → {tokens_after} tok ───` |
| `mode_downgraded` | expanded | `--status-warn` notice naming the reason and every excluded MCP tool |
| `mcp_unavailable` | expanded | `--status-warn` notice naming the server |
| `delegation` | expanded | Rendered by the delegation group, Requirements 67–69 |
| `error` | expanded | Full-width `--status-fault` notice, Requirement 48 |
| `run_end` | expanded | Terminal card: outcome chip with qualifier, `result`, and a budget counter bar |

45. `reasoning` is the only event type collapsed by default purely on volume grounds: it is the highest-volume, lowest-operator-signal type in the stream.
46. `queued_ms` is rendered on a `model_request` only when its value is greater than zero, and renders in `--status-warn` when it exceeds 1000ms.
47. A `tool_result` with `is_error: true` is marked by geometry and a hairline only: the gutter mark becomes a `--status-fault` `▲`, the row receives a 2px `--status-fault` left border, and the label reads `tool_result · error`. It remains inside its Step block at normal row height and has no tinted background.
48. An `error` event renders as a full-width notice that **breaks the rail** — it sits outside the Step indentation and carries a `--status-fault` background tint at 8% alpha. It is the only **event block** in the stream with a tinted background. Status chips are inline elements carrying the 12% tint of Requirement 32d item 1 and are a different class; the claim was never about them.
48a. The positive rule that makes Requirement 48 load-bearing: **no other event block, Step block, or stream row has a background fill of any kind.** Row hover uses `--surface-3` and row selection uses an accent left edge; neither is a tint. This is what makes the full-width `--status-fault` notice singular at a glance.
49. The distinction in Requirements 47 and 48 is load-bearing and must be preserved: **an inline red hairline means the agent was told no and the loop continues** (Agent Runtime R29, R30, Team Orchestration R16 — all expected and recoverable); **a full-width tinted red notice means the harness broke.**
50. `tool_result` flags render as **flag chips** after the label. `truncated` expands to reveal `/armada/tool-results/{event_id}.txt` with the copy affordance of Requirement 143. `cancelled` renders as a flag chip.
50a. A **flag chip is a separate, achromatic visual class** from a status chip and never uses a status hue:

| | status chip | flag chip |
|---|---|---|
| background | status hue at 12% alpha | `--surface-3` |
| text | the status hue | `--fg-muted` |
| mark | SVG status mark | none |
| case | as specified per family | lowercase, monospace, 11px |

50b. The class exists to resolve a real collision: the `tool_result` flag `cancelled` and the run outcome `CANCELLED` are the same word naming two different concepts. As achromatic lowercase monospace without a mark, the flag is unmistakable for the outcome chip.
51. A **minimap** runs down the right edge of the stream at 8px wide, one tick per event, coloured by event family.
52. Minimap severity is encoded **outward, not inward**: a normal tick is inset at 4px wide, centred, at 60% opacity; a fault tick spans the full 8px rail at 100% opacity. Severity therefore survives both bucketing and desaturation.
53. When the event count exceeds the minimap's pixel height, the minimap buckets at `ceil(eventCount / railHeightPx)` events per row, with a minimum rendered tick height of 2px. A tick is never sub-pixel.
54. A minimap bucket takes its colour and width from its **highest-severity member, never its modal member.** Severity order is: `error` > `tool_result` with `is_error: true` > `--status-warn` notice (`mode_downgraded`, `mcp_unavailable`, `compaction` with `summarized: false`) > all others. A bucket of forty events containing one `error` renders as an error bucket.
55. Above approximately 2000 events the minimap renders fault ticks only, plus a dim density wash for all other events. Density ceases to be informative at that scale; fault position does not.
56. Finding a fault must never depend on hitting a 2px target. The stream header renders a fault count (`3 faults`) with previous/next fault jump controls, bound to keyboard `n` and `Shift+N`. Because Requirement 56b places faults outside the filter system, the filtered and unfiltered fault sets are identical by construction and a jump target can never have been filtered out.
56a. **Five of the fourteen event types sit outside the filter system entirely. No toggle exists for them and they always render:**

| Type | Reason |
|---|---|
| `run_start` | skeleton — a stream that can hide its own start is a fragment |
| `user_message` | skeleton — it is the boundary that defines a Turn |
| `run_end` | skeleton — it carries the outcome |
| `error` | fault |
| `tool_result` where `is_error: true` | fault, reached by payload flag rather than by type |

56b. The guarantee is therefore one sentence: **a filter can never remove the skeleton or a fault.** Everything establishing what run this is and how it ended, and everything reporting that something went wrong, is unhideable. Filters only ever subtract detail.
57. A pinned filter bar sits above the stream with event-family toggles carrying live counts. All families default to on; `reasoning` defaults to on-but-collapsed per Requirement 45.
57a. The nine remaining types map to **seven** filterable families:

| Family | Types |
|---|---|
| `Model` | `model_request`, `model_response` |
| `Reasoning` | `reasoning` |
| `Tools` | `tool_call`, and `tool_result` instances where `is_error` is false |
| `Retrieval` | `retrieval` |
| `Context` | `compaction` |
| `Notices` | `mode_downgraded`, `mcp_unavailable` |
| `Delegation` | `delegation` |

57b. `Reasoning` is its own family rather than part of `Model`. It is the highest-volume, lowest-signal type in the fourteen and the one an operator most wants to suppress wholesale — but suppressing it inside `Model` would take `model_response` with it, which is the thing being read. Folded in, the toggle is useless; separate, it is the most-used control on the bar.
57c. The `Delegation` chip renders only when the run has at least one `delegation` event, so an ordinary run shows six chips and a team run shows seven. No dead controls.
57d. Because `delegation` fires **twice per child** — once at creation and once at termination (Team Orchestration R42) — the `Delegation` toggle moves **both instances of every pair together**. A filtered stream can never show a child starting and never ending. It is the only type in the fourteen that fires in pairs.
57e. The `Delegation` toggle scopes to the **in-stream delegation group only**. The sticky roster strip of Requirement 69 is chrome rather than stream and sits outside the filter system entirely, so an operator who filters delegations out of the timeline still sees every child's state in the run header. The filter controls the narrative, never the inventory.
57f. **Filter family is determined by event type alone. Severity class is determined by type plus payload. The two axes never interact.** `compaction` is always in `Context` regardless of payload, while its severity is normal when `summarized: true` and an amber notice when `summarized: false`; a `summarized: false` compaction is still hidden by the `Context` toggle. **Amber is filterable; only faults are not.** The same split governs a `model_request` with `queued_ms` above 1000ms, which renders amber but stays in `Model`, and a `retrieval` with `chunks_dropped` above zero, which renders an amber qualifier but stays in `Retrieval`. Requirement 54's severity order governs minimap bucketing and render loudness; this requirement's families govern visibility; neither reads the other.
57g. **Faults are not filterable and sit outside the filter system entirely. Filters are subtractive over non-faults only.** No filter state can remove a fault from the stream. This is stated once at the filter level rather than per-family because the two faults are reached through different mechanisms: `error` is an event type while `is_error` is a payload flag on `tool_result` (Agent Runtime R55).
57h. Concretely: **`error` belongs to no family and has no toggle**, and always renders. **A `tool_result` with `is_error: true` survives suppression of `Tools`** — switching `Tools` off hides `tool_call` and ordinary `tool_result` rows while error results remain, rendered per Requirement 47.
57i. The filter bar carries a static dim label reading `faults always shown`, so the guarantee is visible rather than discovered. A control must never imply a power it does not have.
58. The filter bar carries a single-click **Errors only** toggle that reduces the stream to `error` events, `tool_result` events with `is_error: true`, and a `run_end` whose outcome is not `success`. It is the clean inverse of the family toggles rather than a special case: families subtract non-faults, Errors only subtracts everything except faults.
58a. Under **any** active filter, not only Errors only, a Step block containing no matching events is **removed entirely** rather than rendered as an empty collapsed header; a column of empty headers reintroduces the log wall through the filter. In its place, between surviving Steps, the stream renders a 1px dim rule with an inline count in the form `··· {n} steps hidden ···`, which is clickable to expand that span back in place. Because Requirement 56b makes a fault unfilterable, **a hidden span provably cannot contain a fault**, so the count never conceals one.
58b. **The minimap always indexes the unfiltered stream.** Filtered-out non-fault ticks drop to 25% opacity; they are never removed and the minimap never reflows. **Fault ticks never dim**: they retain full-rail width and 100% opacity in every filter state, so Requirement 54's highest-severity-wins bucketing holds unconditionally. A minimap whose geometry changes when a filter is toggled destroys the spatial memory that is its entire reason for existing.
59. The stream header carries collapse-all and expand-all controls that operate on Step blocks.

### Team run tree

60. `TeamRunTree` renders child runs in exactly three states, each with different available data. The states are derived, not reported:

| State | Derived from | Available data | Render |
|---|---|---|---|
| queued | a manager `tool_call` for `delegate` with no matching `delegation` event | worker string and task text only | 24px row, `--status-neutral` `○`, label `QUEUED`, alias plus truncated task, and `waiting for a slot · {n} of {max} busy`. **No expander.** |
| running | the first `delegation` event, which carries `child_run_id` | `child_run_id`, worker alias, resolved `agent_version_id`, start time | `--status-live` `◐`, elapsed wall-clock computed client-side from the event timestamp |
| terminated | the second `delegation` event | `outcome`, token count, step count | outcome chip, tokens, steps, wall-clock; expandable |

61. A queued delegation has no `delegation` event at all (Team Orchestration R42 and data flow steps 8–9 append it only when a child Run is created). Its only artifact is the manager's `tool_call`. The queued row therefore has no expander, because there is no run to open.
62. A collapsed running child row shows elapsed time only and opens **no WebSocket connection**. Rendering twelve collapsed children opens zero connections.
63. A child's event stream is subscribed **lazily, on expand**, and unsubscribed on collapse. Child event streams are not interleaved into the parent's stream (Team Orchestration R43).
64. The tree header carries a `live counters` toggle, **default off**, which subscribes to every currently in-flight child so their token and step counters update live. Because in-flight children are bounded by `limits.max_concurrent_delegations` (default 2), this cannot fan out without bound.
65. Expansion is **inline and bounded**, not split-pane and not a route replacement. The parent's timeline is the spine of the view and losing it loses causality; nesting an unbounded child stream inside it destroys the parent. An expanded child renders a child pane with `max-height: 480px`, its own scroll, its own minimap, and its own filter bar, indented 24px behind a `--line-strong` rail. The containment rail is structure, not status: the child's state is carried by its chip, and a status hue on the rail would assert a meaning the rail does not have.
66. Child expansion is an accordion: exactly one child pane is open at a time. The child pane header carries an `open full` control routing to `/runs/{child_run_id}`, so the escape hatch exists without making a route change the default.
67. Multiple delegations dispatched in one manager Step do not render as N inline events. They collapse into a single **delegation group block** with a summary header of the form `delegated ×12 · 9 success · 2 incomplete · 1 failed · 84.2k tok · 6m12s`, containing 24px child rows.
68. Delegation group rows are ordered by dispatch order (the manager's `tool_call` `seq`) and **never re-ordered by completion.** A terminated child keeps its original slot. Re-sorting rows as results arrive is unreadable under a live stream.
69. `TeamRunTree` mounts in exactly two places with the same rows and the same state machine: as the in-stream delegation group at the timeline position where the delegations were dispatched, and as a sticky roster strip in the run header showing one 24px row per child, always visible.

### AgentEditor and validation errors

70. The editor renders exactly **two severities**: **error**, which blocks save (Agent Definition R11 closed-schema violations and R13–R21 unresolvable references), and **warning**, which does not (R16 zero-chunk corpus and R16b Code mode with MCP servers).
71. The "valid alternatives" that Agent Definition R11, R17, R18, and R20 require each error to name is **not a third severity**. It is a fix affordance layered onto an error and renders as clickable suggestion chips (Requirement 78).
72. Warnings persist beyond the edit session. Because Agent Definition R24 captures `warnings` onto the `resolved_snapshot`, the same `--status-warn` chips render in `AgentVersionHistory` for the version that was saved under them.
73. Validation errors carry a field path and valid alternatives but **no line or column number**. Mapping a field path to a line in the operator's text is performed client-side against a locally parsed YAML CST.
74. When a field path maps to a node in the CST, the editor renders a `--status-fault` squiggle under the offending token, a gutter marker carrying the error's index, and a bidirectional hover link between the token and its entry in the problems panel.
75. When a field path does not map to a node, the editor handles exactly three sub-cases:
    1. **Missing required key.** Anchor to the parent container's line; at document root, anchor to line 1. Render a dimmed, italic, non-editable **phantom line** at the insertion point reading the key and a `← required` annotation, in `--fg-dim`. Clicking the phantom line inserts the key.
    2. **The document does not parse as YAML.** No CST exists and the server never received valid YAML. Collapse the problems panel to a single `--status-fault` banner carrying the parser's own line and column, and **suppress all stale server errors**, which would otherwise be rendered against text that no longer exists.
    3. **The path resolves inside a flow-style node** (for example `tools: {builtin: [shell]}`). Anchor to the flow node's line and highlight the entire node. Sub-token precision is not recoverable, and a wider highlight is preferable to a falsely precise one.
76. The full error list lives in a **persistent 320px right-hand problems panel**, always present and never a popover, grouped by severity and then by field path. Its header reads a count in the form `3 errors · 1 warning`.
77. Each problems-panel entry renders the severity mark, the field path in `JetBrains Mono`, the message, and the valid alternatives.
78. Valid alternatives render as clickable chips that write the chosen value into the document at the error's anchor.
79. Save is disabled while the error count is greater than zero. When only warnings remain, save is enabled and its label renders in `--status-warn`, so that saving with warnings is a visible decision rather than an invisible default.
80. Because Agent Definition R12 returns every error at once, the problems panel replaces the whole set atomically, with a single 120ms crossfade on the panel container. Individual entries never animate and squiggles never animate.
81. Validation is requested on a 600ms idle debounce, on editor blur, and on an explicit save keystroke.
82. There is one `YamlEditor` component. `AgentEditor.tsx` and `TeamEditor.tsx` are thin wrappers supplying exactly three things: the schema, the validate endpoint, and the save endpoint. Because `POST /api/teams/{team_id}/validate` exists and mirrors the agent endpoint including full-error-list responses and no persistence on failure (Team Orchestration R39), teams receive identical debounced live validation, atomic full-set replacement, two severities, and suggestion chips. No save-only fallback exists or is needed.
82a. A brand-new entity has no id, and therefore no validate endpoint to call. On `/agents/new` and `/teams/new`, client-side YAML parse errors and the missing-required-key phantom lines of Requirement 75.1 render live, while every server-resolved error — corpus existence, MCP server names, sandbox profile, budget ceilings, binding resolution — first appears on the initial save attempt, which returns HTTP 400 with the full error list (Agent Definition R27) into the same problems panel in the same format. Once the entity has an id, live validation engages. **The panel's appearance never differs between the two states; only its update timing does.**

### Training progress

83. A training run renders a **stage rail** above its detail, with five segments: `Dataset → Split → Train → Evaluate → Promote`. Each segment carries a mark from the shared status vocabulary. Exactly one segment is `◐` at a time, and segments after the active one render as `--fg-dim` outlines.
84. The stage rail is the mechanism by which a `succeeded` training run is not read as a finished pipeline: on `succeeded`, the `Train` segment fills `--status-good` and the `◐` moves to `Evaluate`, leaving two visibly incomplete segments ahead.
85. Evaluate segment states map to the evaluation gate exactly: gate completed and passed renders `--status-good` `●`; gate completed and did not pass renders `--status-neutral` `●` (a verdict exists and is negative, matching Requirement 27); **gate did not complete renders `--status-pending` `◐` and the rail does not advance**, with a `--status-warn` sub-label naming the reason and the `judge_errors` count (Model & Training Pipeline R35, edges 19 and 20).
86. When registration fails after a passing evaluation (Model & Training Pipeline edge 14), the `Evaluate` segment stays `--status-good` `●` and the `Promote` segment renders a `--status-fault` `▲` carrying a **Retry promotion** action.
87. When the training run's `run_kind` is `smoke`, the `Promote` segment renders greyed with a lock and the label `not promotable · smoke` **from the first frame**, because `run_kind` is known at launch (Model & Training Pipeline R24, R37). An operator is never shown a promotion path that cannot be reached.
88. A determinate job never renders an indeterminate spinner. Training progress renders a bar driven by `progress_steps / total_steps` plus a percentage.
89. The load-bearing element of a long-running training card is a live-ticking **`last update {duration} ago`**. It is the only element that distinguishes a slow run from a stuck one and no other element substitutes for it.
90. Staleness escalates in colour and in words against the observed median update interval: below 2× renders `--fg-dim`; above 2× renders `--fg`; above 5× renders `--status-warn` and reads `no progress reported in {duration}`. There is no popup, no alert, and no sound. This is the only place where amber means "possibly stuck", and it says so in text so the meaning is not inferred.
91. An estimated completion is derived from the step rate over the last ten updates, rendered as a **range** labelled `est.`, and suppressed entirely until at least five updates exist. A countdown that cannot be trusted is not rendered.
92. The shimmer of Requirement 14 continues for the duration of a running training job, discharging the role a spinner would otherwise play without falsely implying an indeterminate job.
93. The nullable `message` field (Model & Training Pipeline R23) renders as one truncated monospace line beneath the progress bar. It is backend chatter, not a log surface.
94. A training run card is fully self-describing when cold: `started_at` in both absolute and relative form, backend, `run_kind`, `base_model_id`, and `dataset_id`. Nothing about an hours-long run may live only in session state.

### Empty and first-run states

95. An empty state names the next action and the upstream entity blocking it. It renders one `body`-size line stating what is true, one `body-sm` `--fg-muted` line stating why, and one primary action. No illustrations. A disabled primary action **always** renders its reason inline next to it; a disabled-and-silent control is not permitted.
96. Empty states form a directed graph back to Corpora, so that an operator can walk backwards from any blocked page to the real blocker.
97. Per-page first-run states on a fresh installation are:
    - **Corpora** — not empty. Agent Definition R36 seeds `frontend-docs` and `recipes` with zero Sources. The chunk-count cell of each row renders `0 chunks` in `--status-warn` at type weight 400 with an inline `Add source` action. A hint bar above the table reads that seeded corpora exist with no sources, and that retrieval returns nothing until a source is added and ingested.
    - **Training** — empty. Headline `No training runs.`, sub-line directing the operator to build a dataset from a corpus. The primary action is disabled while no corpus has chunks, with the reason rendered beside it and linking to Corpora.
    - **Models** — never empty. Model & Training Pipeline R4a registers one base binding per shortlist entry at startup, so the BaseModel table is populated on first load. The Adapters table is empty with a sub-line stating that adapters come from training runs and that local smoke runs are never promotable.
    - **Agents** — two rows, each carrying a warning count of 1. A hint bar states that both shipped agents validate with a zero-chunk corpus warning, that they run, and that retrieval returns nothing, linking to Corpora.
    - **Teams** — empty with the primary action **enabled**, because both shipped agents declare `capabilities` (Agent Definition R34, R35) and a valid team is therefore constructible on a fresh installation.
    - **Runs** — empty. Headline `No runs yet.`, sub-line directing the operator to start one from an agent or a team.
98. `RunDetailPage` before its first event is not an empty state. `run_start` is `seq` 1 and arrives immediately; the page renders a skeleton and shows a `connecting…` label only after approximately one second.

### Destructive actions

99. Confirmation is proportional to reversibility, and **every confirmation dialog states what survives, not only what is destroyed.** A `Retained:` section is a required part of the dialog template, because surprise about soft deletion comes from silence about survivors.
100. **Delete agent** uses a plain confirm. The dialog states: removed — the agent from list views; retained — all versions and all historical runs, still viewable in Runs (Agent Definition R26); breaks — every Team referencing this agent will fail validation (Team Orchestration R6), listed by name.
101. **Delete corpus** requires typing the corpus name to confirm. The dialog states: deleted — the corpus and its chunks; retained — adapters trained from this corpus keep serving and their binding tags are unaffected (Model & Training Pipeline edge 16); breaks — every agent whose `corpus.name` matches, listed, which will fail validation on next save or refresh, while runs against already-pinned versions still start and simply retrieve nothing (Agent Definition edge 12).
102. **Delete team** uses a plain confirm. The dialog states: deleted — the team definition; retained — every member agent and every run the team produced.
103. **Cancel run** uses a plain confirm framed in mechanics rather than in doubt. The title reads `Cancel this run?` and the body states, in operator language, that the in-flight tool is killed, the sandbox destroyed, and the run recorded with outcome `cancelled`, and that cancelled runs are never used as training data (Agent Runtime edge 21, invariant 1). For a team run the dialog additionally states the number of in-flight child runs that will also be cancelled (Team Orchestration R23).
104. There is no undo and no undo-bearing toast. These actions commit immediately, and an undo window that does not exist must not be implied.
105. Cancel is not rendered on a terminal run. If a cancel request races a termination and returns HTTP 409 (Agent Runtime edge 16), the result renders as an inline toast naming the existing outcome, not as an error modal.

### Version pinning

106. A **version pin badge** renders in monospace with a border in exactly three variants, the third defined in Requirement 106a: **current**, rendering `v{n}` with a `--line-strong` border and no annotation; and **behind**, rendering `v{n} ↑{delta}` with a `--status-warn` border and a tooltip stating the invariant in words — that the run executed against version N, that the agent has since changed, and that editing an agent never affects a run.
106a. A third pin badge variant exists for a run whose Agent has been soft-deleted (Agent Definition R26): **`v?` in `--status-neutral` with a dotted border and no delta**, tooltip reading that the agent was deleted and that the run's pinned version is retained and viewable. It **must not** render `↑0`, which would assert that the run is current — precisely the invariant-2 misreading the badge exists to prevent.
106b. On a run row whose Agent is deleted, the agent-name cell has no value because `GET /api/agents` excludes deleted Agents. It renders the `agent_version_id` uuid in monospace with the standard copy affordance, that being the only true identifier available. The `RunDetailPage` header adds one line stating that the agent was deleted and that the pinned version definition is retained, linking to the version view. Because Agent Definition R26 hides a deleted Agent from **list** endpoints only, `GET /api/agents/{agent_id}?version=N` still resolves and that link works.
107. The pin badge renders in four places: a version column on `RunsPage`; the `RunDetailPage` header, expanded when behind to read the executed version, the current version, and a link to the executed version in `AgentVersionHistory`; inline in the `run_start` event, which renders the pinned snapshot — `binding_tag`, mode, effective budgets, and the fully-qualified tool list after `denied` — as the authoritative record of what actually ran; and on `AgentVersionHistory` rows, each of which shows its run count so that versions read as load-bearing history rather than as a changelog.
108. Binding drift is **not computed client-side.** The dashboard does not join `GET /models/bindings` to infer that a newer adapter exists. `POST /api/agents/{agent_id}/refresh-bindings` answers the question authoritatively (Agent Definition R25a), so the refresh action is the affordance and its result is what the UI renders.
109. `refresh-bindings` **does not appear** on a non-current version — absent, not disabled. Because it acts on the current definition only and would create a new version from it (Agent Definition R25a), offering it while viewing an older version would misrepresent what it does. The version header instead reads that the view is read-only and that refresh acts on the current version, with a link to it.
110. On the current version, `refresh-bindings` opens a confirm dialog rendering R25b's changed-field list as a field-by-field before/after table, headed with the version number that will be created. When the response reports `changed: false`, no dialog is shown and an inline toast reports that bindings are unchanged and names the current version. A version is never created silently, and an empty diff dialog is never shown.

### Connection states and stream integrity

111. Run inspection renders exactly five connection states:

| State | Meaning | Chrome |
|---|---|---|
| `live` | connected, run running | shimmer on, `◐` rotating, counters ticking |
| `complete` | socket closed **after** a `run_end` event was received | all motion stopped, terminal outcome chip |
| `reconnecting` | socket closed **without** a `run_end` event | **all motion stops**, counters render `--fg-dim` |
| `resyncing` | replay in flight after reconnect | motion still stopped, a thin indeterminate line beneath the banner |
| `broken` | a `seq` gap or a replay shortfall was detected | `--status-fault`, non-dismissible, Requirement 116 |

112. **The primary disconnect signal is the absence of motion.** The instant the socket drops, the shimmer stops, the `◐` stops rotating, and the live counters freeze and render `--fg-dim`. This is Requirement 13 read in reverse and is the reason that rule exists.
113. A sticky `--status-warn` banner at the top of the stream names the state in text, in the form `connection lost · reconnecting · showing events through seq {n}`.
114. The connection state adds exactly one mark to the vocabulary, used **only** in the run header: `◌`, a dotted ring in `--status-neutral`, labelled `UNKNOWN`, with a tooltip naming the last observed `seq`. It is a connection mark, not an outcome. It never appears in a list, never in a `run_end`, and never in the minimap.
115. Because Agent Runtime R6 specifies subscribe-then-full-replay with no resume parameter, every reconnect replays the stream from `seq` 1. The client deduplicates on `(run_id, seq)` and **suppresses all rendering until the replay passes the highest `seq` already held.** Scroll position, follow-mode state, expanded rows (keyed on `event_id`), filter selections, and density setting all survive the reconnect untouched. New events then append from where they stopped, and the banner clears on a 200ms fade as motion resumes. A clean reconnect is nearly invisible in the stream body and fully visible in the chrome.
116. Because `seq` is gapless per run (invariant 5), any observed discontinuity is provably a client or transport fault. The client asserts on a `seq` gap and on a replay that yields fewer events than it already holds. Either condition renders a **non-dismissible `--status-fault` banner that pushes the stream down**, reading that the event log is incomplete, naming the gap range, stating that the view is not trustworthy, and offering a reload. It is the loudest element in the application. A degraded event log is never presented as a healthy one.
117. Because a completed run replays and then receives a close signal rather than an error (Agent Runtime edge 14), a closed socket is ambiguous. The client resolves it by whether a `run_end` event was received: closed with `run_end` renders `complete` with no banner; closed without `run_end` renders a `--status-warn` banner reading that the stream ended without a `run_end` and that the run state is unknown as of the last `seq`, plus a **Refetch run** action calling `GET /api/runs/{run_id}`.
118. The division of authority is explicit: **REST is authoritative for a run's outcome; WebSocket is authoritative for its events.** When they disagree, the REST value is rendered and the banner states that the two disagreed.

### Stream density and follow behaviour

119. There is one event stream view with two modes driven by the run's status, not two components. A finished run renders identically to the last frame of a live one.
120. While the run's status is `running`, the stream follows, pinned to the bottom, and the header renders the live card per Requirement 14.
121. Scrolling up by more than one row detaches follow. **There is no snap-back under any condition.** A bottom-centre pill appears reading `▼ {n} new events` with a live-incrementing count. Re-attachment depends on **why** follow detached, per Requirement 122a. All of this is driven by event arrival and scroll position, with no timers and no polling.
122. Expanding any event also detaches follow. Reading is never interrupted by arriving data.
122a. The client records the **reason** follow detached, `scroll` or `expand`, and an explicit reading act outranks an implicit re-attachment:
    - Detached by `scroll`: scrolling back to the bottom re-attaches, as does clicking the pill.
    - Detached by `expand`: scrolling back to the bottom **does not** re-attach. Only clicking the pill does. Scrolling to the bottom while reading an expanded event is not a request to resume following.
    - Collapsing every expanded row does not re-attach either. The pill is the only path back from an `expand` detach.
    - If the run terminates while follow is detached, the pill persists and relabels to `▼ run ended · {n} new`, so the path back to the `run_end` card is never lost.
123. On `run_end`, follow releases, the view scrolls once to the `run_end` card, and then stays put.
124. The stream carries a density toggle with exactly two settings: **Comfortable** (default, 28px rows, blocks rendered per Requirement 44) and **Compact** (22px rows, 12px monospace, every event including `model_response` collapsed to a rail line). The setting persists to `localStorage`. There is no third density.
124a. **Compact never flattens a `--status-fault` element.** The full-width tinted `error` notice of Requirement 48 and the `run_end` card of Requirement 44 render at full size in Compact. Compact exists for scanning, and scanning exists to find faults; flattening the fault marker would invert the mode's own purpose. The `--status-warn` notices `mode_downgraded` and `mcp_unavailable` **do** collapse in Compact and retain their `--status-warn` mark on the rail line, because they are informational rather than faults. The rule is stated generally so that it governs any element added later.

### Page composition

125. **CorporaPage** renders columns: name (monospace), description, source count, chunk count, and last ingested. Selecting a row opens a drawer with two tabs: Sources (type, location, include and exclude globs) and Ingestion history, in which a job with status `partial` renders as a `--status-warn` `○` with its per-source failures listed (Model & Training Pipeline edge 1).
126. Ingestion progress renders **inline in the corpus row**, replacing the chunk-count cell with a 2px progress line and a running chip. It is not a toast and not a drawer, because the operator triggers an ingest, navigates away, and returns to that row. This requires a progress feed; see Requirement 127.
127. **Dependency 4 is ruled additive, so Requirement 126 applies and this fallback is not used on the specified path.** It is retained as the required behaviour should the progress channel ever be unavailable: the corpus row renders the degraded form instead — a `running` chip with `started {duration} ago`, no progress bar, refreshed on navigation. The staleness semantics of Requirement 90 apply unchanged. **A progress bar that cannot move is never rendered.**
128. **TrainingPage** renders the stage rail of Requirement 83 as the primary table cell, so that the list is itself the pipeline status board. Selecting a row opens a drawer with the full stage rail detail and the dataset's `source_breakdown` composition. Launching a run opens a modal.
129. **ModelsPage** renders **two stacked tables, not tabs**: the BaseModel shortlist above (`base_model_id`, `context_window`, `quantization`, `smoke_test`, base binding status) and the Adapter list below. They are stacked rather than tabbed because the operator continuously cross-references which base an adapter sits on, and tabs would hide one of the two.
130. The adapter drawer renders evaluation scores as a **candidate-versus-baseline paired bar with the delta called out for each metric**, because Model & Training Pipeline R35 defines promotion as a two-metric comparison. Two bare numbers do not render a comparison.
131. **AgentsPage** renders columns: `display_name`, `name`, `binding_tag` (monospace), capability chips, current version, and warning count.
131a. The detail drawer footer is divided by a hairline into two zones that are never adjacent: a **safe zone** on the left carrying Clone and Refresh bindings, and a **destructive zone** on the right carrying Delete in `--status-fault` text. The row overflow control carries Clone and Delete for speed, which does not violate Requirement 41 because an overflow control is an explicit affordance rather than a hover icon.
131b. **Clone is an editor pre-fill, not a server action.** It routes to `/agents/new?from={agent_id}&version={n}`, opening the editor pre-filled with that version's `definition`, with `name` set to `{name}-copy` — suffixed `-2`, `-3`, and so on when that name already exists — pre-selected with the cursor in the name field. **No request is issued and nothing is persisted until the operator saves.** Closing the editor discards the clone entirely.
132. `AgentVersionHistory` renders as a drawer tab, not a route: 24px version rows, and selecting two versions turns the tab into a side-by-side read-only diff of the `definition`. `refresh-bindings` lives in this tab and behaves per Requirements 108–110.
133. **TeamsPage** renders columns: `display_name`, `name`, manager agent, worker count, and limits. Its drawer renders the resolved roster, the limits, and any warnings.
134. **RunsPage** renders `GET /api/runs` (Agent Runtime R3b) with filters mirroring that endpoint's parameters — agent, status, outcome, and `parent_run_id` — showing root runs by default with an include-children toggle, and using cursor pagination. It renders the version pin badge column of Requirement 107.
135. **RunDetailPage** at `/runs/:runId` hosts the run status header, the event stream, and `TeamRunTree` when the run has children.
136. The **run launcher modal** collects an agent or a team, the task text, and an optional `workspace_path`. It calls `POST /api/runs` with `agent_id` for an agent (Agent Runtime R2) and `POST /api/team-runs` with `team_id` for a team (Team Orchestration R40), then redirects to `/runs/{run_id}` using the returned id. The two paths differ only in the endpoint called; the modal is one surface. It is reachable from `AgentsPage` row actions, `TeamsPage` row actions, and the `RunsPage` header. It is a modal, not a page.
137. The **build-dataset modal** on TrainingPage collects one of two sources, `Upload JSONL` or `From corpus`. The upload path renders a drop zone plus a file picker, and shows a client-side line count and a first-record preview before submitting. Per-line parse errors render in the same problems-panel format as `AgentEditor`, with the line number occupying the field-path position, and using the same two severities and the same suggestion layer.
137a. **Dependency 9 is ruled additive: `GET /api/config/capabilities` reports `teacher_enabled`, so the dashboard knows the real state before submitting. `From corpus` therefore renders disabled-with-reason under Requirement 95 when distillation is disabled**, and enabled otherwise. The disabled reason is the same sentence the precondition line carried: that corpus-derived samples require distillation enabled in `config/teacher.yaml` and that it is disabled by default. `config/teacher.yaml` renders in monospace with the copy affordance of Requirement 143.
137b. When a submission fails because distillation is disabled, the resulting HTTP 400 renders into the problems panel in the standard format and **the modal's state is preserved** — no entered value is lost.
137c. Requirement 137b's preserved-state behaviour is retained regardless, because `teacher_enabled` can change between the capabilities fetch and the submission. **A rejected submission never discards entered values, whether or not the control was correctly enabled at the time.**

### Contrast, greyscale, and copy

138. Status hues are used as text and mark colours. A status chip's background is that hue at 12% alpha rather than a filled pill, which moves the backdrop luminance by roughly 2% and so preserves a contrast ratio measured against the underlying surface.
139. **Every status hue meets a contrast ratio of at least 4.5:1 against both `--surface-2` and `--surface-3`, asserted by an automated token test at build time.** The test is the requirement; the measured values below are informative. They are computed against the Armada Oak grounds of Requirement 2 by the WCAG 2.1 relative-luminance formula.
139a. **`--accent` on `--surface-3` is the tightest margin in the system at 4.97:1 — 0.47 of headroom above the floor.** It was also the tightest on the previous slate ramp at 4.91:1, so this is a property of the accent rather than of the oak amendment. It is the token most likely to fail the Requirement 139 build test under any future change, and that is not evident from the table, so it is stated here.

| Token | Hex | On `--surface-2` | On `--surface-3` |
|---|---|---|---|
| `--fg` | `#F2E8D8` | 14.66 | 13.10 |
| `--status-warn` | `#F2B33D` | 9.56 | 8.55 |
| `--status-good` | `#34D399` | 9.25 | 8.27 |
| `--status-live` | `#38BDF8` | 8.30 | 7.42 |
| `--fg-muted` | `#B8A68C` | 7.51 | 6.72 |
| `--status-pending` | `#A78BFA` | 6.54 | 5.84 |
| `--status-fault` | `#F26D6D` | 6.09 | 5.44 |
| `--status-neutral` | `#8B96AC` | 5.98 | 5.34 |
| `--accent` | `#4C8DFF` | 5.56 | **4.97** |
| `--fg-dim` | `#85735E` | 3.91 | 3.49 |

140. `--fg-dim` `#85735E` measures 3.91:1 and 3.49:1 and therefore falls below 4.5:1 and is therefore restricted to non-essential text — `seq` numbers, relative timestamps, and placeholder hints. It never carries status and never carries a value the operator must read to make a decision. Requirement 75's phantom line and Requirement 83's inactive rail segments are exempt because each is accompanied by an adjacent full-contrast label.
141. **The design does not rely on colour: no two states within one family are distinguishable by colour alone.** The claim is scoped to a family deliberately; cross-family identity is intentional and is covered by Requirement 142a. Desaturated, `--status-good` and `--status-warn` collapse together at high luminance, and `--status-fault`, `--status-pending`, `--status-neutral`, and `--accent` collapse together at mid luminance. Shape therefore carries the primary distinction across six marks: `●` a verdict exists, `○` stopped before a verdict, `◐` a verdict is pending, `▲` fault, `✕`-in-square integrity fault, `◌` connection unknown.
142. The residual within-family greyscale collision is `budget_exhausted` (`--status-warn` `○`) against `cancelled` (`--status-neutral` `○`), both in the run outcome family. It is resolved by the slash on the cancelled mark and by the mandatory text label of Requirement 32.
142a. Two cross-family identities are **intentional and must not be treated as defects**: `incomplete` (run outcome) and `rejected` (adapter status) both render `--status-neutral` `●`, and `cancelled` (run outcome), `retired` (binding status), and a queued delegation all render `--status-neutral` `○`. In each case the pair means the same thing under Requirement 31a, the states appear in different tables with different labels, and reading one as the other produces no wrong conclusion.
142b. The desaturation test of the acceptance criteria therefore asserts **per-family distinguishability, not global uniqueness.** A test asserting global uniqueness would fail on a property the design deliberately wants.
143. **Anything set in `JetBrains Mono` is copyable, and monospace is the signal that it is.** This is the entire copy affordance rule.
144. Hovering a monospace token reveals a 16px copy control in a reserved gutter at the token's right edge, so that nothing shifts on hover. Activating it copies the token and the control renders a check mark for 900ms.
145. Double-clicking a monospace token selects the **whole token**, not a hyphen-delimited fragment. This requires an explicit handler because browsers break uuids on hyphens.
146. Token-level copy applies to: `run_id`, `agent_version_id`, `binding_tag`, corpus `name`, `adapter_id`, `dataset_id`, `training_run_id`, `chunk_id`, problems-panel field paths, and the `/armada/tool-results/{event_id}.txt` path, which reuses this affordance rather than being special-cased.
147. Block-level copy uses a header button rather than a hover control, and applies to: tool-call arguments JSON, tool-result bodies, model-response text, the full YAML in version history, and `run_end` budget counters.
148. The run header carries one composite action, `Copy run reference`, emitting a multi-line block containing `run_id`, agent name and version, `binding_tag`, outcome, and final budget counters. When a run goes wrong the operator's next task is pasting context elsewhere, and assembling it from six separate hover-copies is the failure mode this prevents.
149. `Ctrl/Cmd+C` on a focused row copies that row's primary identifier. Copy controls never intercept normal text selection, and non-monospace prose carries no copy affordance.

## Data Flow

**Inspecting a live run**
1. The operator activates the run launcher modal from `AgentsPage`, `TeamsPage`, or the `RunsPage` header, supplies an agent or team, a task, and an optional `workspace_path`.
2. The dashboard calls `POST /api/runs` for an agent or `POST /api/team-runs` for a team, and redirects to `/runs/{run_id}`.
3. `RunDetailPage` fetches `GET /api/runs/{run_id}` for authoritative status and outcome, and opens a WebSocket to `/ws`, sending `{"subscribe": {"run_id": "..."}}`.
4. The connection state enters `live`. The header renders the shimmer, the rotating `◐`, and live counters.
5. Events arrive in `seq` order. Each is deduplicated on `(run_id, seq)`, assigned to a Step block, rendered at its default state per Requirement 44, and given a minimap tick.
6. The newest row renders the 600ms accent left-edge fade of Requirement 16; the previous newest row loses it.
7. The stream follows the bottom until the operator scrolls up or expands an event, at which point follow detaches and the new-events pill appears.
8. On `run_end`, all motion stops within 200ms, follow releases, the view scrolls once to the `run_end` card, and the connection state becomes `complete`.

**A dropped connection**
1. The socket closes without a `run_end` having been received. The connection state becomes `reconnecting`.
2. All motion stops, counters dim, and the amber banner renders the last held `seq`.
3. The client reconnects and re-subscribes. The connection state becomes `resyncing`.
4. Replay begins at `seq` 1. Rendering is suppressed until the replay passes the highest `seq` already held. Scroll position, follow state, expanded rows, filters, and density are untouched.
5. If a `seq` gap or a replay shortfall is detected, the connection state becomes `broken` and the non-dismissible red banner renders. Otherwise the banner clears over 200ms and motion resumes.

**Following a delegation**
1. The manager emits a `tool_call` for `delegate`. `TeamRunTree` renders a queued row with no expander.
2. A `delegation` event arrives carrying `child_run_id`. The row becomes running, and its elapsed time is computed client-side from the event timestamp. No socket is opened.
3. The operator expands the row. A WebSocket subscription to `child_run_id` opens and the bounded child pane renders that child's own stream, minimap, and filter bar.
4. The operator collapses the row, or expands a different child. The subscription closes; the accordion permits one open child.
5. A second `delegation` event arrives carrying `outcome`, tokens, and steps. The row becomes terminated in its original dispatch-ordered slot and the group header's summary counts update.

**Editing an agent**
1. The operator opens `/agents/:agentId/edit`. The editor loads the current version's raw definition.
2. On a 600ms idle, on blur, or on an explicit save keystroke, the dashboard calls `POST /api/agents/{agent_id}/validate`.
3. The response's full error and warning list replaces the problems panel atomically with a single 120ms container crossfade.
4. For each entry, the client maps its field path against the locally parsed YAML CST and anchors it per Requirement 74 or Requirement 75.
5. Save is disabled while errors exist; with only warnings it is enabled and amber-labelled.
6. On save, the dashboard calls `PUT /api/agents/{agent_id}`, which creates a new version. The drawer's version history gains a row.

**Watching a training run**
1. The operator builds a dataset through the build-dataset modal, then launches a run through the launch modal.
2. `TrainingPage` renders the run's stage rail as its primary table cell.
3. Progress updates advance the bar and reset the `last update … ago` timer. Staleness escalates per Requirement 90.
4. On `succeeded`, `Train` fills green and `◐` moves to `Evaluate`. The run is not rendered as finished.
5. The evaluation gate resolves the `Evaluate` segment per Requirement 85, or leaves it violet and the rail unadvanced.
6. `Promote` resolves green, or renders `▲` with a retry action, or renders locked from the first frame when `run_kind` is `smoke`.

## Edge Cases

1. When a run emits more than 2000 events, the minimap renders fault ticks plus a density wash, and fault navigation via the header controls and the `n` key remains available.
2. When a minimap bucket contains one `error` among forty ordinary events, the bucket renders at full width in `--status-fault`.
3. When a `tool_result` has both `is_error: true` and `truncated: true`, the row renders the fault mark and left border and both chips; the truncated chip still reveals the `/armada/tool-results/{event_id}.txt` path.
4. When a `compaction` event carries `summarized: false` (Agent Runtime edge 12), the divider renders in `--status-warn` and reads that messages were dropped without a summary.
5. When a `retrieval` event carries `chunks_dropped` greater than zero, the collapsed line appends an amber `· {n} dropped` qualifier.
6. When a `retrieval` event carries an empty `chunk_id` list because the corpus has zero chunks (Agent Runtime edge 9), the event still renders, reading zero chunks rather than being hidden.
7. When the model emits a tool call for an ungranted tool (Agent Runtime R29), the resulting `tool_result` renders with the inline fault hairline and the stream continues. It does not render as an `error` event.
8. When a delegation fails (Team Orchestration R16), its `tool_result` renders with the inline fault hairline and the child row renders its own non-`success` outcome chip. The parent run's own outcome chip is unaffected.
9. When a team run's manager dispatches more delegations than `max_concurrent_delegations`, the excess render as queued rows with no expander until their `delegation` events arrive.
10. When the operator enables the `live counters` toggle, subscriptions open only for children currently in-flight, bounded by `max_concurrent_delegations`. Terminated and queued children open no subscription.
11. When a child run and its parent are both open — the child expanded inline and the parent's own stream live — both streams render independently and neither is interleaved into the other.
12. When the operator expands a child whose run has already terminated, the replay-then-close sequence renders as `complete` in the child pane, with no banner.
13. When validation returns an error whose field path names a key absent from the operator's text, the phantom line of Requirement 75.1 renders at the parent container's insertion point and is click-to-insert.
14. When the YAML in the editor does not parse, all server-returned errors are suppressed and only the parser's own line and column render, because the server never evaluated the current text.
15. When validation returns only warnings, save is enabled with an amber label and the operator's click is recorded as a deliberate save-with-warnings.
16. When a validation request is in flight and the operator types again, the earlier response is discarded rather than rendered. The problems panel only ever shows the result of the most recent completed validation.
17. When an agent version was saved with warnings, `AgentVersionHistory` renders those same warning chips against that version permanently, sourced from `resolved_snapshot.warnings`.
18. When `refresh-bindings` returns `changed: false`, no dialog opens and an inline toast names the unchanged current version.
19. When `refresh-bindings` returns HTTP 400 because the definition has since become invalid (Agent Definition edge 20), the errors render in the same problems-panel format and no version is reported as created.
20. When the operator views a non-current agent version, the `refresh-bindings` action is absent and the header states that refresh applies to the current version, with a link.
21. When a run executed against version 1 and the agent is now at version 3, the pin badge renders `v1 ↑2` in amber in every one of the four locations of Requirement 107.
22. When a training run's `total_steps` is large and no update arrives for longer than 5× the observed median interval, the card renders `no progress reported in {duration}` in `--status-warn`, with no popup and no sound.
23. When fewer than five progress updates have been received, no estimated completion is rendered.
24. When a training run's `run_kind` is `smoke`, the `Promote` stage renders locked from the first frame, before any progress is reported.
25. When the evaluation gate does not complete (Model & Training Pipeline R35, edges 19 and 20), the `Evaluate` segment stays violet `◐`, the rail does not advance, and an amber sub-label names the reason and the `judge_errors` count.
26. When promotion registration fails after a passing evaluation, `Evaluate` stays green and `Promote` renders `▲` with a retry action targeting `POST /adapters/{adapter_id}/promote`.
27. When a ModelBinding reports status `missing`, its row renders the `✕`-square mark and a 2px fault edge, and the Models navigation item renders a count badge. No other status raises a navigation badge.
28. When a ModelBinding reports status `retired`, its tag renders struck-through and no navigation badge is raised.
29. When an ingestion job completes with status `partial` (Model & Training Pipeline edge 1), the ingestion history row renders an amber `○` and lists each failed source with its underlying error.
30. When a second ingestion is triggered for a corpus that already has one in flight and the call returns HTTP 409 (Model & Training Pipeline edge 18), the result renders as an inline toast naming the in-flight `job_id`, not as an error modal.
31. When no push channel for ingestion progress exists, the corpus row renders the degraded form of Requirement 127 and never renders a stationary progress bar.
32. When a cancel request races a run's termination and returns HTTP 409 (Agent Runtime edge 16), an inline toast names the existing outcome and the cancel control is removed.
33. When a corpus deletion would break bound agents, the type-to-confirm dialog lists every affected agent by name before the operator can confirm.
34. When an agent deletion would break a team, the confirm dialog lists every affected team by name.
35. When the operator reloads `RunDetailPage` for a completed run, the WebSocket replays every event and then closes; because a `run_end` was received, the state is `complete` and no banner renders.
36. When a WebSocket replay yields fewer events than the client already holds, the `broken` state renders, because a gapless append-only log cannot shrink.
37. When REST reports a terminal outcome while the WebSocket has not delivered a `run_end`, the REST outcome renders and the banner states that the two sources disagreed.
38. When `prefers-reduced-motion` is set, the disconnect signal of Requirement 112 is carried by the dimmed counters and the text banner alone, with no reliance on motion having stopped.
38a. When an agent has been soft-deleted, its historical runs still list on `RunsPage` with a `v?` pin badge and a monospace `agent_version_id` in place of the agent name, and the linked version view still resolves.
38b. When the operator clones an agent whose `{name}-copy` already exists, the pre-filled name becomes `{name}-copy-2`, and so on.
38c. When the operator submits a `From corpus` dataset build while distillation is disabled, the HTTP 400 renders in the problems panel and the modal retains every entered value.
38d. When every Step in a run is filtered out — which per Requirement 56b implies the run contains no faults — the stream renders a single `··· {n} steps hidden ···` rule and no empty headers, and the minimap still shows every tick at reduced opacity.
38e. When a filter is active and a new matching event arrives, it appends normally; when a new non-matching event arrives, the hidden-count rule increments rather than the stream reflowing.
38f. When the operator switches to Compact while an `error` notice is on screen, the notice does not change size or lose its tint.
39. When the viewport is narrower than 1280px, the layout does not reflow to a mobile arrangement; the content area scrolls horizontally. Mobile is out of scope.
40. When a status must be rendered in a context that cannot show a text label, the context is out of specification. Every status readout carries a label; only the minimap and the health strip are exempt.

## Acceptance Criteria

- [ ] A stylesheet or token module defines exactly five surface tokens, three foreground tokens, one accent token with hover and wash, six status hue tokens, six type sizes, seven spacing steps, and four radius values, and no component introduces a colour, size, spacing value, or radius outside that set.
- [ ] An automated token test asserts that every status hue meets ≥4.5:1 against both `--surface-2` and `--surface-3`, and fails the build when a token is changed to a value that does not.
- [ ] A screenshot of all status chips across the three families, desaturated to greyscale, leaves all six marks distinguishable, and no two states in the same family render identically.
- [ ] No status readout anywhere in the application renders a mark without an accompanying text label, except the minimap.
- [ ] A run with 300 events renders with `reasoning` events collapsed, one Step block per Step, and a minimap in which the single `tool_result` carrying `is_error: true` is visible at full rail width.
- [ ] Pressing `n` in the event stream jumps to the next fault without the operator interacting with the minimap.
- [ ] A `tool_result` with `is_error: true` and an `error` event render differently: the first is an inline row with a red left border inside its Step block, the second is a full-width tinted notice outside the Step indentation.
- [ ] Scrolling up in a live stream detaches follow, shows a `▼ n new events` pill with an incrementing count, and never scrolls the view back down on its own.
- [ ] Expanding an event during a live stream detaches follow.
- [ ] Killing the WebSocket mid-run stops the shimmer, stops the `◐` rotating, and dims the counters within 200ms, and renders the amber reconnecting banner naming the last held `seq`.
- [ ] Reconnecting after a drop replays the full stream, renders no duplicate rows, and leaves scroll position, expanded rows, filter selections, and density setting unchanged.
- [ ] Injecting a `seq` gap into the replayed stream renders a non-dismissible red banner naming the gap range, and the banner cannot be closed.
- [ ] Closing the socket for a completed run after a `run_end` renders `complete` with no banner; closing it without a `run_end` renders the amber unknown-state banner with a working Refetch run action.
- [ ] A team run with twelve delegations dispatched in one Step renders a single delegation group block with a summary header, twelve 24px rows, and no re-ordering as children terminate.
- [ ] Rendering twelve collapsed running children opens zero WebSocket connections, verified by counting open sockets.
- [ ] Expanding one child opens exactly one subscription; expanding a second closes the first.
- [ ] A queued delegation renders with no expander and the `QUEUED` label.
- [ ] Submitting a definition with three errors renders three entries in the problems panel in one atomic update, each anchored in the editor, and save disabled.
- [ ] Submitting a definition missing `schema_version` renders a click-to-insert phantom line at line 1.
- [ ] Typing invalid YAML suppresses all server errors and renders only the parser's line and column.
- [ ] Submitting a definition producing only warnings leaves save enabled with an amber label, and the saved version's warnings render in `AgentVersionHistory`.
- [ ] A training run whose backend reports `succeeded` renders `Train` green and `◐` on `Evaluate`, with two segments still visibly incomplete.
- [ ] A training run with `run_kind: smoke` renders the `Promote` stage locked and labelled `not promotable · smoke` before its first progress update.
- [ ] An evaluation that does not complete leaves `Evaluate` violet, does not advance the rail, and renders the reason and `judge_errors` count.
- [ ] A training run with no update for longer than 5× its median update interval renders `no progress reported in {duration}` in amber, with no popup.
- [ ] A training run with fewer than five progress updates renders no estimated completion.
- [ ] A fresh installation renders two corpus rows each reading `0 chunks` with an inline add-source action, two agent rows each with a warning count of 1, a populated BaseModel table, an empty adapter table, a disabled Training primary action stating its reason, and an enabled Teams primary action.
- [ ] Every disabled primary action in the application renders its reason inline.
- [ ] The delete-corpus dialog requires typing the corpus name and lists every affected agent before confirmation is possible.
- [ ] Every destructive confirmation dialog contains a `Retained:` section.
- [ ] The cancel-run dialog states that the tool is killed, the sandbox destroyed, the outcome recorded as `cancelled`, and that cancelled runs are never used as training data; for a team run it also names the in-flight child count.
- [ ] No destructive action is reachable from a row-hover control.
- [ ] A run executed against version 1 of an agent now at version 3 renders `v1 ↑2` in amber on `RunsPage`, in the `RunDetailPage` header, on the `run_start` event, and in `AgentVersionHistory`.
- [ ] `refresh-bindings` returning `changed: false` opens no dialog and creates no version.
- [ ] `refresh-bindings` is absent, not disabled, when viewing a non-current version.
- [ ] Hovering any monospace identifier reveals a copy control in a reserved gutter with no layout shift, and double-clicking a `run_id` selects the entire uuid including hyphens.
- [ ] `Copy run reference` emits a multi-line block containing `run_id`, agent name and version, `binding_tag`, outcome, and final counters.
- [ ] With `prefers-reduced-motion: reduce`, no information is lost: the disconnect state, the running state, and every status remain readable from text and chrome.
- [ ] No event row, table row, tree row, or chip has an entrance animation, a box-shadow, or a blur, verified against the rendered styles.
- [ ] The desaturation test asserts distinguishability **within each family** and passes while `incomplete` and `rejected` render identically across families.
- [ ] No flag chip anywhere renders in a status hue, and the `tool_result` flag `cancelled` is visually distinct from the run outcome chip `CANCELLED`.
- [ ] Expanding an event and then scrolling to the bottom does not re-attach follow; clicking the pill does.
- [ ] Scrolling up without expanding anything, then scrolling back to the bottom, re-attaches follow.
- [ ] A run that terminates while follow is detached relabels the pill to `▼ run ended · {n} new` rather than removing it.
- [ ] Switching to Compact leaves the full-width `error` notice and the `run_end` card at full size while collapsing every other event to a rail line.
- [ ] Enabling Errors only removes non-matching Step blocks entirely and renders a clickable `··· {n} steps hidden ···` rule in their place.
- [ ] Toggling any filter leaves the minimap's tick geometry unchanged, dimming filtered ticks to 25% opacity rather than removing them.
- [ ] Switching off every family toggle still renders `run_start`, `user_message`, `run_end`, every `error`, and every `tool_result` with `is_error: true`, and the filter bar shows the `faults always shown` label.
- [ ] Every one of the fourteen event types is either listed in Requirement 56a or assigned to exactly one family in Requirement 57a; none appears in both and none is unassigned.
- [ ] An ordinary run renders six family chips and a team run renders seven.
- [ ] Switching off `Delegation` removes both the creation and the termination instance of every pair, and leaves the run header's roster strip unchanged.
- [ ] A `compaction` with `summarized: false` renders as an amber divider and is hidden by the `Context` toggle.
- [ ] Switching off `Tools` hides `tool_call` and ordinary `tool_result` rows while leaving error results rendered.
- [ ] Fault ticks in the minimap render at full width and full opacity under every filter state.
- [ ] The header fault count is identical with all filters on and all filters off.
- [ ] The navigation rail renders exactly three health dots, none of which raises a navigation badge.
- [ ] Opening a detail drawer leaves the list behind it unblurred, undimmed, and clickable, and clicking a second row swaps the drawer's contents without closing it.
- [ ] No event block, Step block, or stream row other than the `error` notice has a background fill; row hover is `--surface-3` and selection is an accent left edge.
- [ ] No status hue appears on a rail, border, divider, or indentation guide that does not represent a state.
- [ ] Every alpha-modified use of a status hue in the built application appears in the Requirement 32d list, and no status hue used as a mark, as text, or as a status-bearing border is rendered at a modified opacity.
- [ ] Every normative requirement naming a colour names a token; no requirement instructs an implementer using a plain-English colour word alone.
- [ ] `--accent` and `--status-live` resolve to different values, and no rule sets one from the other.
- [ ] No `--status-muted` token exists, and `incomplete`, `cancelled`, and `rejected` render in one hue distinguished by mark and label alone.
- [ ] Cloning an agent opens the editor pre-filled with `{name}-copy` and issues no network request; closing the editor leaves the agent count unchanged.
- [ ] Editing a team at `/teams/:teamId/edit` produces live debounced validation in the same problems panel as an agent, with identical formatting.
- [ ] On `/agents/new`, a missing required key renders a phantom line before any request is made, and a nonexistent `sandbox.profile` renders in the same panel only after the first save attempt.
- [ ] With `teacher_enabled: false` from `GET /api/config/capabilities`, `From corpus` renders disabled with its reason inline; with `teacher_enabled: true` it renders enabled. A rejected submission preserves every entered value in both cases.
- [ ] A run whose agent has been deleted renders `v?` with a dotted border, never `↑0`, and renders the `agent_version_id` uuid in the agent cell.
- [ ] The only rotating element in the application is the `◐` running mark, and the only blurred surfaces are modals and popovers.

## Dependencies

These are surfaces this spec designs that required an endpoint or channel the four implementable specs did not define. Each was recorded as an open dependency and **each has since been ruled on by the implementation review. None was refused; no surface changed as a result.** The rulings are recorded here so that a later reader does not re-open a settled question. Every ruling is owned by the implementation spec, not by this one.

1. **RULED — additive.** `GET /training/runs` is a list over the `training_runs` table, whose every column is defined by Model & Training Pipeline R28, mirroring `GET /api/runs` cursor pagination. Original flag: no `GET /training/runs` is specified. `TrainingPage` as designed requires a list endpoint for training runs.
2. **RULED — additive.** `GET /adapters` lists over `adapters` (R29) filtered by `base_model_id` and `status`; `GET /datasets` lists over `datasets` (R19) including `source_breakdown`. Original flag: neither endpoint is specified. `ModelsPage`'s adapter table and the build-dataset modal's dataset selection require them.
3. **RULED — additive, behaviour already specified.** `DELETE /corpora/{corpus_id}` behaviour is fully defined by Model & Training Pipeline edge 16; only the route was missing. `DELETE /api/teams/{team_id}` mirrors the Agent soft delete of Agent Definition R26. Requirements 101 and 102 stand as written and their dialogs already state this behaviour. Original flag: neither route is specified, although both surfaces are scoped for delete. Requirements 101 and 102 are blocked on the ruling.
4. **RULED — additive, no fallback needed.** `armada-forge` already emits a dashboard WebSocket message for training progress (Model & Training Pipeline data flow step 14); ingestion extends that same channel. **Requirement 126 applies and Requirement 127's degraded fallback is not used.** Requirement 127 is retained as the specified behaviour should that channel ever be unavailable. Original flag: no push channel is specified. Model & Training Pipeline data flow describes ingestion as a job with a `job_id` but names no progress feed. Requirement 126 depends on one; Requirement 127 states the degraded fallback if it does not exist.
5. **RULED — accepted and narrowed to three dots.** `GET /api/health` already exists (Agent Runtime R3a) and is extended to fan out to `armada-forge` and `armada-models`. The strip is now designed in Requirements 35a–35d rather than flagged. Original flag: no service health endpoints are specified. A five-dot service health strip in the navigation rail was proposed and is **flagged, not designed**. It is not part of this spec's scope. If the implementation spec rules it cheap, it is added as a separate design decision; if not, the navigation rail is six items and nothing else.
6. **RULED — additive, one field.** `version` (int) is added beside `agent_version_id` on `GET /api/runs` rows, which resolves Requirement 106's badge permanently; the `v?` variant of Requirement 106a then applies only to a deleted Agent, as intended. Original flag: `GET /api/runs` returns `agent_version_id` as a uuid, not a version integer, while `GET /api/agents/{agent_id}?version=N` looks up by integer. Requirement 106's `v1 ↑2` badge requires either the version integer on the run row or a uuid-to-version lookup.
7. **RULED — additive, columns already exist.** `parent_run_id`, `is_team_run`, and `team_version_id` are added to the `GET /api/runs/{run_id}` response contract; Team Orchestration's migration already creates all three columns. Original flag: team-run identification is not specified. `RunDetailPage` must know whether to mount `TeamRunTree`.
8. **RULED — spec defect, corrected requirement.** Agent Runtime gains a requirement specifying that `run_start` carries `agent_version_id`, `binding_tag`, `mode`, `workspace_path`, effective budgets, and the post-`denied` tool list. Requirement 107 depends on exactly that set. Original flag: the payload is not enumerated in Agent Runtime R54–R59. Requirement 107 renders the pinned snapshot from it.

9. **RULED — additive.** `GET /api/config/capabilities` returns `teacher_enabled`, `eval_mode`, and `local_backend_mode`. **This is the config-state endpoint Requirement 137c names, so `From corpus` becomes disabled-with-reason using real state and the precondition line of Requirement 137a becomes the disabled reason.** Original flag: no endpoint exposes configuration state. `teacher.enabled` lives in `config/teacher.yaml` and surfaces only as an HTTP 400 after submission; `eval.mode` determines whether ModelsPage should render `task_success_rate` or `held_out_perplexity`. Requirements 137a–137c depend on this ruling, and Requirement 130's score labels do too.

## Key Files

- `services/dashboard/src/styles/tokens.css` — new file, the five surface, three foreground, one accent, and six status tokens, plus type ramp, spacing steps, and radii
- `services/dashboard/src/styles/motion.css` — new file, the motion policy of Requirements 12–17 including the `prefers-reduced-motion` branch
- `services/dashboard/src/components/StatusMark.tsx` — new file, the six SVG marks and the three status families of Requirements 18–32
- `services/dashboard/src/components/StatusChip.tsx` — new file, mark plus 12% tint plus mandatory label, including the qualifier of Requirement 25
- `services/dashboard/src/components/AppShell.tsx` — new file, 200px navigation rail, pipeline ordering, sliding active indicator, the `missing` count badge
- `services/dashboard/src/components/HealthStrip.tsx` — new file, three-dot service health strip over the extended `GET /api/health`
- `services/dashboard/src/components/DetailDrawer.tsx` — new file, the 480px overlay drawer pattern of Requirements 37–41
- `services/dashboard/src/components/ConfirmDialog.tsx` — new file, the destructive-action template including the required `Retained:` section
- `services/dashboard/src/components/EventStream.tsx` — new file, rail layout, Step blocks, per-type default states, filter bar, density toggle, follow behaviour
- `services/dashboard/src/components/EventMinimap.tsx` — new file, severity-outward ticks, highest-severity bucketing, fault navigation
- `services/dashboard/src/components/ConnectionBanner.tsx` — new file, the five connection states, gap assertion, and REST-versus-WebSocket authority
- `services/dashboard/src/components/TeamRunTree.tsx` — new file, three child states, lazy subscription on expand, bounded child pane, delegation group block
- `services/dashboard/src/components/YamlEditor.tsx` — new file, the shared editor: CST field-path anchoring, phantom lines, 320px problems panel, debounce policy
- `services/dashboard/src/components/AgentEditor.tsx` — new file, thin wrapper supplying the agent schema, validate endpoint, and save endpoint
- `services/dashboard/src/components/TeamEditor.tsx` — new file, thin wrapper supplying the team schema, `POST /api/teams/{team_id}/validate`, and save endpoint
- `services/dashboard/src/components/ProblemsPanel.tsx` — new file, two severities, suggestion chips, atomic replacement; reused by the build-dataset modal
- `services/dashboard/src/components/AgentVersionHistory.tsx` — new file, version rows with run counts, two-version diff, `refresh-bindings` affordance
- `services/dashboard/src/components/VersionPinBadge.tsx` — new file, the current and behind variants of Requirement 106
- `services/dashboard/src/components/StageRail.tsx` — new file, the five training pipeline segments of Requirements 83–87
- `services/dashboard/src/components/CopyToken.tsx` — new file, hover control in a reserved gutter, whole-token double-click selection
- `services/dashboard/src/components/RunLauncherModal.tsx` — new file, agent-or-team, task, optional `workspace_path`, redirect to run detail
- `services/dashboard/src/components/BuildDatasetModal.tsx` — new file, upload-JSONL and from-corpus paths, line count and first-record preview, per-line errors
- `services/dashboard/src/pages/CorporaPage.tsx` — new file, corpus list, inline ingestion progress with the degraded fallback, sources and history drawer
- `services/dashboard/src/pages/TrainingPage.tsx` — new file, stage rail as primary cell, launch modal, drawer with `source_breakdown`
- `services/dashboard/src/pages/ModelsPage.tsx` — new file, stacked BaseModel and Adapter tables, paired candidate-versus-baseline score bars, retry promotion
- `services/dashboard/src/pages/AgentsPage.tsx` — new file, list, create, edit, clone, delete
- `services/dashboard/src/pages/TeamsPage.tsx` — new file, list, create, edit, delete
- `services/dashboard/src/pages/RunsPage.tsx` — new file, `GET /api/runs` list with R3b filters, cursor pagination, version pin column
- `services/dashboard/src/pages/RunDetailPage.tsx` — new file, run header, event stream, `TeamRunTree` mount
