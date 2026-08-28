/**
 * P14 — the egress allowlist. Agent Runtime R44/R47; build-plan Req 29, defect D7.
 *
 * THREE LAYERS ARE TESTED HERE AND THE MIDDLE ONE IS THE POINT.
 *   1. The allowlist grammar and the address gate — pure functions.
 *   2. THE WIRING: that `validateProfiles` resolves the mode, that the provider actually
 *      creates the network and the proxy, that the sandbox is attached to that network,
 *      and that `src/index.ts` passes the `egress:` block in. This repo has shipped six
 *      components that were written, unit-tested, and never called; unit tests pass
 *      happily on unreachable code, which is how all six got through.
 *   3. The proxy's real behaviour, driven over real sockets against real local servers.
 *      No Docker, no network egress — the resolver is injected, so an allowed host is
 *      whatever the test says it is.
 *
 * The acceptance criteria that inspect a running container (a sandbox reaching an allowed
 * host and failing to reach any other, including by direct IP) are integration and are
 * NOT here: they need a Docker host. What is here is every flag and every decision that
 * produces those properties.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createTcpServer, connect as tcpConnect, type Server as TcpServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import {
  DEFAULT_PROXY_PORT,
  PROXY_ALIAS,
  PROXY_IMAGE_ENV,
  egressNetworkName,
  isBlockedAddress,
  matchesAllowlist,
  parseAllowedHost,
  proxyContainerName,
  type HostRule,
} from '../sandbox/egress.js';
import { createEgressProxy, rulesFromEnv, splitAuthority } from '../sandbox/egress-proxy.js';
import {
  DockerSandboxProvider,
  SandboxConfigError,
  buildCreateArgs,
  validateProfiles,
  type DockerResult,
  type SandboxProfile,
} from '../sandbox/docker-sandbox.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** dist/__tests__ -> dist -> daemon -> services -> repo root */
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const DAEMON_SRC = join(HERE, '..', '..', 'src');

const EGRESS_BLOCK = { proxy_image: 'armada-armada-daemon' };
const NO_ENV: Record<string, string | undefined> = {};

function allowlistProfile(hosts: string[]): Partial<SandboxProfile> {
  return {
    image: 'node:22-bookworm-slim',
    cpu_limit: 1,
    memory_limit: '512m',
    network: 'egress_allowlist',
    allowed_hosts: hosts,
    read_only_root: false,
    armada_tmpfs_size: '64m',
    timeout_seconds: 120,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('the allowed_hosts grammar — every rejection prevents a decorative entry', () => {
  test('a bare host covers 80 and 443 and nothing else', () => {
    const parsed = parseAllowedHost('registry.npmjs.org');
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.ok && parsed.rule, {
      host: 'registry.npmjs.org',
      wildcard: false,
      ports: [80, 443],
    });
  });

  test('an explicit port narrows to exactly that port', () => {
    const parsed = parseAllowedHost('api.example.com:8443');
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.rule.ports, [8443]);
  });

  test('a leading *. is a subdomain wildcard', () => {
    const parsed = parseAllowedHost('*.npmjs.org');
    assert.ok(parsed.ok);
    assert.equal(parsed.rule.wildcard, true);
    assert.equal(parsed.rule.host, 'npmjs.org');
  });

  test('hosts are normalised, so a trailing dot and mixed case are one entry', () => {
    const parsed = parseAllowedHost('  Example.COM.  ');
    assert.ok(parsed.ok);
    assert.equal(parsed.rule.host, 'example.com');
  });

  for (const [entry, why] of [
    ['https://example.com', 'a URL never matches — the scheme is not part of a host'],
    ['example.com/path', 'a path is not matched either'],
    ['*', 'allowing everything is not an allowlist'],
    ['api.*.com', 'only a LEADING wildcard is supported'],
    ['example.com:notaport', 'a port must be a number'],
    ['example.com:0', 'port 0 is not a port'],
    ['example.com:70000', 'a port above 65535 is not a port'],
    ['armada-forge', 'a single-label name can only be a container on this host'],
    ['10.0.0.5', 'a private address is a path back in, not egress'],
    ['127.0.0.1', 'loopback is the daemon itself'],
    ['169.254.169.254', 'the cloud metadata address'],
    ['[2001:db8::1]:443', 'IPv6 literals are unsupported and say so'],
    ['', 'an empty entry means nothing'],
  ] as const) {
    test(`rejects \`${entry}\` — ${why}`, () => {
      const parsed = parseAllowedHost(entry);
      assert.equal(parsed.ok, false);
      assert.ok(!parsed.ok && parsed.error.length > 0, 'a rejection must say why');
    });
  }
});

