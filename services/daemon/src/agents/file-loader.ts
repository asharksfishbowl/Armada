/**
 * The `agents/` directory loader — Agent Definition R31, R32; edges 3, 4, 16, 17.
 *
 * On startup and on file change, every `*.yaml` in `agents/` is loaded and upserted by
 * `name`. File-loaded and API-created Agents share ONE namespace (R32), so a file whose
 * name matches an API-created Agent creates a new version of that same Agent.
 *
 * AN INVALID FILE IS SKIPPED, NEVER FATAL (R31). Its path and full error list are logged
 * and the remaining files still load. A malformed example must not prevent an operator's
 * own Agents from loading, and it must not block startup.
 *
 * EDGE 3 — TWO FILES DECLARING THE SAME `name` LOAD **NEITHER**. Loading one would make
 * the winner depend on directory order, so an operator who duplicated a file would get an
 * Agent whose definition is whichever the filesystem happened to return first. Refusing
 * both, and logging both paths, is the only outcome that cannot be silently wrong.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AgentDefinition, ValidationError } from './definition-schema.js';
import { buildSnapshot } from './resolver.js';
import type { AgentStore } from './store.js';
import { validate, type ValidationContext } from './validator.js';

export interface LoadOutcome {
  path: string;
  name?: string;
  status: 'loaded' | 'unchanged' | 'skipped';
  version?: number;
  errors?: ValidationError[];
  reason?: string;
}

interface ParsedFile {
  path: string;
  raw: unknown;
  name: string | null;
}

async function parseFiles(dir: string): Promise<{ parsed: ParsedFile[]; outcomes: LoadOutcome[] }> {
  const outcomes: LoadOutcome[] = [];
  const parsed: ParsedFile[] = [];

  let entries: string[];
  try {
    entries = (await readdir(dir)).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  } catch {
    // No agents/ directory is legitimate — an installation may manage Agents purely
    // through the API.
    return { parsed, outcomes };
  }

  for (const entry of entries.sort()) {
    const path = join(dir, entry);
    try {
      const raw = parseYaml(await readFile(path, 'utf8'));
      const name =
        raw && typeof raw === 'object' && typeof (raw as { name?: unknown }).name === 'string'
          ? (raw as { name: string }).name
          : null;
      parsed.push({ path, raw, name });
    } catch (err) {
      // Edge 17 — a YAML parse error is logged with path AND the parser's message, which
      // carries the line number. Then it is skipped.
      outcomes.push({
        path,
        status: 'skipped',
        reason: `YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { parsed, outcomes };
}

export async function loadAgentDirectory(
  dir: string,
  store: AgentStore,
  ctx: ValidationContext,
): Promise<LoadOutcome[]> {
  const { parsed, outcomes } = await parseFiles(dir);

  // Edge 3 — find name collisions BEFORE loading anything, so neither file wins.
  const byName = new Map<string, string[]>();
  for (const file of parsed) {
    if (!file.name) continue;
    byName.set(file.name, [...(byName.get(file.name) ?? []), file.path]);
  }
  const collided = new Set<string>();
  for (const [name, paths] of byName) {
    if (paths.length > 1) {
      collided.add(name);
      for (const path of paths) {
        outcomes.push({
          path,
          name,
          status: 'skipped',
          reason: `duplicate \`name: ${name}\` also declared in ${paths.filter((p) => p !== path).join(', ')}; neither file was loaded`,
        });
      }
    }
  }

  for (const file of parsed) {
    if (file.name && collided.has(file.name)) continue;

    const result = validate(file.raw, ctx);
    if (result.errors.length > 0 || !result.definition || !result.resolved) {
      // R31 — log path and the FULL error list, then skip. Other files still load.
      outcomes.push({ path: file.path, ...(file.name ? { name: file.name } : {}), status: 'skipped', errors: result.errors });
      continue;
    }

    const snapshot = buildSnapshot(
      result.definition,
      result.resolved.binding,
      result.resolved.corpusId,
      result.warnings,
      ctx,
    );

    try {
      const saved = await store.save(result.definition as AgentDefinition, snapshot);
      outcomes.push({
        path: file.path,
        name: result.definition.name,
        status: saved.created ? 'loaded' : 'unchanged',
        version: saved.version,
      });
    } catch (err) {
      // Edge 16 — forge unreachable during validation surfaces earlier, but a database
      // fault here is also per-file: it must not abort the whole load.
      outcomes.push({
        path: file.path,
        ...(file.name ? { name: file.name } : {}),
        status: 'skipped',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return outcomes;
}

/** Render outcomes for the startup log — path first, because that is what an operator fixes. */
export function formatOutcomes(outcomes: LoadOutcome[]): string {
  return outcomes
    .map((outcome) => {
      if (outcome.status === 'skipped') {
        const detail = outcome.reason ?? (outcome.errors ?? []).map((e) => `${e.path}: ${e.message}`).join('; ');
        return `  ❌ ${outcome.path} — ${detail}`;
      }
      return `  ✅ ${outcome.path} — ${outcome.name} v${outcome.version}${outcome.status === 'unchanged' ? ' (unchanged)' : ''}`;
    })
    .join('\n');
}
