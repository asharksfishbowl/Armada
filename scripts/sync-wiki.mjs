#!/usr/bin/env node
//
// Publish docs/ to the GitHub wiki.
//
//     node scripts/sync-wiki.mjs <path-to-cloned-wiki>
//
// THE WIKI IS A MIRROR, NEVER A SOURCE. docs/ is version-controlled, reviewed in the
// same PR as the code it describes, and is the only place to edit. The wiki is
// generated from it, so an edit made in the wiki UI is silently reverted by the next
// sync — which is why every generated page carries a banner saying so.
//
// Two directories describing the same system, each independently editable, diverge.
// This is the cheapest structure that prevents that: one writable source, one derived
// copy, and a workflow that keeps them equal.
//
// LINKS ARE THE WHOLE JOB. GitHub renders the two spaces differently:
//
//   in docs/        [Architecture](Architecture.md)      relative file, resolves in-tree
//   in the wiki     [Architecture](Architecture)         page name, no extension
//
// and a docs/ link that escapes the directory (`../specs/...`, `../LICENSE`) has no
// wiki equivalent at all — the wiki is a separate repository and cannot see the code.
// Those become absolute URLs into the main repo instead.

import { readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';

const wikiDir = process.argv[2];
if (!wikiDir) {
  console.error('usage: node scripts/sync-wiki.mjs <path-to-cloned-wiki>');
  process.exit(2);
}

const REPO = 'https://github.com/asharksfishbowl/Armada/blob/main';
const DOCS = 'docs';

// `getting-started.md` is the one file whose name does not already read as a wiki page
// title. GitHub renders a page filename by replacing `-` with a space, so `Getting-
// Started` becomes "Getting Started" while `getting-started` becomes "getting started".
const PAGE_NAME = { 'getting-started': 'Getting-Started' };

const pageFor = (stem) => PAGE_NAME[stem] ?? stem;

const sources = readdirSync(DOCS).filter((f) => f.endsWith('.md'));
const stems = sources.map((f) => basename(f, '.md'));

function rewriteLinks(body) {
  return body
    // Escapes docs/ entirely — the wiki cannot resolve these, so point at the repo.
    .replace(/\]\(\.\.\/([^)]+)\)/g, (_m, rest) => `](${REPO}/${rest})`)
    // A sibling doc becomes a wiki page reference: no path, no extension.
    .replace(/\]\(([A-Za-z0-9._-]+)\.md(#[^)]*)?\)/g, (m, stem, anchor = '') => {
      if (!stems.includes(stem)) return m;   // not one of ours — leave it alone
      return `](${pageFor(stem)}${anchor})`;
    });
}

const BANNER = (src) =>
  `<!-- GENERATED FILE — DO NOT EDIT IN THE WIKI.\n` +
  `     Source: ${DOCS}/${src} in asharksfishbowl/Armada.\n` +
  `     Edits made here are overwritten by the next sync. Change the source instead. -->\n\n`;

// Remove pages we no longer generate, so a deleted doc does not linger as a stale page.
// `_Sidebar.md` is ours too and is rewritten below; anything else was hand-created and
// is left alone rather than silently deleted.
const generated = new Set([...stems.map((s) => `${pageFor(s)}.md`), '_Sidebar.md']);
for (const existing of readdirSync(wikiDir).filter((f) => f.endsWith('.md'))) {
  if (!generated.has(existing)) continue;
  unlinkSync(join(wikiDir, existing));
}

for (const src of sources) {
  const stem = basename(src, '.md');
  const body = readFileSync(join(DOCS, src), 'utf8');
  writeFileSync(join(wikiDir, `${pageFor(stem)}.md`), BANNER(src) + rewriteLinks(body));
}

// Sidebar order is explicit rather than alphabetical: it is a reading order, and
// "Architecture, Concepts, Configuration" is only an ordering by accident of spelling.
const ORDER = [
  ['Running it', ['getting-started', 'Configuration', 'Zero-Cost-Operation']],
  ['Understanding it', ['Architecture', 'Concepts', 'Invariants']],
  ['Changing it', ['Specifications', 'Roadmap', 'Contributing']],
  ['Legal', ['Licensing']],
];
const listed = new Set(ORDER.flatMap(([, s]) => s));
const missing = stems.filter((s) => s !== 'Home' && !listed.has(s));
if (missing.length) {
  // Loud rather than silently dropped from navigation — an unreachable page is the
  // same as no page.
  console.error(`ERROR: docs page(s) missing from the sidebar order: ${missing.join(', ')}`);
  console.error('Add them to ORDER in scripts/sync-wiki.mjs.');
  process.exit(1);
}

const sidebar =
  BANNER('(sidebar is built by scripts/sync-wiki.mjs)') +
  `### [Armada](Home)\n\n` +
  ORDER.map(([heading, entries]) =>
    `**${heading}**\n\n` +
    entries.map((s) => `- [${pageFor(s).replace(/-/g, ' ')}](${pageFor(s)})`).join('\n')
  ).join('\n\n') + '\n';
writeFileSync(join(wikiDir, '_Sidebar.md'), sidebar);

console.log(`synced ${sources.length} pages + sidebar to ${wikiDir}`);
