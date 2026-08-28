/**
 * DockerSandboxProvider — Agent Runtime R44-R49; build-plan Req 28-30.
 *
 * One container per Run, created as a SIBLING of armada-daemon over the mounted host
 * Docker socket (R45a).
 *
 * ── THE PRIVILEGE DECISION, STATED RATHER THAN IMPLIED ──────────────────────
 * Holding /var/run/docker.sock is root-equivalent on the host. R45a makes that a
 * requirement rather than an accident of a Dockerfile precisely because it is the
 * highest-privilege decision in the deployment. It violates no invariant — invariant 3
 * governs the SANDBOX boundary, and Armada is single-operator on a trusted network — but
 * it must be visible.
 *
 * INVARIANT 3 IS ENFORCED HERE, IN ONE DIRECTION. The daemon reaches into a sandbox;
 * nothing in a sandbox reaches out. Concretely: THE DAEMON'S SOCKET MOUNT IS NEVER
 * PROPAGATED INTO A SANDBOX (R46). A sandbox with the socket could provision an
 * unconstrained container and escape, which is why the mount appears in exactly one place
 * in this file — the daemon's own client — and never in a container spec.
 *
 * ── WHY EDGE 7 IS NOT A stat ────────────────────────────────────────────────
 * Edge 7 requires Run start to fail when `workspace_path` does not exist ON THE HOST. The
 * daemon runs in a container and cannot see an arbitrary host path, so a stat would be
 * checking the wrong filesystem — it would pass for a path that exists in the daemon image
 * and fail for one that exists only on the host.
 *
 * R45c resolves it: every workspace resolves beneath ARMADA_WORKSPACE_ROOT, bind-mounted
 * into the daemon at the SAME path it occupies on the host. The daemon then verifies a
 * path it has actually mounted, and Docker resolves that same path against the host when
 * it creates the container. The spec forbids the stat approach explicitly; this
 * implementation follows the mounted-root form.
 *
 * ── P14: `egress_allowlist` IS NOW REAL, WHICH IS WHY IT IS NO LONGER REFUSED ─
 * Build-plan Req 29 refused the mode at config load "before Phase 14", on the grounds that
 * a profile appearing to filter egress while filtering nothing is worse than an honest
 * rejection. This is Phase 14. The mode is accepted ONLY when the subsystem behind it can
 * actually be provisioned — `egress.proxy_image` must be configured, and every
 * `allowed_hosts` entry must parse — and it is still refused, naming every fault, when it
 * cannot. The mechanism and its honest limits are documented in `egress.ts`.
 */

