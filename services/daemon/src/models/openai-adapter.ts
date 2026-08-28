/**
 * OpenAICompatibleAdapter — Agent Runtime R9, R16, R17.
 *
 * The daemon's ONLY path to a model. Cross-service boundary 2: forge produces Adapters and
 * registers ModelBindings; the daemon consumes them by tag over the OpenAI-compatible API
 * and never reaches into training. There is deliberately no code here that knows what a
 * LoRA is.
 *
 * THE TAG IS NEVER RE-RESOLVED. `request.tag` arrives from an Agent's pinned
 * `resolved_snapshot` (invariant 2). This adapter passes it through as the `model` field
 * and does no lookup of its own — resolving it here would let a Run silently adopt a newer
 * Adapter, which invariant 2 makes an explicit `refresh-bindings` call instead.
 *
 * STREAMING IS NOT AN OPTIMISATION HERE. R43's wall-clock budget is checked between Steps,
 * but a single model call that never returns would sit inside one Step forever. Consuming a
 * stream lets the AbortSignal cut a call mid-flight, which is what makes invariant 6 —
 * every Run terminates — hold across a hung model server rather than only across a
 * well-behaved one.
 *
 * WHY CAPABILITIES COMES FROM FORGE. `context_window` and `tool_format` are ModelBinding
 * fields, and forge owns the registry. Asking the model server instead would report what
 * the SERVER thinks, which is the wrong authority: the binding is the pinned contract and
 * the server is an implementation of it.
 */

import type {
  ChatDelta,
  ChatRequest,
  ModelAdapter,
  ModelCapabilities,
  ToolFormat,
} from '../kernel/types.js';

export class ModelUnavailableError extends Error {}

export interface OpenAIAdapterOptions {
  /** Base URL of the OpenAI-compatible server. Ollama serves this at /v1. */
  modelsUrl: string;
  /** Where ModelBindings live. Capabilities are registry facts, not server facts. */
  forgeUrl: string;
  /** Injectable so tests need no network. */
  fetchImpl?: typeof fetch;
  /** Applied to the non-streaming capabilities lookup only — chat is bounded by its signal. */
  capabilitiesTimeoutMs?: number;
}

interface StreamChoice {
  delta?: {
    content?: string | null;
    tool_calls?: {
      index?: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }[];
  };
  finish_reason?: string | null;
}

interface StreamChunk {
  choices?: StreamChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface BindingRow {
  tag: string;
  context_window: number;
  tool_format: ToolFormat;
  status: string;
  materialized: boolean;
}

export class OpenAICompatibleAdapter implements ModelAdapter {
  readonly name = 'OpenAICompatibleAdapter';

  private readonly fetchImpl: typeof fetch;
  private readonly capabilitiesTimeoutMs: number;

  constructor(private readonly options: OpenAIAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.capabilitiesTimeoutMs = options.capabilitiesTimeoutMs ?? 10_000;
  }

