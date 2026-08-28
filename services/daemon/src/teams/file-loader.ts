/**
 * The `teams/` directory loader — Team Orchestration R41, R45.
 *
 * "Teams are also file-loaded from `teams/*.yaml` on startup and on file change, with the
 * SAME upsert-by-`name`, collision, and skip-on-invalid behavior as Agents." This file is
 * that sentence, and it deliberately mirrors `agents/file-loader.ts` structurally so the
 * two cannot drift into behaving differently.
 *
 * AN INVALID FILE IS SKIPPED, NEVER FATAL. Its path and full error list are reported and
 * the remaining files still load. A malformed example must not prevent an operator's own
 * Teams from loading, and it must not block startup.
 *
 * TWO FILES DECLARING THE SAME `name` LOAD **NEITHER**. Loading one would make the winner
 * depend on directory order, so an operator who duplicated a file would get a Team whose
 * roster is whichever the filesystem happened to return first.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ValidationError } from '../agents/definition-schema.js';
import type { TeamStore } from './store.js';
import { validateTeam, type TeamValidationContext } from './validator.js';

export interface TeamLoadOutcome {
  path: string;
  name?: string;
  status: 'loaded' | 'unchanged' | 'skipped';
  version?: number;
  errors?: ValidationError[];
  reason?: string;
}

interface ParsedTeamFile {
  path: string;
  raw: unknown;
  name: string | null;
}

async function parseFiles(dir: string): Promise<{ parsed: ParsedTeamFile[]; outcomes: TeamLoadOutcome[] }> {
  const outcomes: TeamLoadOutcome[] = [];
  const parsed: ParsedTeamFile[] = [];

  let entries: string[];
  try {
    entries = (await readdir(dir)).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  } catch {
    // No teams/ directory is legitimate — an installation may manage Teams purely through
    // the API, or run no Teams at all.
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
      // The parser's message carries the line number, which is what an operator fixes.
      outcomes.push({
        path,
        status: 'skipped',
        reason: `YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { parsed, outcomes };
}

export async function loadTeamDirectory(
  dir: string,
  store: TeamStore,
  ctx: TeamValidationContext,
): Promise<TeamLoadOutcome[]> {
  const { parsed, outcomes } = await parseFiles(dir);

  // Collisions are found BEFORE anything loads, so neither file wins.
  const byName = new Map<string, string[]>();
  for (const file of parsed) {
    if (!file.name) continue;
    byName.set(file.name, [...(byName.get(file.name) ?? []), file.path]);
  }
  const collided = new Set<string>();
  for (const [name, paths] of byName) {
    if (paths.length < 2) continue;
    collided.add(name);
    for (const path of paths) {
      outcomes.push({
        path,
        name,
        status: 'skipped',
        reason:
          `duplicate \`name: ${name}\` also declared in ` +
          `${paths.filter((p) => p !== path).join(', ')}; neither file was loaded`,
      });
    }
  }

  for (const file of parsed) {
    if (file.name && collided.has(file.name)) continue;

    const result = validateTeam(file.raw, ctx);
    if (result.errors.length > 0 || !result.definition || !result.roster) {
      outcomes.push({
        path: file.path,
        ...(file.name ? { name: file.name } : {}),
        status: 'skipped',
        errors: result.errors,
      });
      continue;
    }

    try {
      const saved = await store.save(result.definition, result.roster);
      outcomes.push({
        path: file.path,
        name: result.definition.name,
        status: saved.created ? 'loaded' : 'unchanged',
        version: saved.version,
      });
    } catch (err) {
      // A database fault is per-file: it must not abort the whole load.
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
export function formatTeamOutcomes(outcomes: TeamLoadOutcome[]): string {
  return outcomes
    .map((outcome) => {
      if (outcome.status === 'skipped') {
        const detail =
          outcome.reason ?? (outcome.errors ?? []).map((e) => `${e.path}: ${e.message}`).join('; ');
        return `  ❌ ${outcome.path} — ${detail}`;
      }
      return `  ✅ ${outcome.path} — ${outcome.name} v${outcome.version}${
        outcome.status === 'unchanged' ? ' (unchanged)' : ''
      }`;
    })
    .join('\n');
}
