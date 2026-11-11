import { type Page, expect, test } from '@playwright/test';

// The production build, in a real browser, on the GPU. These checks read what
// was actually drawn and where the player actually is; a page that boots and
// draws nothing must fail here.
//
// A software rasteriser would make every figure below meaningless, so the suite
// fails on one unless ALLOW_SOFTWARE_GL=1 says this host has no GPU (the frame
// time budget is then skipped).

const SOFTWARE = process.env.ALLOW_SOFTWARE_GL === '1';

// A quarter-size island: the same generator and renderer, a fraction of the load time. It is too
// small to hold the village, so the tests that need one load the full island.
const SMALL = '/?size=256';
const FULL = '/';

async function boot(page: Page, url = SMALL): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 600));
  });
  await page.goto(url);
  await page.waitForFunction(() => window.__tidewick?.ready === true, undefined, { timeout: 120_000 });
  const error = await page.evaluate(() => window.__tidewick?.error ?? null);
  expect(error, 'the game reported a boot error').toBeNull();
  // The game's own loop must be running; then it is stopped, so that every second of game time in
  // these tests is one the test asked for. Left running, it adds real time between a key press and
  // the step that follows, and how much depends on how busy the machine is.
  await page.waitForFunction(() => (window.__tidewick?.game?.fps ?? 0) > 0, undefined, { timeout: 30_000 });
  await page.evaluate(() => window.__tidewick!.game!.stop());
  return errors;
}

/** Mean colour of one row of the probe grid. */
function rowMean(pixels: number[], row: number, cols: number): [number, number, number] {
  let r = 0, g = 0, b = 0;
  for (let c = 0; c < cols; c++) {
    const o = (row * cols + c) * 3;
    r += pixels[o]!;
    g += pixels[o + 1]!;
    b += pixels[o + 2]!;
  }
  return [r / cols, g / cols, b / cols];
}

test('boots on the GPU and draws a lit world under a blue sky', async ({ page }) => {
  const errors = await boot(page);
  const renderer = await page.evaluate(() => window.__tidewick!.renderer);
  console.log(`WebGL renderer: ${renderer}`);
  if (!SOFTWARE) expect(renderer).not.toMatch(/swiftshader|llvmpipe|software|basic render/i);

  // Mid-morning, clear, looking level across the island from above the spawn.
  const pixels = await page.evaluate(() => {
    const t = window.__tidewick!;
    t.setHour(10);
    t.setWeather('clear');
    const s = t.game!.info.spawn;
    t.look(s.x, s.y + 14, s.z, 315, -12);
    t.step(0.5);
    return t.probe(16, 9);
  });
  const stats = await page.evaluate(() => window.__tidewick!.stats());
  console.log('stats', JSON.stringify(stats));
  expect(Number(stats.sections)).toBeGreaterThan(40);
  expect(Number(stats.triangles)).toBeGreaterThan(20_000);

  const sky = rowMean(pixels, 0, 16);
  const ground = rowMean(pixels, 8, 16);
  console.log('sky', sky.map(Math.round), 'ground', ground.map(Math.round));
  // Sky: clearly blue, and bright. Ground: lit, and not sky-coloured.
  expect(sky[2]).toBeGreaterThan(sky[0] + 25);
  expect(sky[2]).toBeGreaterThan(110);
  expect(ground[0] + ground[1] + ground[2]).toBeGreaterThan(90);
  expect(ground[2]).toBeLessThan(ground[1] + 30);
  // The frame has detail: many distinct probe colours, not a flat fill.
  const distinct = new Set<number>();
  for (let i = 0; i < pixels.length; i += 3) distinct.add(((pixels[i]! >> 3) << 10) | ((pixels[i + 1]! >> 3) << 5) | (pixels[i + 2]! >> 3));
  expect(distinct.size).toBeGreaterThan(40);

  expect(errors).toEqual([]);
});

test('night is dark and the day comes back', async ({ page }) => {
  await boot(page);
  const brightness = async (hour: number): Promise<number> => page.evaluate((h) => {
    const t = window.__tidewick!;
    t.setHour(h);
    t.setWeather('clear');
    const s = t.game!.info.spawn;
    t.look(s.x, s.y + 14, s.z, 315, -12);
    t.step(3);
    const p = t.probe(16, 9);
    return p.reduce((a, b) => a + b, 0) / p.length;
  }, hour);
  const noon = await brightness(12);
  const midnight = await brightness(0);
  console.log(`mean brightness: noon ${noon.toFixed(1)}, midnight ${midnight.toFixed(1)}`);
  expect(noon).toBeGreaterThan(90);
  expect(midnight).toBeLessThan(noon * 0.45);
  expect(midnight).toBeGreaterThan(2);
});

