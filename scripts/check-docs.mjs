#!/usr/bin/env node
// Docs gate. Checks the things about this repo's documents that can rot
// without any test noticing:
//
//   - every relative Markdown link points at a file that exists
//   - AGENTS.md still carries the generated fleet canon block, and CLAUDE.md is
//     exactly the one-line pointer to it
//   - the devlog summary exists and has dated lines
//   - every lesson in the queue names the gate that will retire it
//   - no tracked file breaks the fleet size limits (R23): 1 MiB for any file,
//     512 KiB for a binary
//
// Run as `npm run docs:check`; it is part of `npm run verify`.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const fail = (msg) => problems.push(msg);

const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && existsSync(join(root, f)));

// --- links ------------------------------------------------------------------
const linkRe = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
for (const file of tracked.filter((f) => f.endsWith('.md'))) {
  const text = readFileSync(join(root, file), 'utf8');
  // Fenced code holds example links that are not meant to resolve.
  const prose = text.replace(/```[\s\S]*?```/g, '');
  for (const m of prose.matchAll(linkRe)) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const path = target.split('#')[0].replace(/:\d+$/, '');
    if (!path) continue;
    if (!existsSync(resolve(root, dirname(file), path))) fail(`${file}: broken link -> ${target}`);
  }
}

// --- fleet shape --------------------------------------------------------------
const agents = existsSync(join(root, 'AGENTS.md')) ? readFileSync(join(root, 'AGENTS.md'), 'utf8') : '';
if (!agents) fail('AGENTS.md is missing');
if (agents && (!agents.includes('<!-- FLEET-CANON:BEGIN') || !agents.includes('<!-- FLEET-CANON:END -->'))) {
  fail('AGENTS.md has no FLEET-CANON block (run `npm run sync-canon -- --apply` from ../fleet)');
}
for (const heading of ['## What this is', '## Gates', '## Invariants & boundaries', '## Conventions']) {
  if (agents && !agents.includes(heading)) fail(`AGENTS.md is missing the "${heading}" section`);
}
const pointer = existsSync(join(root, 'CLAUDE.md')) ? readFileSync(join(root, 'CLAUDE.md'), 'utf8').replace(/\r\n/g, '\n') : null;
if (pointer !== '@AGENTS.md\n') fail('CLAUDE.md must be exactly "@AGENTS.md" and a newline');

// --- devlog -------------------------------------------------------------------
const summaryPath = join(root, 'docs/devlog/summary.md');
if (!existsSync(summaryPath)) fail('docs/devlog/summary.md is missing');
else {
  const summary = readFileSync(summaryPath, 'utf8');
  if (!summary.startsWith('# Devlog Summary')) fail('docs/devlog/summary.md must start with "# Devlog Summary"');
  if (!/^- \d{4}-\d{2}-\d{2}: /m.test(summary)) fail('docs/devlog/summary.md has no dated line');
}

// --- lessons queue --------------------------------------------------------------
const lessonsPath = join(root, 'docs/learning/lessons.md');
if (!existsSync(lessonsPath)) fail('docs/learning/lessons.md is missing');
else {
  const rules = readFileSync(lessonsPath, 'utf8').split(/^## Rules\s*$/m)[1] ?? '';
  for (const line of rules.split('\n')) {
    if (line.startsWith('- ') && !line.includes('**gate:**')) fail(`lessons.md: rule names no gate -> ${line.slice(0, 80)}`);
  }
}

// --- size limits -----------------------------------------------------------------
const MIB = 1024 * 1024;
for (const file of tracked) {
  const size = statSync(join(root, file)).size;
  if (size > MIB) fail(`${file}: ${(size / MIB).toFixed(2)} MiB exceeds the 1 MiB limit`);
  else if (size > MIB / 2) {
    const head = readFileSync(join(root, file)).subarray(0, 8192);
    if (head.includes(0)) fail(`${file}: binary of ${(size / 1024).toFixed(0)} KiB exceeds the 512 KiB limit`);
  }
}

if (problems.length > 0) {
  console.error(`docs:check found ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`docs:check ok (${tracked.filter((f) => f.endsWith('.md')).length} Markdown files, ${tracked.length} tracked files)`);