import { execFile, spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import {
  DEFAULT_PROXY_PORT,
  EGRESS_NETWORK_PREFIX,
  PROXY_ALIAS,
  PROXY_IMAGE_ENV,
  PROXY_READY_LINE,
  buildNetworkConnectArgs,
  buildNetworkCreateArgs,
  buildProxyCreateArgs,
  egressNetworkName,
  parseAllowedHost,
  type HostRule,
  type ResolvedEgress,
} from './egress.js';
import type {
  ExecResult,
  Sandbox,
  SandboxProvider,
  SandboxSpec,
} from '../kernel/types.js';

/** The label every sandbox carries, so the orphan sweep can find them (Req 30). */
export const RUN_ID_LABEL = 'armada.run_id';

export const DOCKER_SOCKET = '/var/run/docker.sock';

export interface SandboxProfile {
  image: string;
  cpu_limit: number;
  memory_limit: string;
  network: 'none' | 'egress_allowlist';
  allowed_hosts: string[];
  read_only_root: boolean;
  armada_tmpfs_size: string;
  timeout_seconds: number;
  /**
   * Present if and only if `network` is `egress_allowlist`. Resolved at config load, so
   * nothing downstream re-derives an allowlist from raw YAML at Run time.
   */
  egress?: ResolvedEgress;
}

/** The optional `egress:` block of config/sandbox-profiles.yaml. */
export interface EgressSubsystemConfig {
  proxy_image?: unknown;
  proxy_port?: unknown;
}

export class SandboxConfigError extends Error {}

/**
 * Validate profiles at CONFIG LOAD — build-plan Req 29, Agent Runtime R44/R47.
 *
 * EVERY fault in the file is collected and reported at once. A daemon that exits on the
 * first bad `allowed_hosts` entry costs an operator one restart per typo.
 *
 * `network: egress_allowlist` is accepted only when the subsystem that implements it can
 * actually be provisioned. When it cannot, the profile is REFUSED, naming what is missing
 * — never downgraded to `none`. The downgrade is the security fault Req 29 named: a
 * profile that asked for a restricted network and quietly received no network still
 * *looks* like it is enforcing an allowlist, and an operator reading the config would
 * believe egress is filtered to `allowed_hosts` when nothing is filtered at all.
 */
export function validateProfiles(
  profiles: Record<string, Partial<SandboxProfile>>,
  egressConfig?: unknown,
  env: Record<string, string | undefined> = process.env,
): Record<string, SandboxProfile> {
  const problems: string[] = [];
  const validated: Record<string, SandboxProfile> = {};

  const block = (egressConfig ?? {}) as EgressSubsystemConfig;
  // An env var overrides the file so a deployment can name its own image without editing
  // config, which is mounted read-only.
  const proxyImageRaw = env[PROXY_IMAGE_ENV] ?? block.proxy_image;
  const proxyImage = typeof proxyImageRaw === 'string' ? proxyImageRaw.trim() : '';
  let proxyPort = DEFAULT_PROXY_PORT;
  if (block.proxy_port !== undefined) {
    const port = Number(block.proxy_port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      problems.push(
        `config/sandbox-profiles.yaml: \`egress.proxy_port\` is \`${String(block.proxy_port)}\`; it must be an integer port`,
      );
    } else {
      proxyPort = port;
    }
  }

  for (const [name, profile] of Object.entries(profiles)) {
    const where = `config/sandbox-profiles.yaml: profile \`${name}\``;
    const network = profile.network;

    if (network !== 'none' && network !== 'egress_allowlist') {
      problems.push(
        `${where} has network \`${String(network)}\`; supported values are \`none\` and \`egress_allowlist\``,
      );
      continue;
    }
    if (!profile.image) {
      problems.push(`${where} is missing \`image\``);
      continue;
    }

    const allowedHosts = profile.allowed_hosts ?? [];
    let egress: ResolvedEgress | undefined;

    if (network === 'egress_allowlist') {
      const rules: HostRule[] = [];
      if (!Array.isArray(allowedHosts) || allowedHosts.length === 0) {
        problems.push(
          `${where} declares \`network: egress_allowlist\` with no \`allowed_hosts\`. An empty ` +
            'allowlist reaches nothing while looking like it filters something; use ' +
            '`network: none` if the sandbox should have no egress.',
        );
      } else {
        for (const entry of allowedHosts) {
          const parsed = parseAllowedHost(entry);
          if (parsed.ok) rules.push(parsed.rule);
          else problems.push(`${where}: \`allowed_hosts\` ${parsed.error}`);
        }
      }

      if (proxyImage === '') {
        // Refusing here is the P14 form of Req 29. The mode is implemented, but this
        // deployment cannot provision the proxy, so the profile would filter nothing.
        problems.push(
          `${where} declares \`network: egress_allowlist\`, but no egress proxy image is ` +
            `configured. Set \`egress.proxy_image\` in config/sandbox-profiles.yaml or ` +
            `${PROXY_IMAGE_ENV} in the environment to an image carrying the daemon's ` +
            '`dist/` (the armada-daemon image). This is refused rather than downgraded to ' +
            '`none` so a profile can never appear to filter egress while filtering nothing.',
        );
      }

      if (rules.length > 0 && proxyImage !== '') {
        egress = {
          proxyImage,
          proxyPort,
          allowedHosts: allowedHosts.map(String),
          rules,
        };
      }
    } else if (Array.isArray(allowedHosts) && allowedHosts.length > 0) {
      // A requirement enforced nowhere is decorative, and so is a host list that filters
      // nothing. Say so at boot rather than letting it read as a working allowlist.
      problems.push(
        `${where} lists \`allowed_hosts\` under \`network: none\`, where the list is never ` +
          'consulted. Either declare `network: egress_allowlist` or remove the list.',
      );
    }

    validated[name] = {
      image: profile.image,
      cpu_limit: profile.cpu_limit ?? 1,
      memory_limit: profile.memory_limit ?? '512m',
      network,
      allowed_hosts: Array.isArray(allowedHosts) ? allowedHosts.map(String) : [],
      read_only_root: profile.read_only_root ?? false,
      // R44a — a default rather than an option to omit: /armada must exist on every
      // sandbox or spill and Code mode break under read_only_root.
      armada_tmpfs_size: profile.armada_tmpfs_size ?? '64m',
      timeout_seconds: profile.timeout_seconds ?? 300,
      ...(egress ? { egress } : {}),
    };
  }

  if (problems.length > 0) throw new SandboxConfigError(problems.join('\n'));
  return validated;
}

/**
 * Verify a workspace against the mounted shared root — R45c, edge 7.
 *
 * Two failures, both before any container is created:
 *   - the path escapes ARMADA_WORKSPACE_ROOT (which would ask Docker to mount an
 *     arbitrary host path into a sandbox — the containment this root exists to provide)
 *   - the path does not exist beneath it
 */
export async function verifyWorkspace(
  workspacePath: string,
  workspaceRoot: string,
): Promise<{ ok: true; resolved: string } | { ok: false; error: string }> {
  if (!isAbsolute(workspacePath)) {
    return { ok: false, error: `workspace_path \`${workspacePath}\` must be an absolute path` };
  }

  const root = resolve(workspaceRoot);
  const resolved = resolve(workspacePath);

  // Containment check first. `${root}${sep}` rather than a bare prefix so a sibling
  // directory named like the root — /workspaces-evil against /workspaces — cannot pass.
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    return {
      ok: false,
      error:
        `workspace_path \`${workspacePath}\` must resolve beneath ARMADA_WORKSPACE_ROOT ` +
        `(\`${root}\`); the daemon can only mount paths under that shared root`,
    };
  }

  try {
    const info = await stat(resolved);
    if (!info.isDirectory()) {
      return { ok: false, error: `workspace_path \`${workspacePath}\` is not a directory` };
    }
  } catch {
    // Edge 7 — this is a filesystem check against a path the daemon HAS MOUNTED, which is
    // what makes it meaningful. It is not a stat against an arbitrary unmounted host path.
    return { ok: false, error: `workspace_path \`${workspacePath}\` does not exist` };
  }

  return { ok: true, resolved };
}

