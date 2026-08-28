/**
 * Locates `services/dashboard/src` from inside the compiled test output.
 *
 * `npm test` compiles TypeScript into `dist-test/` and runs node there, so `__dirname` is
 * `dist-test/src/__tests__` rather than `src/__tests__`. The token tests read
 * `styles/tokens.css` as TEXT — deliberately, so they assert against the stylesheet the
 * browser actually loads rather than a TypeScript mirror of it — and CSS is not emitted
 * into `dist-test`, so a relative walk from `__dirname` lands nowhere.
 *
 * Walking up to the directory containing package.json rather than counting `..` segments:
 * a hard-coded `../../..` silently resolves to the wrong directory the moment `outDir`
 * changes, and the failure would look like a missing token file rather than a moved one.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

function packageRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate the dashboard package root walking up from ${__dirname}`);
}

/** Absolute path to `services/dashboard/src`. */
export const SRC_DIR = join(packageRoot(), 'src');

/** Absolute path of a file under `src`, e.g. `sourceFile('styles', 'tokens.css')`. */
export function sourceFile(...parts: string[]): string {
  return join(SRC_DIR, ...parts);
}
