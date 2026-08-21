/**
 * Plugin selection from config/plugins.yaml — Agent Runtime R14.
 *
 * The Kernel registers plugins declared here at startup and EXITS NON-ZERO NAMING THE
 * PLUGIN if one fails to load or a required interface is left unregistered. A daemon that
 * started with a missing RetrievalProvider would fail on the first Step of the first Run
 * bound to a Corpus — long after startup reported healthy, and with an error that names a
 * retrieval failure rather than a configuration fault.
 *
 * Factories are registered by name here rather than imported dynamically by string,
 * because a build that cannot see its implementations cannot type-check them, and R15's
 * whole point is that the LOOP does not import them — not that nothing does.
 */

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { PLUGIN_INTERFACES, type PluginInterface } from './types.js';

export class PluginConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('\n'));
    this.name = 'PluginConfigError';
  }
}

/**
 * Read and validate config/plugins.yaml.
 *
 * Collects EVERY problem rather than throwing on the first, so an operator fixing a
 * plugins file sees the whole list in one startup instead of one error per restart.
 */
export function loadPluginsConfig(path: string): Record<PluginInterface, string> {
  const problems: string[] = [];
  let parsed: { plugins?: Record<string, string> } | undefined;

  try {
    parsed = parseYaml(readFileSync(path, 'utf8')) as { plugins?: Record<string, string> };
  } catch (err) {
    throw new PluginConfigError([
      `${path}: ${err instanceof Error ? err.message : String(err)}`,
    ]);
  }

  const declared = parsed?.plugins;
  if (!declared || typeof declared !== 'object') {
    throw new PluginConfigError([`${path}: missing a top-level \`plugins\` mapping`]);
  }

  const selection = {} as Record<PluginInterface, string>;

  for (const iface of PLUGIN_INTERFACES) {
    const impl = declared[iface];
    if (typeof impl !== 'string' || !impl) {
      // R14 — name the interface. "a plugin is missing" is not actionable.
      problems.push(`${path}: no implementation declared for interface \`${iface}\``);
      continue;
    }
    selection[iface] = impl;
  }

  // An unknown key is a typo that would otherwise leave an interface silently
  // unregistered while the operator believes they configured it.
  for (const key of Object.keys(declared)) {
    if (!PLUGIN_INTERFACES.includes(key as PluginInterface)) {
      problems.push(
        `${path}: unknown interface \`${key}\`; expected one of ${PLUGIN_INTERFACES.join(', ')}`,
      );
    }
  }

  if (problems.length > 0) throw new PluginConfigError(problems);
  return selection;
}

/**
 * A factory that builds one plugin implementation.
 *
 * `deps` carries what implementations need (the pool, config) without making every
 * factory take the same positional arguments.
 */
export type PluginFactory = (deps: PluginDeps) => unknown;

export interface PluginDeps {
  pool: import('pg').Pool;
  credentialEnvNames: string[];
  config: Record<string, unknown>;
}

/**
 * Implementations available to be selected, keyed by the name used in plugins.yaml.
 *
 * A name in plugins.yaml that is absent from the matching table is a startup failure
 * naming both the interface and the name (R14).
 */
export type FactoryTables = Record<PluginInterface, Record<string, PluginFactory>>;

export function resolveFactories(
  selection: Record<PluginInterface, string>,
  tables: FactoryTables,
): Record<PluginInterface, PluginFactory> {
  const resolved = {} as Record<PluginInterface, PluginFactory>;
  const problems: string[] = [];

  for (const iface of PLUGIN_INTERFACES) {
    const name = selection[iface];
    const table = tables[iface];
    const factory = table[name];

    if (!factory) {
      const available = Object.keys(table);
      problems.push(
        `config/plugins.yaml: \`${iface}: ${name}\` is not a known implementation` +
          (available.length ? `; available: ${available.join(', ')}` : ''),
      );
      continue;
    }
    resolved[iface] = factory;
  }

  if (problems.length > 0) throw new PluginConfigError(problems);
  return resolved;
}
