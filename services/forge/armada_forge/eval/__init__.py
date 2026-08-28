"""The evaluation gate — Training R33b, R34, R34a-e, R35, R35a-d, R36, R37.

IT RUNS ENTIRELY INSIDE armada-forge. Build-plan Requirement 31 and Training R34e settle
this: `armada-models` is involved in neither generation nor scoring. Two independent
reasons, and either alone would be sufficient —

  * R30 forbids registering an unpromoted Adapter with `armada-models` and R31 produces the
    GGUF only ON promotion, so at gate time the candidate has no tag to address. Generating
    through the model server would be a closed loop: the gate decides promotion, and
    promotion is what would make the candidate addressable.
  * `held_out_perplexity` needs teacher-forced scoring over supplied tokens, and Ollama
    exposes per-token logprobs on neither its OpenAI-compatible nor its native surface.

THE BASELINE GENERATES IN-PROCESS TOO, and that is not incidental. Scoring the baseline
through `armada-models` would compare a Q4_K_M-quantized baseline against an fp16
candidate; the quantization delta would swamp the adapter delta and the gate would reject
good adapters for the wrong reason. Both sides load the same dtype with identical sampling.

WHAT THE DEFAULT GATE ACTUALLY PROVES IS LESS THAN IT LOOKS (R35b, R35c), and those two
limitations are exported by `limitations()` below so the dashboard can show them beside the
scores rather than leaving an operator to infer them.
"""

from __future__ import annotations

MECHANICAL = "mechanical"
JUDGE = "judge"

# R35b and R35c, verbatim in substance. R35d requires these to be surfaced in the
# dashboard's evaluation view ALONGSIDE the scores; forge owns making them available, so
# they live next to the code that produces the scores rather than in a UI string table
# where they could drift from what the gate actually did.
_LIMITATIONS = {
    "unquantized_artifact": (
        "The gate scored base weights plus the UNMERGED adapter in full precision. A "
        "promoted Adapter serves as merged, GGUF-converted, and quantized weights, so the "
        "artifact judged here is not the artifact an Agent will bind. Quantization damage "
        "is not measured."
    ),
    "in_distribution_split": (
        "The held-out split was reserved from the same dataset the Adapter trained on, so "
        "held_out_perplexity measures fit to the training distribution rather than "
        "generalization to the task. A mechanical pass catches a training run that damaged "
        "the model; it is not evidence the Adapter is better at the task."
    ),
}


def limitations(mode: str) -> list[dict[str, str]]:
    """R35d — what a passing gate did and did not measure, in the operator's terms."""
    keys = ["unquantized_artifact"]
    if mode == MECHANICAL:
        # R35c is specifically about held_out_perplexity, which judge mode does not compute.
        keys.append("in_distribution_split")
    return [{"id": key, "detail": _LIMITATIONS[key]} for key in keys]
