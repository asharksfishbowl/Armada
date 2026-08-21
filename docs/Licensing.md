# Licensing

Armada is **proprietary**. All rights reserved. See [LICENSE](../LICENSE) and [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

---

## The posture

| | |
|---|---|
| **Armada itself** | Proprietary, all rights reserved. No license granted to anyone. |
| **Repository visibility** | Public — readable, but readability is not a license |
| **Users** | Sole proprietor only |
| **Code dependencies** | All compatible with proprietary use |
| **Model weights** | Two of five shipped base models are **not** open source |

"Public repository" and "all rights reserved" are not in conflict. Anyone can read the code; nobody has permission to use, copy, modify, or distribute it. GitHub's terms grant other users a right to view and fork *within GitHub*, and the LICENSE says so explicitly so the position is unambiguous.

**If you want it unreadable, make the repository private.** That is a GitHub setting, not a licensing question, and the license does not depend on it either way.

---

## This decision is reversible in one direction

Proprietary now → open source later is easy. You hold all the copyright, so you can relicense your own work whenever you choose.

Open source now → proprietary later is effectively impossible. Once a permissive license is published, every copy already distributed keeps those rights permanently. You can change the license going forward, but you cannot revoke what's out.

Starting proprietary is therefore the conservative choice, and "for now" is a coherent position rather than a deferral.

Two things that *do* get harder later:

- **Outside contributions.** Accepting a PR into a proprietary codebase without a contributor agreement muddies who owns what. If contributions ever arrive, sort ownership before merging.
- **Dependencies added meanwhile.** Every new dependency is a constraint you inherit. Adding a GPL-licensed one would force a relicensing conversation you didn't plan to have.

---

## What actually constrains you

Not the code dependencies — those are clean. Two things:

### Llama 3.2 and Gemma 3

`config/base-models.yaml` ships five base models. Three are Apache 2.0 (Qwen3). Two are not open source:

- **Llama 3.2** requires *"Built with Llama"* attribution on distribution, and a distributed derivative model's **name must begin with "Llama"**. Armada's tag scheme produces `armada/llama-3.2-3b-instruct-{corpus}-v{n}`, which does not.
- **Gemma 3** carries use restrictions and requires passing Google's terms downstream to recipients.

**Neither obligation is live today.** They attach on distribution, and Armada is single-operator and self-hosted. They go live the moment you publish a trained adapter or let anyone else use the platform.

The clean escape is dropping both entries and shipping Qwen3 only. Nothing depends on either — the smoke-test model is `qwen3-0.6b` and the example Agents bind by `base_model_id`.

### psycopg is LGPL-3.0

The one copyleft dependency. Fine as used — imported at runtime, user-replaceable. Do not vendor, fork, or patch it.

---

## Practical rules

**Adding a base model.** Check the license before adding the entry. Apache 2.0 or MIT, add it. Custom license, read the naming, attribution, and downstream-terms clauses first and record them in `THIRD_PARTY_NOTICES.md`.

**Adding a dependency.** Permissive (MIT/BSD/Apache 2.0), fine. Copyleft (GPL/AGPL), stop — AGPL in particular would be incompatible with keeping a network-served Armada proprietary.

**Before distributing anything.** Re-read `THIRD_PARTY_NOTICES.md`. Distribution is what activates nearly every obligation on this page.

**Credentials are never licensing.** `api_key_env` holds a variable *name*, never a value. Committing a key is a security incident, not a licensing question.

---

**This page is an engineering summary, not legal advice.** Confirm anything consequential with counsel before distributing Armada, offering it as a service, or publishing a trained model.
