# Evaluation Rubric

Passed verbatim to the teacher model in **judge mode only**
(Model & Training Pipeline R34b). Mechanical mode — the default — never reads this file,
because it scores `held_out_perplexity` and `tool_call_validity` in-process with no
teacher involved.

## Task

You are judging whether a model completion adequately answers an instruction, given a
reference response written by a stronger model.

You will receive:

- **Instruction** — the task given to both models.
- **Reference response** — a known-good answer. It is a reference, not the only correct
  answer.
- **Completion A** and **Completion B** — two candidate answers, in an order determined
  by the parity of the sample index.

## Output format

Return exactly one JSON object and nothing else:

```json
{"a": "pass", "b": "fail"}
```

Each value is `pass` or `fail`. Any other shape is an unparseable verdict.

## Critical: judge each completion independently

**Return a verdict per completion, not a preference between them** (R34c). Both may pass.
Both may fail. You are never asked which is better.

The order of A and B carries no information — it is set by sample-index parity
specifically so position bias cannot systematically favour either model. Do not infer that
the first is the candidate, the stronger, or the intended winner.

## Pass criteria

Mark a completion `pass` when **all** hold:

1. **Responsive** — it answers the instruction that was asked, not a nearby one.
2. **Factually consistent with the reference** — no claim contradicting it. Additional
   correct detail is fine; a contradiction is not.
3. **Complete** — every part of a multi-part instruction is addressed.
4. **Well-formed** — not truncated mid-thought, not degenerate repetition, not empty.
5. **Valid tool calls, where present** — any tool call parses and its arguments match the
   declared schema.

Mark `fail` when any is violated.

## Explicitly not grounds for failure

- **Differing from the reference in wording, structure, or length.** The reference is one
  correct answer, not a template.
- **Brevity**, when the instruction is fully answered.
- **Style, tone, or formatting** differences.
- **Extra correct information** beyond what the reference covers.

Judge substance. A completion that answers correctly in its own voice passes.

## Unparseable verdicts

If you cannot produce a verdict, return the JSON object with your best judgement anyway.
A malformed response excludes that sample from **both** `task_success_rate` denominators
and increments `judge_errors` (edge 20). When `judge_errors` exceeds half the evaluated
samples the gate aborts and the Adapter stays `pending_eval` rather than being rejected —
an absent judgement is never read as a failing judgement (R35).
