/**
 * The Kernel — plugin host and capability resolution. Agent Runtime R8, R14, R15.
 *
 * Contains NO agent logic. It owns registration, resolution, and lifecycle; the loop that
 * arrives in P7 asks the Kernel for capabilities and never constructs one itself.
 *
 * R15 is the property this class exists to make true: nothing outside this file and the
 * factory tables it is handed knows which concrete implementation backs an interface.
 * `kernel.get('RetrievalProvider')` is the only way to reach retrieval, which is what
 * lets config/plugins.yaml swap it for a stub with no edit to the loop.
 */

import type { Pool } from 'pg';
import { PLUGIN_INTERFACES, type PluginInterface, type PluginMap } from './types.js';
import {
  PluginConfigError,
  loadPluginsConfig,
  resolveFactories,
  type FactoryTables,
  type PluginDeps,
} from './plugin-registry.js';

export interface KernelOptions {
  pluginsConfigPath: string;
  pool: Pool;
  credentialEnvNames: string[];
  config: Record<string, unknown>;
  factories: FactoryTables;
}

export class Kernel {
  private readonly instances = new Map<PluginInterface, unknown>();

  private constructor(private readonly selection: Record<PluginInterface, string>) {}

  /**
   * Load config, resolve every interface, and construct each implementation.
   *
   * THROWS PluginConfigError CARRYING EVERY PROBLEM. The caller turns that into a non-zero
   * exit (R14). Collecting rather than throwing on the first means an operator with two
   * bad entries fixes both in one pass.
   */
  static register(options: KernelOptions): Kernel {
    const selection = loadPluginsConfig(options.pluginsConfigPath);
    const resolved = resolveFactories(selection, options.factories);

    const kernel = new Kernel(selection);
    const deps: PluginDeps = {
      pool: options.pool,
      credentialEnvNames: options.credentialEnvNames,
      config: options.config,
    };

    const constructionProblems: string[] = [];
    for (const iface of PLUGIN_INTERFACES) {
      try {
        kernel.instances.set(iface, resolved[iface](deps));
      } catch (err) {
        // R14 — a plugin that FAILS TO LOAD is named, not merely counted.
        constructionProblems.push(
          `${iface}: \`${selection[iface]}\` failed to construct: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    if (constructionProblems.length > 0) throw new PluginConfigError(constructionProblems);

    return kernel;
  }

  /**
   * True once every declared interface is registered — half of R3a's health gate.
   *
   * Derived rather than flagged: register() is the only path to an instance and it throws
   * before returning if any interface is missing, so the map size IS the fact.
   */
  get isReady(): boolean {
    return this.instances.size === PLUGIN_INTERFACES.length;
  }

  /** What GET /api/health reports as `plugins` (R3a). */
  describe(): { interface: PluginInterface; implementation: string }[] {
    return PLUGIN_INTERFACES.map((iface) => ({
      interface: iface,
      implementation: this.selection[iface],
    }));
  }

  /**
   * Resolve a capability by interface name.
   *
   * The single door through which the loop reaches any implementation. Throws rather than
   * returning undefined: an unregistered interface is a programming fault, and startup
   * has already guaranteed every interface is present.
   */
  get<K extends PluginInterface>(iface: K): PluginMap[K] {
    const instance = this.instances.get(iface);
    if (!instance) throw new Error(`Kernel: interface \`${iface}\` is not registered`);
    return instance as PluginMap[K];
  }
}
