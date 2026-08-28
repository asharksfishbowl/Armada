/**
 * MCP wire protocol — JSON-RPC 2.0 message shapes and result parsing.
 *
 * IMPLEMENTED RATHER THAN DEPENDED ON. Armada is proprietary and the licence rules forbid
 * a GPL/AGPL dependency; more practically, the three methods a tool-consuming client needs
 * — `initialize`, `tools/list`, `tools/call` — are a few hundred lines including both
 * transports, which is less than the surface of an SDK that also implements prompts,
 * resources, sampling, roots and elicitation that this daemon will never send.
 *
 * NOTHING HERE PERFORMS I/O. It is shapes and pure functions, so the parsing rules can be
 * tested without a server and the transports can be tested without the parsing.
 */

import type { ToolResult, ToolSpec } from '../kernel/types.js';
import { namespacedToolName } from './naming.js';

/**
 * The protocol revision this client speaks.
 *
 * A server that speaks a different revision answers `initialize` with its own; the client
 * records it and proceeds, because tool listing and tool calling have been stable across
 * every published revision and refusing to talk would degrade a Run over a version string.
 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

export const MCP_CLIENT_INFO = { name: 'armada-daemon', version: '0.1.0' } as const;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: JsonRpcError;
}

export type JsonRpcOutbound = JsonRpcRequest | JsonRpcNotification;

export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  if (typeof message['id'] !== 'number') return false;
  return 'result' in message || 'error' in message;
}

/** An inbound REQUEST — a server asking the client for something. */
export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return typeof message['method'] === 'string' && typeof message['id'] === 'number';
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ToolsListPage {
  tools: McpToolDescriptor[];
  nextCursor: string | null;
}

/**
 * Parse a `tools/list` result.
 *
 * Tolerant of a missing description or schema and INTOLERANT of a missing name: a tool
 * without a name cannot be called, so offering it to the model would guarantee a wasted
 * Step. Such entries are dropped rather than faked.
 */
export function parseToolsList(result: unknown): ToolsListPage {
  const record = (result ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(record['tools']) ? record['tools'] : [];
  const cursor = record['nextCursor'];

  const tools: McpToolDescriptor[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const tool = entry as Record<string, unknown>;
    const name = tool['name'];
    if (typeof name !== 'string' || name.length === 0) continue;

    tools.push({
      name,
      ...(typeof tool['description'] === 'string' ? { description: tool['description'] } : {}),
      ...(tool['inputSchema'] && typeof tool['inputSchema'] === 'object'
        ? { inputSchema: tool['inputSchema'] as Record<string, unknown> }
        : {}),
    });
  }

  return { tools, nextCursor: typeof cursor === 'string' && cursor.length > 0 ? cursor : null };
}

/**
 * R51 — one server's tool, as the model sees it.
 *
 * A server that supplies no `inputSchema` gets an empty object schema rather than none:
 * `ToolSpec.parameters` is required, and a model handed `undefined` where a JSON Schema
 * belongs produces a request the model server rejects, which reads as a daemon fault.
 */
export function toToolSpec(server: string, tool: McpToolDescriptor): ToolSpec {
  return {
    name: namespacedToolName(server, tool.name),
    description: tool.description ?? `\`${tool.name}\` on the \`${server}\` MCP server.`,
    parameters: tool.inputSchema ?? { type: 'object', properties: {} },
  };
}

/**
 * Parse a `tools/call` result into a ToolResult.
 *
 * `isError: true` from a server is the server saying THE TOOL failed, which is exactly
 * Armada's `is_error` tool_result: the model sees the failure and gets another Step (R29,
 * R30). It is never a Run-terminating condition.
 */
export function parseToolCall(result: unknown): ToolResult {
  const record = (result ?? {}) as Record<string, unknown>;
  const isError = record['isError'] === true;
  const blocks = Array.isArray(record['content']) ? record['content'] : [];

  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const item = block as Record<string, unknown>;

    if (item['type'] === 'text' && typeof item['text'] === 'string') {
      parts.push(item['text']);
      continue;
    }
    if (item['type'] === 'resource' && item['resource'] && typeof item['resource'] === 'object') {
      const resource = item['resource'] as Record<string, unknown>;
      const uri = typeof resource['uri'] === 'string' ? resource['uri'] : 'resource';
      const text = typeof resource['text'] === 'string' ? resource['text'] : null;
      parts.push(text === null ? `[${uri}]` : `--- ${uri}\n${text}`);
      continue;
    }
    // An image or audio block. The model reaches this daemon over a text-only
    // OpenAI-compatible chat API, so naming the block honestly beats base64 in the
    // transcript — which would blow the context window and teach the model nothing.
    parts.push(`[${typeof item['type'] === 'string' ? item['type'] : 'unknown'} content omitted]`);
  }

  if (parts.length === 0 && record['structuredContent'] !== undefined) {
    parts.push(JSON.stringify(record['structuredContent']));
  }

  const content = parts.join('\n').trim();
  return {
    content: content.length > 0 ? content : '(the tool returned no content)',
    ...(isError ? { isError: true } : {}),
  };
}
