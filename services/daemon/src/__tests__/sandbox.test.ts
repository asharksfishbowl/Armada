/**
 * P5 — sandbox provisioning and the built-in tools.
 *
 * Agent Runtime R38, R44-R49; build-plan Req 29-30; edges 5, 7, 27.
 *
 * Unit tests: the Docker CLI is stubbed, so these assert the CONTAINER SPEC and the
 * control flow without needing a daemon. The acceptance criteria that inspect a running
 * container (non-root, no socket, network none, read-only root) are integration — but the
 * flags that produce those properties are asserted here, which is what catches a
 * regression that silently drops one.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DockerSandboxProvider,
  assertSocketMounted,
  RUN_ID_LABEL,
  SandboxConfigError,
  buildCreateArgs,
  shellQuote,
  validateProfiles,
  verifyWorkspace,
  type SandboxProfile,
} from '../sandbox/docker-sandbox.js';
import { dispatchBuiltin, spillIfOversize, SANDBOX_LOCAL_TOOLS } from '../tools/registry.js';
import { validateFinish } from '../tools/builtin/finish.js';
import { invokeShell } from '../tools/builtin/shell.js';
import type { RunContext, Sandbox } from '../kernel/types.js';

const PROFILE: SandboxProfile = {
  image: 'debian:bookworm-slim',
  cpu_limit: 1,
  memory_limit: '512m',
  network: 'none',
  allowed_hosts: [],
  read_only_root: true,
  armada_tmpfs_size: '64m',
  timeout_seconds: 120,
};

describe('build-plan Req 29 — network policy is never silently downgraded', () => {
  // P14 implements `egress_allowlist` (see egress.test.ts for the subsystem). Req 29's
  // rule survives it unchanged: the mode is REFUSED whenever the subsystem behind it
  // cannot be provisioned, and it is never quietly turned into `none`. An empty
  // environment here means no proxy image is configured, so nothing can be.
  const NO_ENV: Record<string, string | undefined> = {};

  test('an unprovisionable egress_allowlist profile fails config load naming the mode', () => {
    assert.throws(
      () => validateProfiles({ risky: { ...PROFILE, network: 'egress_allowlist' } }, {}, NO_ENV),
      (err: unknown) => {
        assert.ok(err instanceof SandboxConfigError);
        assert.match(err.message, /egress_allowlist/);
        return true;
      },
    );
  });

  test('it is NOT silently downgraded to none — that would be the security fault', () => {
    // A profile that asked for a restricted network and quietly got none still LOOKS like
    // it enforces an allowlist. Nothing is filtered because nothing is reachable, and the
    // day the allowlist lands behaviour changes with no config edit.
    let downgraded: Record<string, SandboxProfile> | null = null;
    try {
      downgraded = validateProfiles({ risky: { ...PROFILE, network: 'egress_allowlist' } }, {}, NO_ENV);
    } catch {
      /* expected */
    }
    assert.equal(downgraded, null, 'validation must refuse, not return a `none` profile');
  });

  test('the shipped profiles validate and are all network: none', () => {
    const validated = validateProfiles(
      {
        node: { ...PROFILE, read_only_root: false },
        minimal: PROFILE,
      },
      {},
      NO_ENV,
    );
    assert.deepEqual(Object.keys(validated).sort(), ['minimal', 'node']);
    assert.ok(Object.values(validated).every((p) => p.network === 'none'));
    // A `none` profile carries no resolved egress block, so nothing downstream can
    // mistake it for a filtered one.
    assert.ok(Object.values(validated).every((p) => p.egress === undefined));
  });

  test('armada_tmpfs_size defaults rather than being omittable (R44a)', () => {
    const validated = validateProfiles({ p: { image: 'x', network: 'none' } }, {}, NO_ENV);
    // /armada must exist on EVERY sandbox or spill and Code mode break under a read-only
    // root, so this cannot be left unset.
    assert.equal(validated['p']!.armada_tmpfs_size, '64m');
  });
});