describe('matching — the narrow form never silently widens', () => {
  const rules: HostRule[] = ['*.npmjs.org', 'example.com', 'other.test:8080'].map((entry) => {
    const parsed = parseAllowedHost(entry);
    assert.ok(parsed.ok);
    return parsed.rule;
  });

  test('an exact host on a default port matches', () => {
    assert.equal(matchesAllowlist('example.com', 443, rules), true);
    assert.equal(matchesAllowlist('example.com', 80, rules), true);
  });

  test('the same host on an unlisted port does NOT match', () => {
    assert.equal(matchesAllowlist('example.com', 8080, rules), false);
  });

  test('a wildcard covers subdomains', () => {
    assert.equal(matchesAllowlist('registry.npmjs.org', 443, rules), true);
    assert.equal(matchesAllowlist('deep.registry.npmjs.org', 443, rules), true);
  });

  test('a wildcard does NOT cover the apex — the narrow form stays narrow', () => {
    assert.equal(matchesAllowlist('npmjs.org', 443, rules), false);
  });

  test('a lookalike suffix does not slip through', () => {
    // `evilnpmjs.org` must not satisfy `*.npmjs.org`.
    assert.equal(matchesAllowlist('evilnpmjs.org', 443, rules), false);
  });

  test('case and a trailing dot are normalised at match time too', () => {
    assert.equal(matchesAllowlist('EXAMPLE.com.', 443, rules), true);
  });

  test('an explicit-port rule matches only that port', () => {
    assert.equal(matchesAllowlist('other.test', 8080, rules), true);
    assert.equal(matchesAllowlist('other.test', 443, rules), false);
  });

  test('an empty allowlist matches nothing', () => {
    assert.equal(matchesAllowlist('example.com', 443, []), false);
  });
});