test('the player walks, jumps and lands under real key presses', async ({ page }) => {
  await boot(page);
  const where = (): Promise<{ x: number; y: number; z: number; ground: boolean }> => page.evaluate(() => {
    const p = window.__tidewick!.game!.player;
    return { x: p.x, y: p.y, z: p.z, ground: p.onGround };
  });
  const step = (seconds: number): Promise<void> => page.evaluate((s) => window.__tidewick!.step(s), seconds);

  await step(1);
  const rest = await where();
  expect(rest.ground).toBe(true);

  await page.keyboard.down('KeyW');
  await step(1.5);
  const walked = await where();
  const distance = Math.hypot(walked.x - rest.x, walked.z - rest.z);
  // Walking pace is 4.3 m/s; allow for getting up to speed and for the lie of the land.
  expect(distance).toBeGreaterThan(3);
  expect(distance).toBeLessThan(7);

  await page.keyboard.down('Space');
  await step(0.4);
  const air = await where();
  await page.keyboard.up('Space');
  await step(1.5);
  await page.keyboard.up('KeyW');
  await step(0.5);
  const landed = await where();
  expect(air.ground).toBe(false);
  expect(air.y).toBeGreaterThan(walked.y + 0.4);
  expect(landed.ground).toBe(true);
});

test('a frame fits the 60 Hz budget at 1280 x 720', async ({ page }) => {
  test.skip(SOFTWARE, 'no GPU on this host');
  await boot(page);
  const ms = await page.evaluate(() => {
    const t = window.__tidewick!;
    t.setHour(15);
    const s = t.game!.info.spawn;
    t.look(s.x, s.y + 20, s.z, 315, -15);
    t.step(1);
    t.probe(2, 2);
    const frames = 120;
    const t0 = performance.now();
    t.step(frames / 60);
    // Reading back waits for the GPU to finish everything queued above.
    t.probe(2, 2);
    return (performance.now() - t0) / (frames + 1);
  });
  console.log(`frame time: ${ms.toFixed(2)} ms`);
  expect(ms).toBeLessThan(16.6);
});

test('the full island holds a village and still fits the frame budget', async ({ page }) => {
  const errors = await boot(page, FULL);
  await page.waitForFunction(() => window.__tidewick!.game!.pool.pending === 0, undefined, { timeout: 120_000 });
  const plan = await page.evaluate(() => {
    const p = window.__tidewick!.game!.plan;
    return p && { buildings: p.buildings.length, fields: p.fields.length, lamps: p.lamps.length, x: p.center.x, y: p.center.y, z: p.center.z };
  });
  expect(plan, 'the full island has no village').not.toBeNull();
  console.log('village', JSON.stringify(plan));
  expect(plan!.buildings).toBeGreaterThanOrEqual(20);
  expect(plan!.fields).toBeGreaterThanOrEqual(2);

  // The heaviest ordinary view: the whole village and the hills behind it, from the air.
  const frame = async (label: string, dx: number, dy: number, dz: number, yaw: number, pitch: number): Promise<number> => {
    const ms = await page.evaluate(([x, y, z, yw, pt]) => {
      const t = window.__tidewick!;
      t.setHour(15);
      t.setWeather('fair');
      t.look(x!, y!, z!, yw!, pt!);
      t.step(1);
      t.probe(2, 2);
      const frames = 90;
      const t0 = performance.now();
      t.step(frames / 60);
      t.probe(2, 2);
      return (performance.now() - t0) / (frames + 1);
    }, [plan!.x + dx, plan!.y + dy, plan!.z + dz, yaw, pitch]);
    const stats = await page.evaluate(() => window.__tidewick!.stats());
    console.log(`${label}: ${ms.toFixed(2)} ms, ${stats.drawCalls} draws, ${stats.triangles} triangles, ${stats.visible} sections`);
    return ms;
  };
  const aerial = await frame('aerial', -60, 38, 50, 130, -24);
  const street = await frame('street', 0.5, 2.7, -10.5, 20, 0);
  if (!SOFTWARE) {
    expect(aerial).toBeLessThan(16.6);
    expect(street).toBeLessThan(16.6);
  }

  // The square is paved and lit: the probe at street level is neither sky nor black.
  const pixels = await page.evaluate(() => window.__tidewick!.probe(16, 9));
  const ground = rowMean(pixels, 8, 16);
  expect(ground[0] + ground[1] + ground[2]).toBeGreaterThan(60);
  expect(errors).toEqual([]);
});