describe('R44a / R45 / R46 — the container spec', () => {
  const args = buildCreateArgs(
    { runId: 'run-1', profile: 'minimal', workspacePath: '/workspaces/run-1' },
    PROFILE,
    '/workspaces/run-1',
  );
  const joined = args.join(' ');

  test('runs as a non-root UID', () => {
    assert.match(joined, /--user 10001:10001/);
  });

  test('drops all capabilities and forbids privilege escalation', () => {
    assert.match(joined, /--cap-drop ALL/);
    assert.match(joined, /--security-opt no-new-privileges/);
  });

  test('THE DOCKER SOCKET IS NEVER PROPAGATED INTO A SANDBOX (R46)', () => {
    // A sandbox with the socket could provision an unconstrained container and escape.
    // This is the single most important assertion in the file.
    assert.ok(!joined.includes('docker.sock'), 'no sandbox may ever receive the socket');
  });

  test('network is none', () => {
    assert.match(joined, /--network none/);
  });

  test('/armada is a writable tmpfs even under read_only_root (R44a)', () => {
    assert.ok(PROFILE.read_only_root, 'this profile is read-only, which is the point');
    assert.match(joined, /--tmpfs \/armada:rw,size=64m/);
    assert.match(joined, /--read-only/);
    // Both together: the root is read-only AND /armada is writable, which is what keeps
    // oversize spill and Code-mode artifacts working.
  });

  test('only /workspace is bind-mounted — no other host path (R45)', () => {
    const mounts = args.filter((_, i) => args[i - 1] === '--volume');
    assert.deepEqual(mounts, ['/workspaces/run-1:/workspace:rw']);
  });

  test('the container is labelled with its run_id for the orphan sweep', () => {
    assert.match(joined, new RegExp(`--label ${RUN_ID_LABEL}=run-1`));
  });

  test('a run without a workspace mounts nothing', () => {
    const bare = buildCreateArgs({ runId: 'r', profile: 'minimal' }, PROFILE, null);
    assert.ok(!bare.includes('--volume'));
  });
});

describe('edge 7 — workspace verification WITHOUT a host stat (R45c)', () => {
  const root = mkdtempSync(join(tmpdir(), 'armada-ws-'));

  test('a path beneath the shared root that exists is accepted', async () => {
    const workspace = join(root, 'run-1');
    mkdirSync(workspace);
    const result = await verifyWorkspace(workspace, root);
    assert.equal(result.ok, true);
  });

  test('a path beneath the root that does NOT exist is rejected naming it', async () => {
    const result = await verifyWorkspace(join(root, 'absent'), root);
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /does not exist/);
  });

  test('a path OUTSIDE the shared root is rejected', async () => {
    // Otherwise the daemon would ask Docker to mount an arbitrary host path into a
    // sandbox, which is exactly the containment the shared root provides.
    const result = await verifyWorkspace('/etc', root);
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /ARMADA_WORKSPACE_ROOT/);
  });

  test('a sibling directory sharing the root prefix does not slip through', async () => {
    // `/workspaces-evil` must not pass a check for `/workspaces`.
    const result = await verifyWorkspace(`${root}-evil/x`, root);
    assert.equal(result.ok, false);
  });

  test('a relative path is rejected', async () => {
    const result = await verifyWorkspace('relative/path', root);
    assert.equal(result.ok, false);
  });

  test('a file rather than a directory is rejected', async () => {
    const filePath = join(root, 'a-file');
    writeFileSync(filePath, 'x');
    const result = await verifyWorkspace(filePath, root);
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /not a directory/);
  });
});

describe('R45b — the daemon fails at STARTUP when the socket is missing', () => {
  test('an absent socket throws, naming the mount', async () => {
    await assert.rejects(
      () => assertSocketMounted(async () => false),
      // Deferring to the first Run would surface as a Run failing on a daemon that had
      // already reported healthy.
      (err: Error) => /docker\.sock/.test(err.message) && /volumes/.test(err.message),
    );
  });

  test('a present socket passes', async () => {
    await assertSocketMounted(async () => true);
  });
});

describe('Req 30 / edge 13 — the orphan sweep', () => {
  function providerWith(psOutput: string) {
    const calls: string[][] = [];
    const docker = async (args: string[]) => {
      calls.push(args);
      return args[0] === 'ps'
        ? { stdout: psOutput, stderr: '', code: 0, killed: false }
        : { stdout: '', stderr: '', code: 0, killed: false };
    };
    return { provider: new DockerSandboxProvider({ minimal: PROFILE }, '/workspaces', docker), calls };
  }

  test('containers whose run is not active are removed', async () => {
    const { provider, calls } = providerWith('abc123 run-dead\ndef456 run-live\n');
    const removed = await provider.sweepOrphans(new Set(['run-live']));

    assert.deepEqual(removed, ['abc123']);
    assert.ok(calls.some((c) => c[0] === 'rm' && c.includes('abc123')));
    assert.ok(!calls.some((c) => c[0] === 'rm' && c.includes('def456')), 'a live Run is untouched');
  });

  test('it filters on the armada label, not a name pattern', async () => {
    const { provider, calls } = providerWith('');
    await provider.sweepOrphans(new Set());
    // A container is only ever removed because Armada labelled it.
    assert.ok(calls[0]!.join(' ').includes(`label=${RUN_ID_LABEL}`));
  });
});