describe('invariant 3 — the address gate is what keeps the boundary one-directional', () => {
  for (const blocked of [
    '127.0.0.1', '10.1.2.3', '172.17.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::',
    'fe80::1', 'fd00::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:192.168.0.1',
    'not-an-address',
  ]) {
    test(`refuses ${blocked}`, () => {
      assert.equal(isBlockedAddress(blocked), true);
    });
  }

  for (const allowed of ['93.184.216.34', '8.8.8.8', '104.16.0.1', '2606:4700::1111']) {
    test(`allows the public address ${allowed}`, () => {
      assert.equal(isBlockedAddress(allowed), false);
    });
  }

  test('172.15 and 172.32 are public — the /12 boundary is not a /8', () => {
    assert.equal(isBlockedAddress('172.15.0.1'), false);
    assert.equal(isBlockedAddress('172.32.0.1'), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('build-plan Req 29 — P14 makes the mode real, and still never downgrades it', () => {
  test('a valid allowlist profile RESOLVES, carrying its rules and proxy image', () => {
    const validated = validateProfiles(
      { web: allowlistProfile(['registry.npmjs.org', '*.npmjs.org']) },
      EGRESS_BLOCK,
      NO_ENV,
    );
    const profile = validated['web'];
    assert.ok(profile);
    assert.equal(profile.network, 'egress_allowlist');
    // The resolved block is what proves the mode is implemented rather than tolerated.
    assert.equal(profile.egress?.proxyImage, 'armada-armada-daemon');
    assert.equal(profile.egress?.proxyPort, DEFAULT_PROXY_PORT);
    assert.equal(profile.egress?.rules.length, 2);
  });

  test('ARMADA_EGRESS_PROXY_IMAGE overrides the config file', () => {
    const validated = validateProfiles(
      { web: allowlistProfile(['example.com']) },
      EGRESS_BLOCK,
      { [PROXY_IMAGE_ENV]: 'my/daemon:dev' },
    );
    assert.equal(validated['web']?.egress?.proxyImage, 'my/daemon:dev');
  });

  test('WITHOUT a proxy image the profile is REFUSED, not downgraded to none', () => {
    // This is Req 29 in its P14 form. The mode exists; this deployment cannot provision
    // it; a profile that quietly became `network: none` would still LOOK like it filters.
    let downgraded: Record<string, SandboxProfile> | null = null;
    try {
      downgraded = validateProfiles({ web: allowlistProfile(['example.com']) }, {}, NO_ENV);
    } catch (err) {
      assert.ok(err instanceof SandboxConfigError);
      assert.match(err.message, /egress_allowlist/);
      assert.match(err.message, /proxy_image/);
    }
    assert.equal(downgraded, null, 'validation must refuse, not return a `none` profile');
  });

  test('an EMPTY allowed_hosts is refused — it filters nothing while looking like it does', () => {
    assert.throws(
      () => validateProfiles({ web: allowlistProfile([]) }, EGRESS_BLOCK, NO_ENV),
      (err: unknown) => err instanceof SandboxConfigError && /allowed_hosts/.test(err.message),
    );
  });

  test('EVERY fault is named at once, not one restart per typo', () => {
    try {
      validateProfiles(
        {
          a: allowlistProfile(['https://one.example.com', 'two.example.com/x']),
          b: allowlistProfile(['*']),
        },
        EGRESS_BLOCK,
        NO_ENV,
      );
      assert.fail('expected a SandboxConfigError');
    } catch (err) {
      assert.ok(err instanceof SandboxConfigError);
      assert.match(err.message, /one\.example\.com/);
      assert.match(err.message, /two\.example\.com/);
      assert.match(err.message, /profile `b`/);
    }
  });

  test('allowed_hosts under `network: none` is refused rather than left decorative', () => {
    assert.throws(
      () =>
        validateProfiles(
          { p: { image: 'x', network: 'none', allowed_hosts: ['example.com'] } },
          EGRESS_BLOCK,
          NO_ENV,
        ),
      (err: unknown) => err instanceof SandboxConfigError && /never consulted/.test(err.message),
    );
  });

  test('an unknown network value still names both supported modes', () => {
    assert.throws(
      () =>
        validateProfiles(
          { p: { image: 'x', network: 'host' as unknown as 'none' } },
          EGRESS_BLOCK,
          NO_ENV,
        ),
      (err: unknown) => err instanceof SandboxConfigError && /egress_allowlist/.test(err.message),
    );
  });

  test('a `none` profile carries NO resolved egress block', () => {
    const validated = validateProfiles({ p: { image: 'x', network: 'none' } }, EGRESS_BLOCK, NO_ENV);
    assert.equal(validated['p']?.egress, undefined);
  });

  test('THE SHIPPED config/sandbox-profiles.yaml still validates and is all network: none', () => {
    // The default path must cost nothing and open nothing. Reading the real file is what
    // catches a profile switched to egress in a config edit that no test would otherwise see.
    const file = parseYaml(
      readFileSync(join(REPO_ROOT, 'config', 'sandbox-profiles.yaml'), 'utf8'),
    ) as { profiles: Record<string, Partial<SandboxProfile>>; egress?: unknown };

    const validated = validateProfiles(file.profiles, file.egress, NO_ENV);
    assert.ok(Object.keys(validated).length >= 2);
    for (const [name, profile] of Object.entries(validated)) {
      assert.equal(profile.network, 'none', `shipped profile \`${name}\` must be network: none`);
      assert.equal(profile.egress, undefined);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the container spec in egress mode', () => {
  const profile = validateProfiles(
    { web: allowlistProfile(['registry.npmjs.org']) },
    EGRESS_BLOCK,
    NO_ENV,
  )['web'] as SandboxProfile;

  const args = buildCreateArgs(
    { runId: 'run-7', profile: 'web', workspacePath: '/workspaces/run-7' },
    profile,
    '/workspaces/run-7',
    { networkName: egressNetworkName('run-7'), proxyPort: DEFAULT_PROXY_PORT },
  );
  const joined = args.join(' ');

  test('the sandbox joins the per-Run internal network, not the default bridge', () => {
    assert.match(joined, /--network armada-egress-run-7/);
    assert.ok(!joined.includes('--network none'));
    assert.ok(!joined.includes('--network bridge'));
  });

  test('the proxy is addressed by alias, in both header cases', () => {
    for (const name of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) {
      assert.ok(
        args.includes(`${name}=http://${PROXY_ALIAS}:${DEFAULT_PROXY_PORT}`),
        `${name} must point at the proxy`,
      );
    }
  });

  test('external DNS is dead inside the sandbox', () => {
    // Closes name resolution as an exfiltration channel; the proxy resolves instead.
    assert.match(joined, /--dns 127\.0\.0\.1/);
  });

  test('every P5 hardening flag survives the new mode', () => {
    assert.match(joined, /--user 10001:10001/);
    assert.match(joined, /--cap-drop ALL/);
    assert.match(joined, /--security-opt no-new-privileges/);
    assert.match(joined, /--tmpfs \/armada:rw/);
    assert.ok(!joined.includes('docker.sock'), 'no sandbox may ever receive the socket');
  });

  test('an allowlist profile REFUSES to be built without its network', () => {
    // The silent downgrade Req 29 forbids, in its runtime form.
    assert.throws(
      () => buildCreateArgs({ runId: 'r', profile: 'web' }, profile, null),
      /internal network/,
    );
  });

  test('a `none` profile refuses to be attached to an egress network', () => {
    const none = validateProfiles({ p: { image: 'x', network: 'none' } }, EGRESS_BLOCK, NO_ENV)['p'];
    assert.ok(none);
    assert.throws(
      () =>
        buildCreateArgs({ runId: 'r', profile: 'p' }, none, null, {
          networkName: 'armada-egress-r',
          proxyPort: 3128,
        }),
      /must not be attached/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('THE WIRING — DockerSandboxProvider actually provisions the subsystem', () => {
  interface Harness {
    provider: DockerSandboxProvider;
    calls: string[][];
    ready: string[];
  }

  function harness(overrides: { sandboxRunCode?: number; readyFails?: boolean } = {}): Harness {
    const calls: string[][] = [];
    const ready: string[] = [];
    const profiles = validateProfiles(
      {
        web: allowlistProfile(['registry.npmjs.org', 'example.com:8443']),
        offline: { image: 'debian:bookworm-slim', network: 'none' },
      },
      EGRESS_BLOCK,
      NO_ENV,
    );

    const docker = async (args: string[]): Promise<DockerResult> => {
      calls.push(args);
      const ok = { stderr: '', code: 0, killed: false };
      if (args[0] === 'network' && args[1] === 'create') return { ...ok, stdout: 'net-id' };
      if (args[0] === 'run' && args.includes('--name')) return { ...ok, stdout: 'proxy-cid' };
      if (args[0] === 'run') {
        return overrides.sandboxRunCode
          ? { stdout: '', stderr: 'no such image', code: overrides.sandboxRunCode, killed: false }
          : { ...ok, stdout: 'sandbox-cid' };
      }
      return { ...ok, stdout: '' };
    };

    const waiter = async (containerId: string): Promise<void> => {
      ready.push(containerId);
      calls.push(['<await-ready>', containerId]);
      if (overrides.readyFails) throw new Error('the proxy container exited before it was ready');
    };

    return {
      provider: new DockerSandboxProvider(profiles, '/workspaces', docker, waiter),
      calls,
      ready,
    };
  }

  test('acquire creates the network, then the proxy, then attaches it, then the sandbox', async () => {
    const { provider, calls } = harness();
    const sandbox = await provider.acquire({ runId: 'run-1', profile: 'web' });

    assert.equal(sandbox.id, 'sandbox-cid');
    const sequence = calls.map((c) => `${c[0]} ${c[1] ?? ''}`.trim());
    assert.deepEqual(sequence, [
      'network create',
      'run --detach',
      'network connect',
      '<await-ready> proxy-cid',
      'run --detach',
    ]);
  });

  test('the network is `--internal`, which is the whole mechanism', async () => {
    const { provider, calls } = harness();
    await provider.acquire({ runId: 'run-1', profile: 'web' });
    const create = calls.find((c) => c[0] === 'network' && c[1] === 'create');
    assert.ok(create);
    // Without --internal, Docker installs a masquerade rule and the sandbox has a route
    // to everything, allowlist or not.
    assert.ok(create.includes('--internal'));
    assert.ok(create.includes(egressNetworkName('run-1')));
    assert.ok(create.join(' ').includes('armada.run_id=run-1'), 'the sweep needs the label');
  });

  test('the proxy carries the allowlist, no socket, and NO other environment', async () => {
    const { provider, calls } = harness();
    await provider.acquire({ runId: 'run-1', profile: 'web' });
    const proxy = calls.find((c) => c[0] === 'run' && c.includes('--name'));
    assert.ok(proxy);
    const joined = proxy.join(' ');

    assert.ok(joined.includes(proxyContainerName('run-1')));
    assert.ok(!joined.includes('docker.sock'), 'the proxy is not privileged either');
    assert.match(joined, /--user 10001:10001/);
    assert.match(joined, /--cap-drop ALL/);
    assert.match(joined, /--read-only/);

    // Exactly two: the allowlist and the port. Not DATABASE_URL, not a credential.
    const envFlags = proxy.filter((a) => a === '--env');
    assert.equal(envFlags.length, 2, 'the proxy inherits nothing of the daemon');
    assert.ok(
      proxy.some((a) => a.startsWith('ARMADA_EGRESS_ALLOWED_HOSTS=') && a.includes('npmjs.org')),
    );
    assert.ok(proxy.includes('armada-armada-daemon'), 'runs from the configured image');
    assert.ok(joined.includes('/app/dist/sandbox/egress-proxy.js'));
  });

  test('the proxy is joined to the internal network under its alias', async () => {
    const { provider, calls } = harness();
    await provider.acquire({ runId: 'run-1', profile: 'web' });
    const connect = calls.find((c) => c[0] === 'network' && c[1] === 'connect');
    assert.deepEqual(connect, [
      'network', 'connect', '--alias', PROXY_ALIAS, egressNetworkName('run-1'), 'proxy-cid',
    ]);
  });

  test('the sandbox is created on that network AFTER the proxy reports ready', async () => {
    const { provider, calls, ready } = harness();
    await provider.acquire({ runId: 'run-1', profile: 'web' });

    assert.deepEqual(ready, ['proxy-cid']);
    const readyIndex = calls.findIndex((c) => c[0] === '<await-ready>');
    const sandboxIndex = calls.findIndex(
      (c) => c[0] === 'run' && c.includes(egressNetworkName('run-1')),
    );
    assert.ok(readyIndex >= 0 && sandboxIndex > readyIndex, 'no sandbox before a live proxy');
  });

  test('A `network: none` RUN PROVISIONS NOTHING — the default path is untouched', async () => {
    const { provider, calls } = harness();
    await provider.acquire({ runId: 'run-2', profile: 'offline' });

    assert.equal(calls.length, 1, 'one docker call: the sandbox itself');
    assert.ok(calls[0]!.includes('none'));
    assert.ok(!calls.some((c) => c[0] === 'network'), 'no network is created');
    assert.ok(!calls.some((c) => c[0] === '<await-ready>'), 'nothing waits on anything');
  });

  test('release removes the sandbox, then the proxy, then the network', async () => {
    const { provider, calls } = harness();
    const sandbox = await provider.acquire({ runId: 'run-1', profile: 'web' });
    calls.length = 0;

    await provider.release(sandbox);
    assert.deepEqual(calls, [
      ['rm', '-f', 'sandbox-cid'],
      ['rm', '-f', 'proxy-cid'],
      // A network with a container still attached cannot be removed, so order matters.
      ['network', 'rm', egressNetworkName('run-1')],
    ]);
  });

  test('a failed sandbox creation unwinds the proxy and the network', async () => {
    const { provider, calls } = harness({ sandboxRunCode: 1 });
    await assert.rejects(() => provider.acquire({ runId: 'run-1', profile: 'web' }), /docker run failed/);
    // A half-provisioned egress path is the one outcome that could leave a sandbox on an
    // unfiltered network, so nothing survives a failure.
    assert.ok(calls.some((c) => c[0] === 'rm' && c.includes('proxy-cid')));
    assert.ok(calls.some((c) => c[0] === 'network' && c[1] === 'rm'));
  });

  test('a proxy that never becomes ready fails Run start rather than running unfiltered', async () => {
    const { provider, calls } = harness({ readyFails: true });
    await assert.rejects(
      () => provider.acquire({ runId: 'run-1', profile: 'web' }),
      /never became ready/,
    );
    assert.ok(!calls.some((c) => c[0] === 'run' && !c.includes('--name')), 'no sandbox was created');
    assert.ok(calls.some((c) => c[0] === 'network' && c[1] === 'rm'));
  });

  test('the orphan sweep reclaims stale egress networks and spares live ones', async () => {
    const calls: string[][] = [];
    const docker = async (args: string[]): Promise<DockerResult> => {
      calls.push(args);
      if (args[0] === 'ps') return { stdout: '', stderr: '', code: 0, killed: false };
      if (args[0] === 'network' && args[1] === 'ls') {
        return {
          stdout: `${egressNetworkName('run-dead')}\n${egressNetworkName('run-live')}\nbridge\n`,
          stderr: '',
          code: 0,
          killed: false,
        };
      }
      return { stdout: '', stderr: '', code: 0, killed: false };
    };
    const provider = new DockerSandboxProvider({}, '/workspaces', docker, async () => undefined);

    await provider.sweepOrphans(new Set(['run-live']));
    const ls = calls.find((c) => c[0] === 'network' && c[1] === 'ls');
    assert.ok(ls?.join(' ').includes('label=armada.run_id'), 'filtered by OUR label, not by name');

    const removed = calls.find((c) => c[0] === 'network' && c[1] === 'rm');
    assert.deepEqual(removed, ['network', 'rm', egressNetworkName('run-dead')]);
  });
});

describe('THE WIRING — src/index.ts passes the egress config in at startup', () => {
  const source = readFileSync(join(DAEMON_SRC, 'index.ts'), 'utf8');

  test('validateProfiles is called with the `egress:` block', () => {
    // Without this argument the subsystem is configured nowhere and every allowlist
    // profile fails at boot for want of a proxy image — validated code, unreachable.
    assert.match(source, /validateProfiles\([\s\S]{0,400}?sandboxConfig\['egress'\]/);
  });

  test('the profiles it validates are the ones DockerSandboxProvider is built with', () => {
    assert.match(source, /new DockerSandboxProvider\(sandboxProfiles,/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('R47 — the proxy itself, over real sockets', () => {
  /**
   * Raw client so nothing between the test and the proxy can normalise a refusal away.
   *
   * `afterHeaders` is written once the proxy's response headers arrive — that is how a
   * CONNECT tunnel is exercised. `until` settles as soon as the transcript satisfies it,
   * which an established tunnel needs because neither side hangs up on its own.
   */
  function speak(
    port: number,
    request: string,
    options: { afterHeaders?: string; until?: (received: string) => boolean } = {},
  ): Promise<string> {
    return new Promise((settle, reject) => {
      const socket = tcpConnect({ host: '127.0.0.1', port }, () => socket.write(request));
      let received = '';
      let sentBody = false;
      socket.on('data', (chunk) => {
        received += chunk.toString();
        if (options.afterHeaders !== undefined && !sentBody && received.includes('\r\n\r\n')) {
          sentBody = true;
          socket.write(options.afterHeaders);
        }
        if (options.until?.(received) === true) {
          socket.destroy();
          settle(received);
        }
      });
      socket.on('error', reject);
      socket.on('close', () => settle(received));
      socket.setTimeout(5_000, () => socket.destroy(new Error('the proxy never answered')));
    });
  }

  function rules(...entries: string[]): HostRule[] {
    return entries.map((entry) => {
      const parsed = parseAllowedHost(entry);
      assert.ok(parsed.ok, `test allowlist entry \`${entry}\` must parse`);
      return parsed.rule;
    });
  }

  function listen(server: HttpServer | TcpServer): Promise<number> {
    return new Promise((settle) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        settle(typeof address === 'object' && address ? address.port : 0);
      });
    });
  }

  test('a plain HTTP request to an allowed host is forwarded', async (t) => {
    const upstream = createHttpServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`upstream saw ${req.headers.host}${req.url}`);
    });
    const upstreamPort = await listen(upstream);
    t.after(() => upstream.close());

    const proxy = createEgressProxy({
      rules: rules(`allowed.test:${upstreamPort}`),
      resolve: async () => ['127.0.0.1'],
      allowPrivateTargets: true, // TEST SEAM — see the default-refusal test below.
      log: () => undefined,
    });
    const proxyPort = await listen(proxy);
    t.after(() => proxy.close());

    const response = await speak(
      proxyPort,
      `GET http://allowed.test:${upstreamPort}/hello HTTP/1.1\r\nHost: allowed.test:${upstreamPort}\r\nConnection: close\r\n\r\n`,
    );
    assert.match(response, /^HTTP\/1\.1 200/);
    // The Host header the upstream sees is the requested NAME, not the pinned address.
    assert.match(response, new RegExp(`upstream saw allowed.test:${upstreamPort}/hello`));
  });

  test('a plain HTTP request to an unlisted host is refused, and nothing is dialled', async (t) => {
    let dialled = 0;
    const upstream = createHttpServer((_req, res) => {
      dialled += 1;
      res.end('reached');
    });
    const upstreamPort = await listen(upstream);
    t.after(() => upstream.close());

    const proxy = createEgressProxy({
      rules: rules(`allowed.test:${upstreamPort}`),
      resolve: async () => ['127.0.0.1'],
      allowPrivateTargets: true,
      log: () => undefined,
    });
    const proxyPort = await listen(proxy);
    t.after(() => proxy.close());

    const response = await speak(
      proxyPort,
      `GET http://blocked.test:${upstreamPort}/ HTTP/1.1\r\nHost: blocked.test\r\nConnection: close\r\n\r\n`,
    );
    assert.match(response, /^HTTP\/1\.1 403/);
    assert.match(response, /not in allowed_hosts/);
    assert.equal(dialled, 0, 'a refusal opens no connection at all');
  });

  test('CONNECT to an allowed host tunnels bytes end to end', async (t) => {
    const upstream = createTcpServer((socket) => socket.on('data', (d) => socket.write(`echo:${d}`)));
    const upstreamPort = await listen(upstream);
    t.after(() => upstream.close());

    const proxy = createEgressProxy({
      rules: rules(`allowed.test:${upstreamPort}`),
      resolve: async () => ['127.0.0.1'],
      allowPrivateTargets: true,
      log: () => undefined,
    });
    const proxyPort = await listen(proxy);
    t.after(() => proxy.close());

    const response = await speak(
      proxyPort,
      `CONNECT allowed.test:${upstreamPort} HTTP/1.1\r\nHost: allowed.test:${upstreamPort}\r\n\r\n`,
      { afterHeaders: 'ping', until: (received) => received.includes('echo:ping') },
    );
    assert.match(response, /^HTTP\/1\.1 200 Connection Established/);
    assert.match(response, /echo:ping/);
  });

  test('CONNECT to an unlisted host is 403 before any socket is opened', async (t) => {
    let dialled = 0;
    const upstream = createTcpServer((socket) => {
      dialled += 1;
      socket.end();
    });
    const upstreamPort = await listen(upstream);
    t.after(() => upstream.close());

    const proxy = createEgressProxy({
      rules: rules(`allowed.test:${upstreamPort}`),
      resolve: async () => ['127.0.0.1'],
      allowPrivateTargets: true,
      log: () => undefined,
    });
    const proxyPort = await listen(proxy);
    t.after(() => proxy.close());

    const response = await speak(
      proxyPort,
      `CONNECT blocked.test:${upstreamPort} HTTP/1.1\r\nHost: blocked.test\r\n\r\n`,
    );
    assert.match(response, /^HTTP\/1\.1 403 Forbidden/);
    assert.equal(dialled, 0);
  });

  test('an allowed host on an unlisted PORT is refused', async (t) => {
    const proxy = createEgressProxy({
      rules: rules('allowed.test:443'),
      resolve: async () => ['93.184.216.34'],
      log: () => undefined,
    });
    const proxyPort = await listen(proxy);
    t.after(() => proxy.close());

    const response = await speak(
      proxyPort,
      'CONNECT allowed.test:22 HTTP/1.1\r\nHost: allowed.test:22\r\n\r\n',
    );
    assert.match(response, /^HTTP\/1\.1 403/);
  });

  test('BY DEFAULT an allowed name resolving to a private address is refused', async (t) => {
    // Invariant 3's last line of defence, and the reason `allowPrivateTargets` above is a
    // test seam rather than a configuration option: armada-daemon, armada-db, armada-forge,
    // armada-models and every host-published port live on exactly these addresses.
    let dialled = 0;
    const upstream = createTcpServer((socket) => {
      dialled += 1;
      socket.end();
    });
    const upstreamPort = await listen(upstream);
    t.after(() => upstream.close());

    const proxy = createEgressProxy({
      rules: rules(`allowed.test:${upstreamPort}`),
      resolve: async () => ['127.0.0.1'],
      log: () => undefined,
    });
    const proxyPort = await listen(proxy);
    t.after(() => proxy.close());

    const response = await speak(
      proxyPort,
      `CONNECT allowed.test:${upstreamPort} HTTP/1.1\r\nHost: allowed.test\r\n\r\n`,
    );
    assert.match(response, /^HTTP\/1\.1 403/);
    assert.match(response, /invariant 3/);
    assert.equal(dialled, 0, 'the daemon-side address is never dialled');
  });

  test('a direct IP request is checked against the allowlist like any other host', async (t) => {
    const proxy = createEgressProxy({
      rules: rules('allowed.test'),
      resolve: async () => {
        assert.fail('an IP literal must not be resolved');
      },
      log: () => undefined,
    });
    const proxyPort = await listen(proxy);
    t.after(() => proxy.close());

    const response = await speak(
      proxyPort,
      'CONNECT 93.184.216.34:443 HTTP/1.1\r\nHost: 93.184.216.34\r\n\r\n',
    );
    assert.match(response, /^HTTP\/1\.1 403/);
  });

  test('a relative-URI request is a 400 — this is a proxy, not an origin server', async (t) => {
    const proxy = createEgressProxy({ rules: rules('allowed.test'), log: () => undefined });
    const proxyPort = await listen(proxy);
    t.after(() => proxy.close());

    const response = await speak(proxyPort, 'GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    assert.match(response, /^HTTP\/1\.1 400/);
  });

  test('a host that does not resolve is refused rather than erroring open', async (t) => {
    const proxy = createEgressProxy({
      rules: rules('allowed.test'),
      resolve: async () => {
        throw new Error('ENOTFOUND');
      },
      log: () => undefined,
    });
    const proxyPort = await listen(proxy);
    t.after(() => proxy.close());

    const response = await speak(proxyPort, 'CONNECT allowed.test:443 HTTP/1.1\r\n\r\n');
    assert.match(response, /^HTTP\/1\.1 403/);
  });
});

describe('the proxy reads the same allowlist the daemon validated', () => {
  test('the env round-trips through the one parser', () => {
    const validated = validateProfiles(
      { web: allowlistProfile(['*.npmjs.org', 'example.com:8443']) },
      EGRESS_BLOCK,
      NO_ENV,
    )['web'];
    assert.ok(validated?.egress);

    const parsed = rulesFromEnv(JSON.stringify(validated.egress.allowedHosts));
    // Two independent parses of the same entries must agree, or the proxy would filter to
    // a list nobody wrote.
    assert.deepEqual(parsed, validated.egress.rules);
  });

  test('an absent or empty allowlist is fatal, never an empty filter', () => {
    assert.throws(() => rulesFromEnv(undefined), /unset/);
    assert.throws(() => rulesFromEnv('[]'), /non-empty/);
    assert.throws(() => rulesFromEnv('not json'), /valid JSON/);
    assert.throws(() => rulesFromEnv('["*"]'), /allowlist/);
  });
});

describe('CONNECT target parsing', () => {
  test('host:port', () => {
    assert.deepEqual(splitAuthority('example.com:443', 443), { host: 'example.com', port: 443 });
  });
  test('a bare host takes the default port', () => {
    assert.deepEqual(splitAuthority('example.com', 443), { host: 'example.com', port: 443 });
  });
  test('a bracketed IPv6 literal is split correctly, then refused by the grammar', () => {
    assert.deepEqual(splitAuthority('[2001:db8::1]:8443', 443), { host: '2001:db8::1', port: 8443 });
  });
  test('a malformed bracket yields no host, which matches nothing', () => {
    assert.equal(splitAuthority('[2001:db8::1', 443).host, '');
  });
});
