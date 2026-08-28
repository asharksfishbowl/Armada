"""R18 — render a sample with the target BaseModel's `chat_template`.

RENDERED FROM PLAIN STRING TEMPLATES, NOT FROM A TOKENIZER. The forge image sets
`HF_HUB_OFFLINE=1` (roadmap F7) and only the baked smoke model's weights are present on a
fresh installation, so `AutoTokenizer.apply_chat_template` would fail for every entry an
operator has not materialized. Dataset construction must work for every `trainable`
shortlist entry on first boot, which rules out depending on weights being on disk.

The three renderers below are the published formats for the three values
`config/base-models.yaml` admits for `chat_template`. A fourth value cannot reach this
module — config.py rejects it at startup (VALID_CHAT_TEMPLATES) — so the dispatch has no
silent fallthrough: an unknown template raises rather than rendering something plausible.
"""

from __future__ import annotations

from typing import Any

# The role vocabulary a flattened sample can carry. `tool` exists because R17 preserves
# tool results in original order, and a tool result rendered as an assistant turn would
# teach the adapter that the model produced its own tool output.
VALID_ROLES: frozenset[str] = frozenset({"system", "user", "assistant", "tool"})


class UnknownChatTemplate(Exception):
    """Raised for a `chat_template` value config.py should already have rejected."""


def _qwen3(messages: list[dict[str, str]]) -> str:
    """ChatML. Qwen3 reads `tool` verbatim as a role."""
    return "".join(
        f"<|im_start|>{message['role']}\n{message['content']}<|im_end|>\n"
        for message in messages
    )


def _llama3(messages: list[dict[str, str]]) -> str:
    """Llama 3 header format.

    Tool results ride the `ipython` role, which is the role Llama 3 was trained to read
    them under; sending them as `user` would misattribute machine output to the operator.
    """
    parts = ["<|begin_of_text|>"]
    for message in messages:
        role = "ipython" if message["role"] == "tool" else message["role"]
        parts.append(
            f"<|start_header_id|>{role}<|end_header_id|>\n\n{message['content']}<|eot_id|>"
        )
    return "".join(parts)


def _gemma3(messages: list[dict[str, str]]) -> str:
    """Gemma has TWO roles, `user` and `model`, and no system role at all.

    A system prompt is therefore folded into the following user turn, and a tool result is
    rendered as a user turn, because those are the only turns Gemma can represent.
    Dropping the system prompt instead would train the adapter without its persona — quiet
    data corruption, and the worst kind to discover after a training run has been paid for.
    """
    parts: list[str] = []
    pending_system: list[str] = []

    for message in messages:
        role, content = message["role"], message["content"]

        if role == "system":
            pending_system.append(content)
            continue

        if role == "assistant":
            parts.append(f"<start_of_turn>model\n{content}<end_of_turn>\n")
            continue

        body = content if role == "user" else f"<tool_response>\n{content}\n</tool_response>"
        if pending_system:
            body = "\n\n".join([*pending_system, body])
            pending_system = []
        parts.append(f"<start_of_turn>user\n{body}<end_of_turn>\n")

    # A conversation that was nothing but a system prompt still has to render it.
    if pending_system:
        parts.append("<start_of_turn>user\n" + "\n\n".join(pending_system) + "<end_of_turn>\n")

    return "".join(parts)


_RENDERERS = {"qwen3": _qwen3, "llama3": _llama3, "gemma3": _gemma3}


def render(messages: list[dict[str, str]], chat_template: str) -> str:
    """R18 — render an ordered message list for `chat_template`."""
    renderer = _RENDERERS.get(chat_template)
    if renderer is None:
        raise UnknownChatTemplate(
            f"`{chat_template}` is not a known chat template; expected one of "
            f"{', '.join(sorted(_RENDERERS))}"
        )
    return renderer(messages)


def messages_for(sample: dict[str, Any]) -> list[dict[str, str]]:
    """The ordered message list for a sample, whatever its origin.

    A trajectory sample carries `messages` already (R17 flattens a whole Run). A supplied
    or distilled sample is a single instruction/response pair, which is the two-message
    case of the same shape — so there is ONE renderer rather than two code paths that could
    drift apart.
    """
    existing = sample.get("messages")
    if isinstance(existing, list) and existing:
        return [
            {"role": str(m.get("role", "user")), "content": str(m.get("content", ""))}
            for m in existing
        ]
    return [
        {"role": "user", "content": str(sample.get("instruction", ""))},
        {"role": "assistant", "content": str(sample.get("response", ""))},
    ]