describe('R29 / R30 — dispatch never terminates a Run', () => {
  const sandbox = {
    id: 'c1',
    exec: async () => ({ stdout: 'ok', stderr: '', exitCode: 0, timedOut: false }),
    readFile: async () => 'contents',
    writeFile: async () => undefined,
    listDir: async () => ['a', 'b'],
  } as Sandbox;
  const ctx = { runId: 'r', agentVersionId: 'v', mode: 'standard', sandbox } as RunContext;

  test('an unknown tool is an is_error RESULT listing what is granted', async () => {
    const result = await dispatchBuiltin('nonsense', {}, ['shell'], ctx);
    assert.equal(result.isError, true);
    assert.match(result.content, /nonsense/);
  });

  test('a tool this Agent was not granted is unknown even though it is implemented', async () => {
    // The granted list comes from the pinned snapshot; asking nicely does not grant a shell.
    const result = await dispatchBuiltin('shell', { command: 'ls' }, ['read_file'], ctx);
    assert.equal(result.isError, true);
  });

  test('bad arguments are an error result, not a throw', async () => {
    const result = await dispatchBuiltin('read_file', {}, ['read_file'], ctx);
    assert.equal(result.isError, true);
  });

  test('a granted tool dispatches through the Sandbox interface', async () => {
    const result = await dispatchBuiltin('read_file', { path: '/workspace/a' }, ['read_file'], ctx);
    assert.equal(result.content, 'contents');
    assert.notEqual(result.isError, true);
  });
});

describe('invariant 1 — finish is the only route to success', () => {
  test('a missing `success` is rejected rather than coerced', () => {
    const result = validateFinish({ summary: 'done' });
    assert.equal(result.ok, false);
    // If this coerced to false — or worse, true — invariant 1 would be decided by a type
    // coercion, and forge builds trajectory data from `success` Runs alone.
    assert.match((result as { error: string }).error, /explicit `success` boolean/);
  });

  test('a malformed finish is an is_error result and does NOT terminate the Turn', async () => {
    const ctx = { runId: 'r', agentVersionId: 'v', mode: 'standard' } as RunContext;
    const result = await dispatchBuiltin('finish', { summary: 'x' }, ['finish'], ctx);
    assert.equal(result.isError, true);
  });

  test('an EMPTY summary is accepted — edge 20 terminates with an empty result', () => {
    assert.equal(validateFinish({ summary: '', success: true }).ok, true);
  });

  test('success: false is a valid self-report, not an error', () => {
    const result = validateFinish({ summary: 'could not', success: false });
    assert.equal(result.ok, true);
    // Edge 20a — this yields `incomplete`, not `failed`. `failed` is for infrastructure.
    assert.equal((result as { value: { success: boolean } }).value.success, false);
  });

  test('finish needs no sandbox', async () => {
    const ctx = { runId: 'r', agentVersionId: 'v', mode: 'standard' } as RunContext;
    const result = await dispatchBuiltin('finish', { summary: 'ok', success: true }, ['finish'], ctx);
    assert.notEqual(result.isError, true);
  });
});

describe('edge 5 — a timeout is reported and the loop continues', () => {
  test('a timed-out command returns timedOut with is_error', async () => {
    const sandbox = {
      id: 'c',
      exec: async () => ({ stdout: '', stderr: 'signal SIGTERM', exitCode: 1, timedOut: true }),
      readFile: async () => '',
      writeFile: async () => undefined,
      listDir: async () => [],
    } as Sandbox;

    const result = await invokeShell(sandbox, { command: 'sleep 999' });
    assert.equal(result.timedOut, true);
    assert.equal(result.isError, true);
  });

  test('a NON-ZERO exit is NOT an error — grep finding nothing is information', async () => {
    const sandbox = {
      id: 'c',
      exec: async () => ({ stdout: '', stderr: '', exitCode: 1, timedOut: false }),
      readFile: async () => '',
      writeFile: async () => undefined,
      listDir: async () => [],
    } as Sandbox;

    const result = await invokeShell(sandbox, { command: 'grep nope file' });
    // Reporting this as a tool error would teach the model to distrust its own tools.
    assert.notEqual(result.isError, true);
    assert.match(result.content, /exit code 1/);
  });
});