/**
 * Build the `docker run -d` argument list. Exported so tests can assert it.
 *
 * One spawn rather than create-then-start: two calls also meant a rollback path for the
 * window where create succeeded and start failed, leaving a container to clean up.
 */
export function buildCreateArgs(
  spec: SandboxSpec,
  profile: SandboxProfile,
  workspacePath: string | null,
  egressNetwork?: { networkName: string; proxyPort: number },
): string[] {
  // The two modes are mutually exclusive and the mismatch is a bug, not a fallback. A
  // caller that passed no network for an allowlist profile would otherwise get `none`,
  // which is the silent downgrade Req 29 exists to forbid; a caller that passed one for a
  // `none` profile would have opened egress nobody asked for.
  if (profile.network === 'egress_allowlist' && !egressNetwork) {
    throw new Error(
      'an `egress_allowlist` profile needs its per-Run internal network; refusing to ' +
        'create the sandbox on `none`, which would look like a filtered network',
    );
  }
  if (profile.network === 'none' && egressNetwork) {
    throw new Error('a `network: none` profile must not be attached to an egress network');
  }

  const args = [
    'run',
    '--detach',
    '--label', `${RUN_ID_LABEL}=${spec.runId}`,
    // R46 — non-root. A fixed high UID rather than the image's default, which is often
    // root and would make every other hardening flag decorative.
    '--user', '10001:10001',
    // R46 — drop everything, add nothing back. No built-in tool needs a capability.
    '--cap-drop', 'ALL',
    // Blocks setuid escalation inside the container even if the image ships one.
    '--security-opt', 'no-new-privileges',
    // Either no network at all, or the per-Run `--internal` bridge whose only other
    // member is the egress proxy. There is no third option and no default that opens one.
    '--network', egressNetwork ? egressNetwork.networkName : 'none',
    '--cpus', String(profile.cpu_limit),
    '--memory', profile.memory_limit,
    // R44a — /armada is a writable tmpfs REGARDLESS of read_only_root. This is what keeps
    // oversize spill (R38) and Code-mode result files (R27c) working under a read-only
    // root. Discarded with the container; never part of the workspace.
    '--tmpfs', `/armada:rw,size=${profile.armada_tmpfs_size},mode=1777`,
    '--workdir', '/workspace',
  ];

  if (egressNetwork) {
    const proxyUrl = `http://${PROXY_ALIAS}:${egressNetwork.proxyPort}`;
    // Lowercase AND uppercase: curl reads `http_proxy`, most everything else reads the
    // uppercase pair, and a client that reads neither simply has no route at all.
    for (const name of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) {
      args.push('--env', `${name}=${proxyUrl}`);
    }
    // DNS CONTROL. On an `--internal` network there is no route to a forwarder anyway;
    // pointing the container's resolver at its own loopback makes external resolution fail
    // deterministically rather than depending on that, which closes DNS as an
    // exfiltration channel. Docker's embedded resolver still answers the proxy's alias,
    // because container names are answered authoritatively and never forwarded.
    args.push('--dns', '127.0.0.1');
  }

  if (profile.read_only_root) args.push('--read-only');

  // R45 — apart from /workspace and the /armada tmpfs, NO host path is mounted. Note what
  // is absent: the Docker socket. The daemon's mount is never propagated (R46).
  if (workspacePath) args.push('--volume', `${workspacePath}:/workspace:rw`);

  args.push(profile.image);
  // Hold the container open; every tool call runs through `docker exec`. Without this the
  // container would exit immediately and the first tool call would fail.
  args.push('sleep', 'infinity');

  return args;
}

