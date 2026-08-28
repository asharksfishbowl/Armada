"""Mechanical mode — Training R34a, R35a; edge 28.

THE DEFAULT GATE, AND IT CONTACTS NOTHING. No teacher, no `armada-models`, no credential,
no egress. Its cost is local CPU time, which is why R34d's `max_eval_samples` bound applies
to judge mode and not to this one.

BECAUSE IT HAS NO EXTERNAL DEPENDENCY IT HAS NO INCOMPLETE OUTCOME (R35). Judge mode can
end without a verdict when the teacher is unreachable, and R35 leaves the Adapter at
`pending_eval` in that case because an absent judgement is not a failing judgement.
Mechanical mode cannot reach that state: every metric it computes is computed here.

WHAT IT ACTUALLY MEASURES, AND R35c SAYS SO OUT LOUD: `task_success_rate` is null by
definition, and `tool_call_validity` is usually null because supplied JSONL presents no tool
schemas at generation time (R35a). So the default gate very often reduces to ONE
in-distribution perplexity comparison. That is enough to catch a training run that damaged
the model, and it is the strongest gate obtainable at zero cost. It is not evidence the
Adapter is better at the task.
"""

from __future__ import annotations

from typing import Any

from armada_forge.eval import tool_calls
from armada_forge.eval.scoring import Scorer


def score(
    scorer: Scorer,
    samples: list[dict[str, Any]],
    tool_schemas: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """R34/R34a — generate a completion per held-out sample, then score.

    Both metrics come from the SAME generation pass. Generating twice would double a cost
    that is already the expensive part of a CPU gate, and would risk the two metrics
    describing different completions.
    """
    completions: list[str] = []
    perplexities: list[float] = []

    for sample in samples:
        prompt = sample.get("instruction") or ""
        completions.append(scorer.generate(prompt))

        # Teacher-forced over the rendered sample — instruction and reference response
        # together — because that is the text the adapter was trained to produce. Scoring
        # the response alone would drop the conditioning and measure a different quantity
        # for the two models depending on how much of their probability mass sat on the
        # prompt.
        text = sample.get("text") or f"{prompt}\n{sample.get('response', '')}"
        perplexities.append(scorer.perplexity(text))

    return {
        # A mean of per-sample perplexities, not a perplexity of the concatenation. The
        # two differ, and the mean is the one that does not let a single long sample
        # dominate the score.
        "held_out_perplexity": sum(perplexities) / len(perplexities) if perplexities else None,
        # R35a — None, never 0, when nothing was emitted.
        "tool_call_validity": tool_calls.validity(completions, tool_schemas),
        # R34a / edge 28 — null in mechanical mode. Recorded explicitly rather than omitted
        # so a reader of the `evaluations` row can tell the metric was not applicable
        # instead of wondering whether it was lost.
        "task_success_rate": None,
        "samples_evaluated": len(samples),
    }
