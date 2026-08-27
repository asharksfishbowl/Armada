# Armada — design iterations index

Read this file FIRST on restart or lost context. It is the record of what exists,
what was tried, and what was picked. Never overwrite a mock listed here.

**Server:** `http://DEX_HOST:8766/` — port 8765 is occupied by another project.

## Platform target

Armada's only interface is `armada-dashboard`, a React web UI for a **single operator on a
trusted network** (no auth, no RBAC, no multi-tenancy — platform-wide non-goals). It is an
**operator console**: dense, information-heavy, live-streaming. Desktop-first. Mobile mocks
are still required at the screens stage, but desktop is the primary frame — the event stream
and the team run tree are not "wider mobile" layouts.

## References supplied by user

None yet. No reference screenshots have been provided, so direction A was authored from the
specs' data model rather than an external aesthetic. **Open question for the user:** any
consoles whose feel you want borrowed (Grafana, Linear, Datadog, Vercel, Railway, a terminal)?

## Iterations

### Direction A — four-preset parts-bin
- `playground-A.html` — first playground. Parts-bin covering the six spec'd dashboard surfaces,
  with four switchable feel presets and live token controls.
  Presets: **Deep Harbor** (dark navy/cyan), **Drydock** (light paper/ink), **Signal**
  (OLED black, mono-forward, zero radius), **Slate** (neutral dark, violet, soft radius).
  → `http://DEX_HOST:8766/playground-A.html`

## Coverage check — spec'd screen → playground component

| Spec'd file | Surface | In playground A |
|---|---|---|
| Run inspection (Agent Runtime) | Event stream, run header, budget meters | ✅ all 14 event types, 4 budget meters, turn rules, fold-out payloads |
| `TeamRunTree.tsx` | Manager → child run tree | ✅ 3-level nest, per-child outcome/tokens/wall-clock |
| `CorporaPage.tsx` | Corpus + Source rows, ingestion progress | ✅ 4 source kinds, determinate + indeterminate + failed |
| `ModelsPage.tsx` | BaseModel / Adapter list, eval scores, promotion | ✅ binding rows, promoted/retired/missing |
| `AgentEditor.tsx` | Inline per-field-path validation | ✅ two error fields with resolved field paths |
| `AgentVersionHistory.tsx` | Read-only prior versions | ✅ version rows |
| `AgentsPage.tsx` | List / create / edit / clone / delete | ⚠️ partial — editor + history only, no list page yet |
| `TeamsPage.tsx` | Team CRUD | ❌ not yet — deferred to screens stage |
| `TrainingPage.tsx` | Dataset construction, run launch, live progress | ❌ not yet — deferred to screens stage |
| — | Empty / loading / error states | ✅ three variants |

## Decisions embedded in A (challenge any of these)

1. **The spine is the signal.** Each event carries a 3px colour spine; the monospace type label
   is a redundant echo for accessibility. Colour alone never carries meaning.
2. **`incomplete` is warn, `failed` is error.** The spec is explicit that `incomplete` means the
   agent ran correctly and self-reported not finishing, while `failed` is an infrastructure fault.
   The palette must hold that apart or the console lies about what happened.
3. **The event-type filter row is a horizontal scroller by construction.** 14 types will not fit
   on any width. Never a wrap, never a truncation.
4. **Budget meters are always visible, not on a tab.** Every run terminates on one of four budgets;
   which one is closest is the single most useful number on the screen.
5. **Turn rules, not timestamps, structure the stream.** A Turn is the spec's unit of conversation;
   the eye needs that boundary more than it needs per-event clock time.