export interface DockerResult {
  stdout: string;
  stderr: string;
  code: number;
  /** True when the process was killed by the timeout rather than exiting on its own. */
  killed: boolean;
}

export interface DockerRunner {
  (args: string[], timeoutMs?: number, stdin?: string): Promise<DockerResult>;
}

const dockerCli: DockerRunner = async (args, timeoutMs = 60_000, stdin) => {
  const child = execFile(
    'docker',
    args,
    { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
    () => undefined,
  );
  if (stdin !== undefined) {
    child.stdin?.end(stdin);
  }

  return new Promise<DockerResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => (stdout += chunk));
    child.stderr?.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code, signal) => {
      resolve({
        stdout,
        stderr,
        code: code ?? 1,
        // Reported by the runner rather than sniffed back out of stderr by the caller.
        killed: child.killed || signal !== null,
      });
    });
  });
};

/** Resolves when the per-Run egress proxy has bound its listener. */
export interface ProxyReadyWaiter {
  (containerId: string): Promise<void>;
}

/**
 * A liveness ceiling on the `docker logs` CHILD PROCESS — the same mechanism `dockerCli`
 * already uses for every other Docker call. Nothing waits for it on the success path; it
 * exists so a proxy that never prints and never exits cannot hang Run start forever.
 */
const PROXY_READY_CEILING_MS = 30_000;

/**
 * Wait for the proxy by FOLLOWING ITS LOG, not by sleeping and hoping.
 *
 * `docker run --detach` returns once the container's process has been started, which is
 * before Node has bound a socket. Polling would be a retry loop and a fixed sleep would be
 * an arbitrary delay; both are guesses. The proxy prints one line when `listen` fires, so
 * this waits on the actual event and resolves the instant it arrives.
 */
