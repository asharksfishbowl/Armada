"""In-process generation and perplexity — Training R34, R34e; build-plan Req 31, 32.

`armada-models` IS NOT INVOLVED, in either mode, on either side of the comparison. See
`armada_forge/eval/__init__.py` for the two independent reasons. This module is where that
ruling becomes code: it loads weights through transformers and PEFT and never opens a
socket.

TWO SCORERS PER GATE, LOADED IDENTICALLY. `candidate` is base weights plus the UNMERGED
adapter; `baseline` is the same base weights alone. Same dtype, same sampling parameters,
same device. Anything that differs between them other than the adapter would be measured as
if it were the adapter's effect.

THE HEAVY IMPORTS ARE LOCAL TO EACH METHOD. `main.py` imports the gate at startup, and a
top-level `import torch` would put a multi-second framework import on the path of a health
check — and would make the whole eval package unimportable on a machine without torch,
which is where its unit tests run.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

# Deterministic by construction. Sampling would make two runs of the same gate disagree,
# and a promotion decision that changes on a re-run is not a gate.
GREEDY_MAX_NEW_TOKENS = 256


class Scorer(Protocol):
    """What the gate needs from a model. Two implementations: real, and a test double."""

    def generate(self, prompt: str) -> str:
        """A completion for `prompt`, greedily decoded."""

    def perplexity(self, text: str) -> float:
        """Teacher-forced perplexity over `text`."""

    def close(self) -> None:
        """Release weights."""


@dataclass
class InProcessScorer:
    """R34e — base weights, optionally plus an unmerged LoRA adapter, held in this process.

    `adapter_path` of None is the BASELINE. The same class serves both sides on purpose:
    two classes would be two places for the dtype, the device, and the decoding parameters
    to drift apart, and any drift between them is measured as adapter effect.
    """

    hf_id: str
    adapter_path: Path | None = None
    _model: Any = None
    _tokenizer: Any = None

    def _load(self) -> tuple[Any, Any]:
        if self._model is not None:
            return self._model, self._tokenizer

        import torch  # type: ignore[import-not-found]
        from transformers import AutoModelForCausalLM, AutoTokenizer  # type: ignore[import-not-found]

        tokenizer = AutoTokenizer.from_pretrained(self.hf_id)
        if tokenizer.pad_token is None:
            tokenizer.pad_token = tokenizer.eos_token

        model = AutoModelForCausalLM.from_pretrained(
            self.hf_id,
            # float32 on CPU. Loading the candidate in fp16 on a machine with no device
            # that supports it would make the comparison measure numerics rather than the
            # adapter.
            torch_dtype=torch.float32,
        )

        if self.adapter_path is not None:
            from peft import PeftModel  # type: ignore[import-not-found]

            # UNMERGED (R35b). Merging here would score a different artifact from the one
            # `fetch_artifacts` produced, and merging is R31's job at promotion time.
            model = PeftModel.from_pretrained(model, str(self.adapter_path))

        model.eval()
        self._model, self._tokenizer = model, tokenizer
        return model, tokenizer

    def generate(self, prompt: str) -> str:
        import torch  # type: ignore[import-not-found]

        model, tokenizer = self._load()
        inputs = tokenizer(prompt, return_tensors="pt")
        with torch.no_grad():
            output = model.generate(
                **inputs,
                max_new_tokens=GREEDY_MAX_NEW_TOKENS,
                # GREEDY. `do_sample=True` would make the two sides differ by luck.
                do_sample=False,
                pad_token_id=tokenizer.pad_token_id,
            )
        generated = output[0][inputs["input_ids"].shape[1]:]
        return tokenizer.decode(generated, skip_special_tokens=True)

    def perplexity(self, text: str) -> float:
        """R34a — teacher-forced perplexity: one forward pass with labels, read the loss.

        No generation and no additional dependency. This is the metric build-plan Req 31
        exists to make obtainable: Ollama returns no per-token logprobs on any surface, so
        it cannot be computed through `armada-models` by any route.
        """
        import math

        import torch  # type: ignore[import-not-found]

        model, tokenizer = self._load()
        inputs = tokenizer(text, return_tensors="pt", truncation=True, max_length=2048)
        with torch.no_grad():
            outputs = model(**inputs, labels=inputs["input_ids"])
        return math.exp(float(outputs.loss))

    def close(self) -> None:
        self._model = None
        self._tokenizer = None
