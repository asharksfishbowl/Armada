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
 */

import { execFile } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
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
}

export class SandboxConfigError extends Error {}

/**
 * Validate profiles at CONFIG LOAD — build-plan Req 29.
 *
 * `network: egress_allowlist` is REJECTED, naming the unimplemented mode. It is NOT
 * silently downgraded to `none`.
 *
 * The downgrade would be the security fault: a profile that asked for a restricted network
 * and quietly received no network at all still *looks* like it is enforcing an allowlist.
 * An operator reading the config would believe egress is filtered to `allowed_hosts` when
 * in fact nothing is filtered because nothing is reachable — and the day the allowlist
 * lands in P14, behaviour would change under them with no config edit. Failing loudly is
 * the only honest option.
 */
export function validateProfiles(
  profiles: Record<string, Partial<SandboxProfile>>,
): Record<string, SandboxProfile> {
  const problems: string[] = [];
  const validated: Record<string, SandboxProfile> = {};

  for (const [name, profile] of Object.entries(profiles)) {
    if (profile.network === 'egress_allowlist') {
      problems.push(
        `config/sandbox-profiles.yaml: profile \`${name}\` declares ` +
          '`network: egress_allowlist`, which is not implemented. Docker has no ' +
          'per-container host allowlist; it needs an internal bridge plus a constrained ' +
          'forward proxy, which lands in a later phase. Use `network: none`. ' +
          'This is refused rather than downgraded so a profile can never appear to ' +
          'filter egress while filtering nothing.',
      );
      continue;
    }
    if (profile.network !== 'none') {
      problems.push(
        `config/sandbox-profiles.yaml: profile \`${name}\` has network \`${String(profile.network)}\`; ` +
          'the only supported value is `none`',
      );
      continue;
    }
    if (!profile.image) {
      problems.push(`config/sandbox-profiles.yaml: profile \`${name}\` is missing \`image\``);
      continue;
    }

    validated[name] = {
      image: profile.image,
      cpu_limit: profile.cpu_limit ?? 1,
      memory_limit: profile.memory_limit ?? '512m',
      network: 'none',
      allowed_hosts: profile.allowed_hosts ?? [],
      read_only_root: profile.read_only_root ?? false,
      // R44a — a default rather than an option to omit: /armada must exist on every
      // sandbox or spill and Code mode break under read_only_root.
      armada_tmpfs_size: profile.armada_tmpfs_size ?? '64m',
      timeout_seconds: profile.timeout_seconds ?? 300,
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
): string[] {
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
    // build-plan Req 29 — `none` only. Validated at config load; restated here so the
    // container is correct even if it were ever constructed directly.
    '--network', 'none',
    '--cpus', String(profile.cpu_limit),
    '--memory', profile.memory_limit,
    // R44a — /armada is a writable tmpfs REGARDLESS of read_only_root. This is what keeps
    // oversize spill (R38) and Code-mode result files (R27c) working under a read-only
    // root. Discarded with the container; never part of the workspace.
    '--tmpfs', `/armada:rw,size=${profile.armada_tmpfs_size},mode=1777`,
    '--workdir', '/workspace',
  ];

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

  constructor(
    private readonly profiles: Record<string, SandboxProfile>,
    private readonly workspaceRoot: string,
    private readonly docker: DockerRunner = dockerCli,
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

    const started = await this.docker(buildCreateArgs(spec, profile, workspacePath));
    if (started.code !== 0) {
      throw new Error(`docker run failed: ${started.stderr.trim()}`);
    }

    return new DockerSandbox(started.stdout.trim(), this.docker, profile.timeout_seconds);
  }

  /** R48 — released on ANY terminal outcome, including cancellation and crash recovery. */
  async release(sandbox: Sandbox): Promise<void> {
    await this.docker(['rm', '-f', sandbox.id]);
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
    return orphans;
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