  async *chat(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatDelta> {
    const res = await this.fetchImpl(`${this.options.modelsUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: request.tag,
        messages: request.messages.map(toWireMessage),
        // An empty tools array is omitted rather than sent. Some servers treat `tools: []`
        // as "tool calling is available but nothing is offered" and emit a call to a tool
        // that does not exist; omitting the key says "no tool calling" unambiguously.
        ...(request.tools && request.tools.length > 0
          ? {
              tools: request.tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.parameters },
              })),
            }
          : {}),
        ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
        stream: true,
        // Usage arrives only if asked for, and the token budget (R31) is unenforceable
        // without it. Without this the loop would count zero tokens forever and
        // max_model_tokens would never trigger — a budget present but not enforcing.
        stream_options: { include_usage: true },
      }),
    });

    if (!res.ok || !res.body) {
      const detail = res.ok ? 'response had no body' : `HTTP ${res.status}`;
      throw new ModelUnavailableError(
        `model server did not accept the request for tag '${request.tag}': ${detail}`,
      );
    }

    // Tool call arguments arrive as a string SPLIT ACROSS DELTAS — a single call's JSON may
    // span many chunks. Accumulated by index and only parsed once the stream ends, because
    // parsing a partial fragment yields either a throw or, worse, a valid-but-truncated
    // object.
    const partials = new Map<number, { id?: string; name?: string; args: string }>();

    for await (const chunk of parseSse(res.body)) {
      if (chunk === '[DONE]') break;

      let parsed: StreamChunk;
      try {
        parsed = JSON.parse(chunk) as StreamChunk;
      } catch {
        // A malformed frame is skipped rather than fatal. One bad chunk should not discard
        // a Step's worth of output that arrived correctly around it.
        continue;
      }

      if (parsed.usage) {
        // Keys are OMITTED when absent rather than set to `undefined` — the daemon compiles
        // with `exactOptionalPropertyTypes`, where `{ promptTokens: undefined }` and `{}`
        // are different types. That strictness is worth keeping here: a consumer adding
        // `?? 0` to a present-but-undefined count would silently stop enforcing R31.
        const usage: ChatDelta = {};
        if (typeof parsed.usage.prompt_tokens === 'number') {
          usage.promptTokens = parsed.usage.prompt_tokens;
        }
        if (typeof parsed.usage.completion_tokens === 'number') {
          usage.completionTokens = parsed.usage.completion_tokens;
        }
        if (usage.promptTokens !== undefined || usage.completionTokens !== undefined) {
          yield usage;
        }
      }

      const choice = parsed.choices?.[0];
      if (!choice) continue;

      if (choice.delta?.content) {
        yield { content: choice.delta.content };
      }

      for (const call of choice.delta?.tool_calls ?? []) {
        const index = call.index ?? 0;
        const entry = partials.get(index) ?? { args: '' };
        if (call.id) entry.id = call.id;
        if (call.function?.name) entry.name = call.function.name;
        if (call.function?.arguments) entry.args += call.function.arguments;
        partials.set(index, entry);
      }
    }

    // Emitted in INDEX order, not completion order. The loop appends tool results to
    // history in model-emission order (runtime.yaml, R24) so a Run replays identically
    // from its event stream regardless of which call finished first.
    for (const [index, entry] of [...partials.entries()].sort((a, b) => a[0] - b[0])) {
      yield {
        toolCall: {
          id: entry.id ?? `call_${index}`,
          name: entry.name ?? '',
          // Left as the raw string when it will not parse. The tool registry validates
          // arguments and reports a useful error; throwing here would fail the whole Step
          // for one malformed call.
          arguments: safeParse(entry.args),
        },
      };
    }

    yield { done: true };
  }

  async capabilities(tag: string): Promise<ModelCapabilities> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.capabilitiesTimeoutMs);
    let rows: BindingRow[];
    try {
      const res = await this.fetchImpl(`${this.options.forgeUrl}/models/bindings`, {
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new ModelUnavailableError(`forge returned HTTP ${res.status} for /models/bindings`);
      }
      rows = (await res.json()) as BindingRow[];
    } catch (err) {
      if (err instanceof ModelUnavailableError) throw err;
      throw new ModelUnavailableError(
        `cannot read ModelBindings from forge: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const binding = rows.find((r) => r.tag === tag);
    if (!binding) {
      // Names the tag. A Run whose pinned binding has been retired should say WHICH tag is
      // gone, not "model not found" — the operator has to know what to re-point.
      throw new ModelUnavailableError(
        `no ModelBinding registered for tag '${tag}'. It may have been retired; ` +
          `run refresh-bindings on the Agent to adopt a current one.`,
      );
    }

    return {
      toolCalling: true,
      contextWindow: binding.context_window,
      toolFormat: binding.tool_format,
    };
  }
}

function toWireMessage(m: {
  role: string;
  content: string;
  toolCallId?: string;
  toolCalls?: { id: string; name: string; arguments: unknown }[];
}): Record<string, unknown> {
  return {
    role: m.role,
    content: m.content,
    ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
    ...(m.toolCalls && m.toolCalls.length > 0
      ? {
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.arguments) },
          })),
        }
      : {}),
  };
}

function safeParse(raw: string): unknown {
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Server-Sent Events, framed by blank lines.
 *
 * Written out rather than pulled in as a dependency: this is the whole of what the format
 * needs for one well-specified producer, and the repo has no SSE library.
 *
 * THE BUFFER MATTERS. A `data:` line can be split across TCP reads, so decoding each chunk
 * independently would silently drop the tail of one frame and the head of the next. Held
 * until a blank line proves the frame is complete.
 */
async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split('\n')) {
          const trimmed = line.trimStart();
          if (trimmed.startsWith('data:')) yield trimmed.slice(5).trim();
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
    // A final frame with no trailing blank line still carries data.
    for (const line of buffer.split('\n')) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('data:')) yield trimmed.slice(5).trim();
    }
  } finally {
    reader.releaseLock();
  }
}
