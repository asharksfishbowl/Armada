/**
 * P12 — config/mcp-servers.yaml. Agent Runtime R50, R52; edge 18.
 *
 * Two properties matter here and they pull in opposite directions.
 *
 * THE SHIPPED FILE MUST ENABLE NOTHING. The MVP costs nothing to run: a default
 * installation needs no credential and makes no egress, and MCP is the one subsystem in
 * the daemon that can break that. The first describe reads the REAL file, so enabling a
 * server by editing config fails a unit test rather than a code review.
 *
 * AND EVERY FAULT MUST BE CAUGHT AT STARTUP. The repo convention is that a configuration
 * fault surfaces on boot, collecting all of them, not at first use. Edge 18's duplicate
 * name is the case that cannot be deferred at all: namespacing (R51) cannot tell two
 * servers called `github` apart, so a Run would silently reach whichever one won the map.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

import { McpConfigError, loadMcpServers } from '../mcp/config.js';
import { collectCredentialEnvNames } from '../events/event-log.js';

const CONFIG_DIR = new URL('../../../../config/', import.meta.url).pathname;

function problemsOf(raw: unknown): string[] {
  try {
    loadMcpServers(raw);
    return [];
  } catch (err) {
    assert.ok(err instanceof McpConfigError, 'a config fault must be an McpConfigError');
    return err.problems;
  }
}

describe('the SHIPPED config/mcp-servers.yaml', () => {
  const raw = parseYaml(readFileSync(`${CONFIG_DIR}mcp-servers.yaml`, 'utf8')) as unknown;

  test('parses, and enables NO server', () => {
    const config = loadMcpServers(raw);
    // Invariant: the MVP costs nothing to run. One uncommented server here would make a
    // default install reach something external and, for every example in the file, want a
    // credential it does not have.
    assert.deepEqual(config.servers, []);
  });

  test('carries a request bound, so an unresponsive server cannot hold a Step open', () => {
    assert.ok(loadMcpServers(raw).requestTimeoutMs > 0);
  });

  test('contains no credential VALUE, only names — invariant 8', () => {
    const text = readFileSync(`${CONFIG_DIR}mcp-servers.yaml`, 'utf8');
    // Every env_keys entry, commented or not, must look like a variable name and never
    // like an assignment.
    assert.ok(!/env_keys[\s\S]{0,200}?[:=]\s*['"]?[A-Za-z0-9_-]{20,}/.test(text));
  });
});

describe('R52 — env_keys reach the event sink\'s redaction list', () => {
  test('collectCredentialEnvNames finds names in the LIST shape servers actually use', () => {
    // The sink redacts by VALUE, resolved from these NAMES. A name that does not reach it
    // is a credential that would be written verbatim into an Event — the acceptance
    // criterion "grepping the events table for a configured MCP credential returns no
    // matches" fails on exactly this.
    const names = collectCredentialEnvNames([
      {
        servers: [
          { name: 'github', transport: 'stdio', command: ['x'], env_keys: ['GH_TOKEN'] },
          { name: 'docs', transport: 'http', url: 'http://d/mcp', env_keys: ['DOCS_TOKEN'] },
        ],
      },
    ]);
    assert.deepEqual(names.sort(), ['DOCS_TOKEN', 'GH_TOKEN']);
  });
});

describe('R50 — entry validation', () => {
  test('an empty file is valid and yields no servers', () => {
    assert.deepEqual(loadMcpServers({}).servers, []);
    assert.deepEqual(loadMcpServers(null).servers, []);
    assert.deepEqual(loadMcpServers({ servers: null }).servers, []);
  });

  test('a stdio server needs a command', () => {
    const problems = problemsOf({ servers: [{ name: 'a', transport: 'stdio' }] });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /stdio server requires `command`/);
  });

  test('an http server needs an http(s) url', () => {
    assert.match(
      problemsOf({ servers: [{ name: 'a', transport: 'http', url: 'ftp://x' }] })[0]!,
      /requires `url`/,
    );
  });

  test('the transports do not accept each other\'s fields', () => {
    assert.match(
      problemsOf({ servers: [{ name: 'a', transport: 'stdio', command: ['x'], url: 'http://y' }] })[0]!,
      /`url` belongs to an http server/,
    );
    assert.match(
      problemsOf({ servers: [{ name: 'a', transport: 'http', url: 'http://y', command: ['x'] }] })[0]!,
      /`command` belongs to a stdio server/,
    );
  });

  test('an unknown transport is named, not defaulted', () => {
    assert.match(
      problemsOf({ servers: [{ name: 'a', transport: 'websocket', url: 'http://y' }] })[0]!,
      /`transport` must be one of stdio, http/,
    );
  });

  test('EVERY fault is collected, not just the first', () => {
    const problems = problemsOf({
      servers: [
        { name: '', transport: 'stdio' },
        { name: 'b', transport: 'http' },
      ],
    });
    // An operator with two bad entries fixes both in one restart.
    assert.ok(problems.length >= 3, problems.join('\n'));
  });

  test('a typo in a key is a fault, not a silently ignored setting', () => {
    assert.match(
      problemsOf({ servers: [{ name: 'a', transport: 'stdio', command: ['x'], envkeys: ['T'] }] })[0]!,
      /unknown key `envkeys`/,
    );
    assert.match(problemsOf({ server: [] })[0]!, /unknown key `server`/);
  });

  test('`servers` as a MAPPING is refused — it is the bug that produced index keys', () => {
    // `Object.keys` over a list yields "0", "1". index.ts did exactly that, so every
    // correctly-named `tools.mcp` grant failed Agent validation. Reject the shape.
    assert.match(problemsOf({ servers: { github: {} } })[0]!, /`servers` must be a list/);
  });

  test('a valid pair of servers loads with env_keys as NAMES', () => {
    const config = loadMcpServers({
      request_timeout_seconds: 5,
      servers: [
        { name: 'github', transport: 'stdio', command: ['npx', '-y', 'srv'], env_keys: ['GH_TOKEN'] },
        { name: 'docs', transport: 'http', url: 'https://d/mcp' },
      ],
    });
    assert.equal(config.requestTimeoutMs, 5000);
    assert.deepEqual(config.servers[0], {
      name: 'github',
      transport: 'stdio',
      command: ['npx', '-y', 'srv'],
      envKeys: ['GH_TOKEN'],
    });
    assert.deepEqual(config.servers[1], {
      name: 'docs',
      transport: 'http',
      url: 'https://d/mcp',
      envKeys: [],
    });
  });
});

describe('edge 18 — name collisions and the namespace separator', () => {
  test('two servers with the same name FAIL STARTUP, naming the collision', () => {
    const problems = problemsOf({
      servers: [
        { name: 'github', transport: 'stdio', command: ['a'] },
        { name: 'github', transport: 'http', url: 'http://b/mcp' },
      ],
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /two MCP servers are configured with the name `github`/);
  });

  test('a name containing the separator is refused (R51)', () => {
    // `a__b` would make `a__b__run` split as server `a`, tool `b__run` — a namespace
    // addressing a server that does not exist.
    assert.match(
      problemsOf({ servers: [{ name: 'a__b', transport: 'stdio', command: ['x'] }] })[0]!,
      /may not contain `__`/,
    );
  });
});

describe('R52 — the http credential mechanism is stated, not guessed', () => {
  test('more than one env key on an http server is refused at STARTUP', () => {
    // The value is sent as `Authorization: Bearer`. Accepting three variables and using
    // one would be a requirement enforced nowhere: the operator would believe all three
    // were delivered and nothing would ever say otherwise.
    const problems = problemsOf({
      servers: [{ name: 'd', transport: 'http', url: 'http://d/mcp', env_keys: ['A', 'B'] }],
    });
    assert.match(problems[0]!, /at most one `env_keys` entry/);
  });

  test('a stdio server may declare several', () => {
    const config = loadMcpServers({
      servers: [{ name: 'a', transport: 'stdio', command: ['x'], env_keys: ['A', 'B'] }],
    });
    assert.deepEqual(config.servers[0]?.envKeys, ['A', 'B']);
  });
});