const dockerLogsReadyWaiter: ProxyReadyWaiter = (containerId) =>
  new Promise<void>((settle, reject) => {
    const child = spawn('docker', ['logs', '--follow', containerId], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PROXY_READY_CEILING_MS,
      killSignal: 'SIGKILL',
    });
    let seen = '';
    let settled = false;

    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      if (err) reject(err);
      else settle();
    };

    const consume = (chunk: Buffer | string): void => {
      seen += String(chunk);
      if (seen.includes(PROXY_READY_LINE)) finish();
    };
    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);
    child.on('error', (err) => finish(err));
    // Reached when the proxy container died, or when the ceiling above killed the follow.
    child.on('close', () =>
      finish(
        new Error(
          `no \`${PROXY_READY_LINE}\` from the proxy container${seen.trim() === '' ? '' : `: ${seen.trim()}`}`,
        ),
      ),
    );
  });

/** The per-Run containers and network that implement one `egress_allowlist` sandbox. */
interface EgressResources {
  networkName: string;
  proxyContainerId: string;
  proxyPort: number;
}

class DockerSandbox implements Sandbox {
  constructor(
    readonly id: string,
    private readonly docker: DockerRunner,
    private readonly timeoutSeconds: number,
  ) {}

  /**
   * R49 — every built-in tool reaches the filesystem THROUGH THIS INTERFACE and has no
   * host filesystem path. `docker exec` is the only channel.
   */
  async exec(command: string, timeoutSeconds = this.timeoutSeconds): Promise<ExecResult> {
    const result = await this.docker(
      ['exec', this.id, '/bin/sh', '-c', command],
      timeoutSeconds * 1000,
    );
    // Edge 5 — a tool call over its timeout is killed, reported, and the loop CONTINUES.
    // `killed` comes from the process, so this does not depend on parsing an error string.
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.code,
      timedOut: result.killed,
    };
  }

  async readFile(path: string): Promise<string> {
    const result = await this.exec(`cat -- ${shellQuote(path)}`);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `cannot read ${path}`);
    return result.stdout;
  }

  async writeFile(path: string, content: string): Promise<void> {
    // Content goes over STDIN, never into the command string. Two reasons: file content is
    // model-generated, so interpolating it would be a shell-injection vector into the
    // sandbox's own shell; and this is the path oversize tool-result spills use, where
    // base64-through-argv would add 33% on top of a full argv copy.
    const result = await this.docker(
      ['exec', '-i', this.id, '/bin/sh', '-c',
        `mkdir -p -- "$(dirname -- ${shellQuote(path)})" && cat > ${shellQuote(path)}`],
      this.timeoutSeconds * 1000,
      content,
    );
    if (result.code !== 0) throw new Error(result.stderr.trim() || `cannot write ${path}`);
  }

  async listDir(path: string): Promise<string[]> {
    const result = await this.exec(`ls -1A -- ${shellQuote(path)}`);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `cannot list ${path}`);
    return result.stdout.split('\n').filter(Boolean);
  }
}