describe('R38 / edge 27 — oversize spill', () => {
  const estimateTokens = (text: string) => Math.max(1, Math.floor(text.length / 4));

  test('a result within the limit is untouched', async () => {
    const result = await spillIfOversize({ content: 'short' }, undefined, {
      maxToolResultTokens: 100,
      estimateTokens,
      eventId: 'e1',
    });
    assert.equal(result.truncated, undefined);
  });

  test('an oversize result is truncated and NAMES its spill path', async () => {
    const written: { path: string; content: string }[] = [];
    const sandbox = {
      id: 'c',
      exec: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
      readFile: async () => '',
      writeFile: async (path: string, content: string) => {
        written.push({ path, content });
      },
      listDir: async () => [],
    } as Sandbox;

    const huge = 'x'.repeat(10_000);
    const result = await spillIfOversize({ content: huge }, sandbox, {
      maxToolResultTokens: 100,
      estimateTokens,
      eventId: 'event-42',
    });

    assert.equal(result.truncated, true);
    assert.equal(written[0]!.path, '/armada/tool-results/event-42.txt');
    assert.equal(written[0]!.content, huge, 'the FULL output is spilled');
    // Telling the model its output was cut without saying where would leave it no recovery.
    assert.match(result.content, /\/armada\/tool-results\/event-42\.txt/);
  });

  test('A FULL TMPFS SETS spill_failed AND THE RUN CONTINUES (edge 27)', async () => {
    const sandbox = {
      id: 'c',
      exec: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
      readFile: async () => '',
      writeFile: async () => {
        throw new Error('No space left on device');
      },
      listDir: async () => [],
    } as Sandbox;

    const result = await spillIfOversize({ content: 'x'.repeat(10_000) }, sandbox, {
      maxToolResultTokens: 100,
      estimateTokens,
      eventId: 'e',
    });

    // A full /armada must NEVER terminate a Run — the agent loses the overflow, which is a
    // degradation rather than a fault.
    assert.equal(result.spillFailed, true);
    assert.equal(result.truncated, true);
  });
});

describe('shell quoting', () => {
  // Asserted against a REAL /bin/sh rather than against an expected string. The exact
  // escaping form is an implementation detail; what matters is that a hostile path
  // round-trips as data instead of becoming a command. Paths reach the sandbox shell from
  // model output, so this is an injection vector into the sandbox's own shell.
  const hostile = [
    "it's",
    "a'; touch /tmp/armada-pwned; echo '",
    '$(whoami)',
    '`id`',
    'plain/path.txt',
    'with spaces and "double" quotes',
  ];

  for (const value of hostile) {
    test(`survives /bin/sh unchanged: ${JSON.stringify(value)}`, async () => {
      const { stdout } = await promisify(execFile)('/bin/sh', [
        '-c',
        `printf %s ${shellQuote(value)}`,
      ]);
      assert.equal(stdout, value, 'the shell must see this as data, not as a command');
    });
  }
});

describe('R27 — the sandbox-local tool set', () => {
  test('is exactly the five Code mode may declare', () => {
    assert.deepEqual([...SANDBOX_LOCAL_TOOLS].sort(), [
      'finish', 'list_dir', 'read_file', 'shell', 'write_file',
    ]);
    // search_knowledge and MCP tools are absent by construction: a Code-mode program has
    // no callback channel into the daemon (R27a, invariant 3).
  });
});

describe('spill trimming honours the INJECTED estimator', () => {
  test('a non-4:1 estimator still produces a result within the limit', async () => {
    // The old code hardcoded maxTokens * 4, which silently assumed the estimator's ratio.
    // One token per character makes that assumption fail loudly if it ever returns.
    const oneTokenPerChar = (text: string) => text.length;

    const result = await spillIfOversize({ content: 'y'.repeat(5_000) }, undefined, {
      maxToolResultTokens: 100,
      estimateTokens: oneTokenPerChar,
      eventId: 'e',
    });

    assert.equal(result.truncated, true);
    assert.ok(
      oneTokenPerChar(result.content) <= 100,
      `trimmed content must fit the limit, got ${oneTokenPerChar(result.content)}`,
    );
  });
});
