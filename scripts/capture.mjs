// Renders named views of the running game to PNG files for inspection.
//
//   node scripts/capture.mjs <spec.json>
//
// The spec is { url?, width?, height?, out?, shots: [{ name, eval?, step?, settle?, clip? }] }.
// Each shot runs `eval` in the page, advances the game by `step` seconds, waits
// for meshing to settle, and saves output/captures/<name>.png. In `eval`, `t` is
// the debug interface (`window.__tidewick`) and `g` the game; `at(x, z)` gives
// the standing height there, `clear(ax, ay, az, bx, by, bz)` says whether one
// point can see another, and `watch(creature, distance, lift)` points the camera
// at a creature from a side with a clear view.
// It drives a headless Chromium on the GPU, like the browser gate, so what it
// saves is what a player sees at that resolution.

import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const specPath = process.argv[2];
if (!specPath) {
  console.error('usage: node scripts/capture.mjs <spec.json>');
  process.exit(2);
}
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const outDir = resolve(spec.out ?? 'output/captures');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({
  viewport: { width: spec.width ?? 1600, height: spec.height ?? 900 },
  deviceScaleFactor: 1,
});
page.on('console', (m) => {
  if (m.type() === 'error') console.error('page error:', m.text().slice(0, 600));
});
page.on('pageerror', (e) => console.error('page exception:', String(e).slice(0, 600)));

await page.goto(spec.url ?? 'http://127.0.0.1:5317/');
await page.waitForFunction(() => window.__tidewick?.ready === true, null, { timeout: 120_000 });
const failure = await page.evaluate(() => window.__tidewick.error);
if (failure) {
  console.error('the game failed to start:', failure);
  await browser.close();
  process.exit(1);
}
console.log('renderer:', await page.evaluate(() => window.__tidewick.renderer));

// Standing height at a column: the first cell above the highest block that is not part of a tree.
await page.evaluate(async () => {
  const B = await import('/src/world/blocks.ts').catch(() => null);
  const world = window.__tidewick.game.world;
  window.at = (x, z) => {
    for (let y = world.sy - 1; y > 0; y--) {
      const s = world.get(Math.floor(x), y, Math.floor(z));
      if (s === 0) continue;
      if (B && (B.IS_LEAVES[s] || B.IS_LOG[s] || !B.SOLID[s])) continue;
      return y + 1;
    }
    return 1;
  };
  // True if nothing solid (or leafy) lies on the straight line between two points.
  window.clear = (ax, ay, az, bx, by, bz) => {
    const n = Math.ceil(Math.hypot(bx - ax, by - ay, bz - az) * 3);
    for (let i = 1; i < n; i++) {
      const k = i / n;
      const s = world.get(Math.floor(ax + (bx - ax) * k), Math.floor(ay + (by - ay) * k), Math.floor(az + (bz - az) * k));
      if (s !== 0 && B && (B.SOLID[s] || B.IS_LEAVES[s])) return false;
    }
    return true;
  };
  // Point the camera at a creature (or any { x, y, z }) from the first of twelve sides with a clear view of it.
  window.watch = (v, dist = 7, lift = 2.5) => {
    for (let k = 0; k < 12; k++) {
      const a = (k * Math.PI) / 6;
      const cx = v.x + Math.sin(a) * dist;
      const cz = v.z + Math.cos(a) * dist;
      const cy = Math.max(window.at(cx, cz), v.y) + lift;
      if (!window.clear(cx, cy, cz, v.x, v.y + 0.6, v.z)) continue;
      window.__tidewick.look(cx, cy, cz, (Math.atan2(v.x - cx, v.z - cz) * 180) / Math.PI, (Math.atan2(v.y + 0.6 - cy, dist) * 180) / Math.PI);
      return true;
    }
    return false;
  };
});

const settle = () => page.waitForFunction(() => window.__tidewick.game.pool.pending === 0, null, { timeout: 120_000 });
await settle();

for (const shot of spec.shots) {
  if (shot.eval) {
    const result = await page.evaluate(`(async () => { const t = window.__tidewick; const g = t.game; ${shot.eval} })()`);
    if (result !== undefined) console.log(`${shot.name}:`, JSON.stringify(result));
  }
  if (shot.step) await page.evaluate((s) => window.__tidewick.step(s), shot.step);
  await settle();
  // Let the temporal passes (clouds, exposure) catch up with the new view.
  await page.waitForTimeout(shot.settle ?? 700);
  const file = resolve(outDir, `${shot.name}.png`);
  // `clip` is [x, y, width, height] in pixels, for a closer look at part of the frame.
  const clip = shot.clip ? { x: shot.clip[0], y: shot.clip[1], width: shot.clip[2], height: shot.clip[3] } : undefined;
  await page.screenshot({ path: file, clip });
  console.log('saved', file);
}

await browser.close();