/** Single-quote for /bin/sh. The only safe way to pass a model-supplied path. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export class DockerSandboxProvider implements SandboxProvider {
  readonly name = 'DockerSandboxProvider';

  /**
   * Sandbox container id -> the egress network and proxy provisioned for it.
   *
   * In-process bookkeeping so `release` can tear down all three resources. It is not the
   * guarantee — `sweepOrphans` is, because a crashed daemon loses this map and both the
   * proxy container and the network carry the same `armada.run_id` label the sweep
   * filters on.
   */
  private readonly egressByContainer = new Map<string, EgressResources>();

  constructor(
    private readonly profiles: Record<string, SandboxProfile>,
    private readonly workspaceRoot: string,
    private readonly docker: DockerRunner = dockerCli,
    private readonly awaitProxyReady: ProxyReadyWaiter = dockerLogsReadyWaiter,
  ) {}

  async acquire(spec: SandboxSpec): Promise<Sandbox> {
    const profile = this.profiles[spec.profile];
    if (!profile) {
      throw new Error(
        `no sandbox profile \`${spec.profile}\`; available: ${Object.keys(this.profiles).join(', ')}`,
      );
    }

    let workspacePath: string | null = null;
    if (spec.workspacePath) {
      const verified = await verifyWorkspace(spec.workspacePath, this.workspaceRoot);
      // Edge 7 — fail BEFORE the container is created.
      if (!verified.ok) throw new Error(verified.error);
      workspacePath = verified.resolved;
    }

    // R47 — the egress subsystem comes up BEFORE the sandbox, so the sandbox is never
    // attached to a network whose only exit is not yet listening.
    let egress: EgressResources | null = null;
    if (profile.network === 'egress_allowlist') {
      if (!profile.egress) {
        // Unreachable through validateProfiles, which refuses the mode without a resolved
        // allowlist. Restated here so a directly-constructed profile cannot get a network
        // with no filter on it.
        throw new Error(
          `profile \`${spec.profile}\` declares \`network: egress_allowlist\` with no resolved allowlist`,
        );
      }
      egress = await this.provisionEgress(spec.runId, profile.egress);
    }

    let started: DockerResult;
    try {
      started = await this.docker(
        buildCreateArgs(
          spec,
          profile,
          workspacePath,
          egress ? { networkName: egress.networkName, proxyPort: egress.proxyPort } : undefined,
        ),
      );
    } catch (err) {
      await this.tearDownEgress(egress);
      throw err;
    }
    if (started.code !== 0) {
      // Otherwise a failed sandbox leaves a proxy and a network behind for the next sweep.
      await this.tearDownEgress(egress);
      throw new Error(`docker run failed: ${started.stderr.trim()}`);
    }

    const containerId = started.stdout.trim();
    if (egress) this.egressByContainer.set(containerId, egress);
    return new DockerSandbox(containerId, this.docker, profile.timeout_seconds);
  }

  /** R48 — released on ANY terminal outcome, including cancellation and crash recovery. */
  async release(sandbox: Sandbox): Promise<void> {
    await this.docker(['rm', '-f', sandbox.id]);
    // The sandbox goes first: a network with a container still attached cannot be removed.
    const egress = this.egressByContainer.get(sandbox.id);
    if (egress) {
      this.egressByContainer.delete(sandbox.id);
      await this.tearDownEgress(egress);
    }
  }

  /**
   * Stand up the per-Run egress path — the whole of R47's mechanism, in three calls.
   *
   * Ordering is not incidental. The network is `--internal` from creation, so there is no
   * window in which it routes. The proxy starts on the DEFAULT bridge, where it has egress
   * and working DNS, and is joined to the internal network afterwards — it is the only
   * container with a foot on both sides, and the sandbox is created only once its listener
   * has actually reported ready.
   *
   * Every failure unwinds what it already created. A half-provisioned egress path is the
   * one outcome that could leave a sandbox on a network with no filter on it.
   */
  private async provisionEgress(runId: string, egress: ResolvedEgress): Promise<EgressResources> {
    const networkName = egressNetworkName(runId);

    const network = await this.docker(buildNetworkCreateArgs(runId, RUN_ID_LABEL));
    if (network.code !== 0) {
      throw new Error(`could not create the egress network for run ${runId}: ${network.stderr.trim()}`);
    }

    const proxy = await this.docker(buildProxyCreateArgs(runId, egress, RUN_ID_LABEL));
    if (proxy.code !== 0) {
      await this.docker(['network', 'rm', networkName]);
      throw new Error(
        `could not start the egress proxy from \`${egress.proxyImage}\`: ${proxy.stderr.trim()}. ` +
          'The image must carry the daemon\'s `dist/` — it runs `node /app/dist/sandbox/egress-proxy.js`.',
      );
    }

    const resources: EgressResources = {
      networkName,
      proxyContainerId: proxy.stdout.trim(),
      proxyPort: egress.proxyPort,
    };

    const connected = await this.docker(buildNetworkConnectArgs(runId, resources.proxyContainerId));
    if (connected.code !== 0) {
      await this.tearDownEgress(resources);
      throw new Error(
        `could not attach the egress proxy to ${networkName}: ${connected.stderr.trim()}`,
      );
    }

    try {
      await this.awaitProxyReady(resources.proxyContainerId);
    } catch (err) {
      await this.tearDownEgress(resources);
      throw new Error(
        `the egress proxy for run ${runId} never became ready: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return resources;
  }

  private async tearDownEgress(egress: EgressResources | null): Promise<void> {
    if (!egress) return;
    await this.docker(['rm', '-f', egress.proxyContainerId]);
    await this.docker(['network', 'rm', egress.networkName]);
  }

  /**
   * Orphan sweep — Req 30, edge 13.
   *
   * A daemon that crashed mid-Run left containers running. Shutdown cleanup is
   * best-effort; THIS is the guarantee. Filtering on the label rather than on a name
   * pattern means a container is only ever removed because Armada labelled it.
   *
   * `activeRunIds` is passed in rather than queried here so this stays testable and so the
   * sandbox layer does not reach into the runs table.
   *
   * P14 adds two resource kinds to the same sweep, on the same label: the egress proxy is
   * a labelled container, so it needs no new code here, and the per-Run network is
   * reclaimed after the containers on it, because Docker refuses to remove a network that
   * still has one attached.
   */
  async sweepOrphans(activeRunIds: Set<string> = new Set()): Promise<string[]> {
    const listed = await this.docker([
      // -q would be dead here: --format overrides it.
      'ps', '-a', '--filter', `label=${RUN_ID_LABEL}`,
      '--format', `{{.ID}} {{.Label "${RUN_ID_LABEL}"}}`,
    ]);
    if (listed.code !== 0) return [];

    const orphans: string[] = [];
    for (const line of listed.stdout.split('\n').filter(Boolean)) {
      const [containerId, runId] = line.trim().split(/\s+/);
      if (!containerId || !runId) continue;
      if (activeRunIds.has(runId)) continue;
      orphans.push(containerId);
    }

    // One removal for N containers rather than one spawn each.
    if (orphans.length > 0) await this.docker(['rm', '-f', ...orphans]);
    await this.sweepEgressNetworks(activeRunIds);
    return orphans;
  }

  /**
   * Networks are FILTERED BY THE ARMADA LABEL, exactly as containers are — the name only
   * supplies the run id. A network is never removed because it looked like ours.
   */
  private async sweepEgressNetworks(activeRunIds: Set<string>): Promise<void> {
    const listed = await this.docker([
      'network', 'ls', '--filter', `label=${RUN_ID_LABEL}`, '--format', '{{.Name}}',
    ]);
    if (listed.code !== 0) return;

    const stale: string[] = [];
    for (const name of listed.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const runId = name.startsWith(EGRESS_NETWORK_PREFIX)
        ? name.slice(EGRESS_NETWORK_PREFIX.length)
        : '';
      if (runId === '' || activeRunIds.has(runId)) continue;
      stale.push(name);
    }
    if (stale.length > 0) await this.docker(['network', 'rm', ...stale]);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * R45b — the daemon fails at STARTUP when the socket is absent, naming the mount.
 *
 * Deferring to the first Run would surface as a Run failing for reasons that look like a
 * Docker problem, on a daemon that had already reported healthy.
 */
export async function assertSocketMounted(
  exists: (path: string) => Promise<boolean> = pathExists,
): Promise<void> {
  if (await exists(DOCKER_SOCKET)) return;
  throw new Error(
    `${DOCKER_SOCKET} is not mounted into armada-daemon. Sandboxes are sibling ` +
      'containers created over the host Docker socket (Agent Runtime R45a), so the ' +
      'daemon cannot provision any sandbox without it. Add ' +
      `\`- ${DOCKER_SOCKET}:${DOCKER_SOCKET}\` to armada-daemon's volumes.`,
  );
}
