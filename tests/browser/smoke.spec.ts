import { type Page, expect, test } from '@playwright/test';

// The production build, in a real browser, on the GPU. These checks read what
// was actually drawn and where the player actually is; a page that boots and
// draws nothing must fail here.
//
// A software rasteriser would make every figure below meaningless, so the suite
// fails on one unless ALLOW_SOFTWARE_GL=1 says this host has no GPU (the frame
// time budget is then skipped).

const SOFTWARE = process.env.ALLOW_SOFTWARE_GL === '1';

// An island a third as wide: the same generator and renderer, a fraction of the load time. It is too
// small to hold the village, so the tests that need one load the full island.
const SMALL = '/?size=256';
const FULL = '/';

/** What the page of the test in hand has thrown or logged as an error. */
let pageErrors: string[] = [];

// Every test ends with a clean console, whatever else it was about: an exception in a frame handler
// leaves the page drawing, and the test that provoked it would otherwise pass.
test.afterEach(() => {
  const errors = pageErrors;
  pageErrors = [];
  expect(errors, 'errors on the page during the test').toEqual([]);
});

async function boot(page: Page, url = SMALL): Promise<string[]> {
  const errors: string[] = [];
  pageErrors = errors;
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
  // And on round the clock to the next morning: the light has to come back, not only go.
  const morning = await brightness(9);
  console.log(`mean brightness: noon ${noon.toFixed(1)}, midnight ${midnight.toFixed(1)}, the next morning ${morning.toFixed(1)}`);
  expect(noon).toBeGreaterThan(90);
  expect(midnight).toBeLessThan(noon * 0.45);
  expect(midnight).toBeGreaterThan(2);
  expect(morning).toBeGreaterThan(80);
  expect(morning).toBeGreaterThan(midnight * 2);
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

test('ambient occlusion leaves a flat, high-contrast wall alone', async ({ page }) => {
  await boot(page);
  // Birch bark is the hardest case in the tile set: black marks on white, each with painted relief.
  // The wall is flat, so occlusion has nothing to find on it and must not darken it.
  const r = await page.evaluate(async () => {
    const t = window.__tidewick!;
    const g = t.game!;
    const birch = t.block('birch_log');
    const s = g.info.spawn;
    const cx = Math.floor(s.x);
    const cz = Math.floor(s.z) + 12;
    const y0 = Math.floor(s.y) + 30;
    for (let x = cx - 7; x <= cx + 7; x++) for (let y = y0; y <= y0 + 10; y++) g.world.set(x, y, cz, birch);
    t.setHour(12);
    t.setWeather('clear');
    // Looking south at the wall's shaded face, where ambient light (the part occlusion scales) is all there is.
    t.look(cx + 0.5, y0 + 5.5, cz - 4, 0, 0);
    // The wall is meshed by workers, whose answers arrive only when this script yields.
    for (let i = 0; i < 100; i++) {
      t.step(0.05);
      await new Promise((done) => setTimeout(done, 30));
      if (i > 3 && g.pool.pending === 0) break;
    }
    t.step(1);
    const built = g.world.get(cx, y0 + 5, cz) === birch;
    const mean = (on: boolean): number => {
      g.renderer.settings.ssao = on;
      t.step(0.1);
      const p = t.probe(16, 9);
      let sum = 0;
      let n = 0;
      // The middle of the frame, well inside the wall.
      for (let row = 2; row <= 6; row++) {
        for (let col = 4; col <= 11; col++) {
          const o = (row * 16 + col) * 3;
          sum += p[o]! + p[o + 1]! + p[o + 2]!;
          n += 3;
        }
      }
      return sum / n;
    };
    // Several frames each way: the pass is dithered per frame.
    let on = 0;
    let off = 0;
    for (let i = 0; i < 4; i++) {
      on += mean(true);
      off += mean(false);
    }
    // The wall must fill the probed area: its sides and top are far outside it, so every probe is bark.
    const p = t.probe(16, 9);
    let bluest = -255;
    for (let row = 2; row <= 6; row++) for (let col = 4; col <= 11; col++) bluest = Math.max(bluest, p[(row * 16 + col) * 3 + 2]! - p[(row * 16 + col) * 3]!);
    return { on: on / 4, off: off / 4, built, bluest };
  });
  console.log(`flat wall: ${r.on.toFixed(1)} with occlusion, ${r.off.toFixed(1)} without (bluest probe ${r.bluest})`);
  expect(r.built).toBe(true);
  // Sky is far bluer than bark in shade: if any probe is that blue, the wall was not drawn.
  expect(r.bluest).toBeLessThan(40);
  expect(r.off).toBeGreaterThan(40);
  expect(Math.abs(r.on - r.off) / r.off).toBeLessThan(0.03);
});

test('creatures and loose bodies reach the screen', async ({ page }) => {
  await boot(page);
  // Counting boxes handed to the renderer would pass with nothing drawn, so this reads pixels: the
  // same view with and without a row of creatures standing in it, and with a block hung in the air.
  const r = await page.evaluate(async () => {
    const t = window.__tidewick!;
    const g = t.game!;
    t.setHour(12);
    t.setWeather('clear');
    const s = g.info.spawn;
    const sx = Math.floor(s.x);
    const sz = Math.floor(s.z);
    const floor = Math.floor(s.y) + 38;
    // A stone stage well above the trees for the creatures to stand on, seen from its near edge looking along it.
    const stone = t.block('stone');
    for (let x = sx + 3; x <= sx + 10; x++) for (let z = sz - 13; z <= sz + 13; z++) g.world.set(x, floor, z, stone);
    t.look(sx + 0.5, floor + 1 + 1.62, sz + 0.5, 90, -4);
    // The stage is meshed by workers, whose answers arrive only when this script yields.
    for (let i = 0; i < 100; i++) {
      t.step(0.05);
      await new Promise((done) => setTimeout(done, 30));
      if (i > 3 && g.pool.pending === 0) break;
    }
    t.step(1);
    g.paused = true;
    const grid = (): number[] => t.probe(32, 18);
    const changed = (a: number[], b: number[]): number => {
      let n = 0;
      for (let i = 0; i < a.length; i += 3) if (Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!) > 40) n++;
      return n;
    };
    const empty = grid();
    const still = changed(empty, grid());
    // One of every kind of creature, in two rows across the stage.
    g.showLineUp('idle');
    t.step(0.05);
    const withCreatures = changed(empty, grid());
    g.lineUp.length = 0;
    t.step(0.05);
    const cleared = changed(empty, grid());
    // A wall of blocks hung in the air eight metres ahead, held there by nothing but the pause.
    for (let dy = 0; dy <= 4; dy++) for (let dz = -3; dz <= 3; dz++) g.physics.spawnBlock(stone, sx + 8.5, floor + 1.5 + dy, sz + 0.5 + dz);
    t.step(0.05);
    const withBodies = changed(empty, grid());
    return { still, withCreatures, cleared, withBodies };
  });
  console.log('drawn', JSON.stringify(r));
  // The empty stage is steady from one frame to the next...
  expect(r.still).toBeLessThanOrEqual(4);
  // ...thirty creatures five to seven metres off change a good part of it, and it comes back when they go...
  // (With the draw call removed their shadows alone still changed 19 cells and the blocks' 17, against
  // 85 and 114 drawn: the limits sit between.)
  expect(r.withCreatures).toBeGreaterThan(45);
  expect(r.cleared).toBeLessThanOrEqual(4);
  // ...and so do thirty-five blocks a metre across.
  expect(r.withBodies).toBeGreaterThan(60);
});

test('things fall: a block, a pile of sand, and a dropped loaf the player picks up', async ({ page }) => {
  const errors = await boot(page);
  const r = await page.evaluate(() => {
    const t = window.__tidewick!;
    const g = t.game!;
    const stone = t.block('stone');
    const sand = t.block('sand');
    const bread = t.item('bread');
    // A stone stage well above the trees, so the lie of the land cannot change the result.
    const s = g.info.spawn;
    const cx = Math.floor(s.x) + 8;
    const cz = Math.floor(s.z);
    const top = Math.floor(s.y) + 24;
    for (let x = cx - 3; x <= cx + 3; x++) for (let z = cz - 3; z <= cz + 3; z++) g.world.set(x, top, z, stone);
    t.step(0.2);

    const id = g.physics.spawnBlock(stone, cx + 0.5, top + 5.5, cz + 0.5);
    g.world.set(cx + 2, top + 4, cz, sand);
    const body = () => g.physics.bodies.find((b) => b.id === id);
    const y0 = body()!.y;
    t.step(0.3);
    const fell = y0 - body()!.y;
    t.step(5);
    const rest = body();
    const before = g.inventory.count(bread);
    const p = g.player;
    g.physics.spawnItem(bread, 3, p.x, p.y + 1, p.z);
    t.step(0.6);
    return {
      fell,
      // Square on the stage, the stone goes back into the grid; had it landed crooked it would lie there asleep.
      landed: rest ? rest.sleeping && Math.abs(rest.y - (top + 1.5)) < 0.1 : g.world.get(cx, top + 1, cz) === stone,
      awake: g.physics.stats.awakeBodies,
      falling: g.physics.stats.falling,
      sandLeft: g.world.get(cx + 2, top + 4, cz) === 0,
      sandLanded: g.world.get(cx + 2, top + 1, cz) === sand,
      picked: g.inventory.count(bread) - before,
      stepMs: g.physics.stats.stepMs,
    };
  });
  console.log('physics', JSON.stringify(r));
  // Free fall for 0.3 s is 0.44 m.
  expect(r.fell).toBeGreaterThan(0.3);
  expect(r.fell).toBeLessThan(0.6);
  expect(r.landed).toBe(true);
  expect(r.awake).toBe(0);
  expect(r.falling).toBe(0);
  expect(r.sandLeft).toBe(true);
  expect(r.sandLanded).toBe(true);
  expect(r.picked).toBe(3);
  expect(errors).toEqual([]);
});

test('the player trades with a villager through the real controls', async ({ page }) => {
  const errors = await boot(page, FULL);
  // Run the morning on until someone is serving, then find a place to stand from which the crosshair rests on them.
  const found = await page.evaluate(() => {
    const t = window.__tidewick!;
    const g = t.game!;
    const village = g.life.village!;
    t.setWeather('clear');
    t.setTimeScale(30);
    let seller = village.people.find((p) => village.canTrade(p.id));
    for (let i = 0; i < 400 && !seller; i++) {
      t.step(0.25);
      seller = village.people.find((p) => village.canTrade(p.id));
    }
    t.setTimeScale(1);
    if (!seller) return null;
    const p = g.player;
    p.flying = false;
    for (const radius of [2.2, 1.7, 2.8]) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const x = seller.x + Math.sin(a) * radius;
        const z = seller.z + Math.cos(a) * radius;
        p.teleport(x, seller.y + 0.05, z);
        t.step(0.3);
        // Aim from the eye at the seller's chest.
        const dx = seller.x - p.x;
        const dy = seller.y + 1.25 - (p.y + 1.62);
        const dz = seller.z - p.z;
        p.yaw = Math.atan2(dx, dz);
        p.pitch = Math.atan2(dy, Math.hypot(dx, dz));
        t.step(0.05);
        if (g.focus?.id === seller.id && village.canTrade(seller.id)) {
          const l = village.ledger();
          return { id: seller.id, prompt: g.focusPrompt(), coins: g.inventory.coins, bread: g.inventory.count(t.item('bread')), closed: l.coin - l.playerNet, clock: String(t.stats().clock) };
        }
      }
    }
    return { id: -1, prompt: '', coins: 0, bread: 0, closed: 0, clock: String(t.stats().clock) };
  });
  expect(found, 'nobody was serving all morning').not.toBeNull();
  console.log('seller', JSON.stringify(found));
  expect(found!.id, 'no place to stand from which the seller can be looked at').toBeGreaterThan(0);
  expect(found!.prompt).toBe('Right-click to trade');

  // A real right click at the crosshair opens the trade window.
  const step = (seconds: number): Promise<void> => page.evaluate((s) => window.__tidewick!.step(s), seconds);
  await page.mouse.click(640, 360, { button: 'right' });
  await step(0.05);
  expect(await page.evaluate(() => window.__tidewick!.game!.hud.open)).toBe('trade');
  await expect(page.locator('.panel h2')).toHaveText('Trade');

  // One loaf, with a real click on its button: a coin price leaves the purse and a loaf arrives.
  const price = await page.evaluate(() => window.__tidewick!.game!.life.village!.quoteBuy('bread', 1));
  expect(price).not.toBeNull();
  await page.locator('.panel button[data-act="buy:bread*1"]').click();
  await expect(page.locator('.panel .note')).toContainText('Bought 1 bread');
  const after = await page.evaluate(() => {
    const t = window.__tidewick!;
    const g = t.game!;
    const l = g.life.village!.ledger();
    return { coins: g.inventory.coins, bread: g.inventory.count(t.item('bread')), closed: l.coin - l.playerNet };
  });
  expect(after.coins).toBe(found!.coins - (price as number));
  expect(after.bread).toBe(found!.bread + 1);
  // No coin was made or lost between the two of them.
  expect(after.closed).toBe(found!.closed);

  // Escape closes the window and ends the dealing.
  await page.keyboard.press('Escape');
  await step(0.05);
  const end = await page.evaluate(() => ({ open: window.__tidewick!.game!.hud.open, partner: window.__tidewick!.game!.trade!.partner }));
  expect(end.open).toBeNull();
  expect(end.partner).toBe(-1);
  expect(errors).toEqual([]);
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

  // The island is lived in: people and wild animals exist, are drawn, and go about on their own.
  const life = await page.evaluate(() => {
    const t = window.__tidewick!;
    const g = t.game!;
    const village = g.life.village!;
    const where = (list: readonly { id: number; x: number; z: number }[]): Map<number, [number, number]> => new Map(list.map((v) => [v.id, [v.x, v.z]]));
    const moved = (list: readonly { id: number; x: number; z: number }[], from: Map<number, [number, number]>): number =>
      list.filter((v) => { const a = from.get(v.id); return a !== undefined && Math.hypot(v.x - a[0], v.z - a[1]) > 1.5; }).length;
    t.setHour(9.5);
    t.setTimeScale(5);
    t.step(1);
    const people0 = where(village.people);
    const wild0 = where(g.life.eco.views);
    // Half a game hour: long enough for errands to be run and herds to drift.
    t.step(6);
    t.setTimeScale(1);
    const census = Object.fromEntries(g.life.eco.census().map((r) => [r.kind, r.count]));
    return {
      people: village.people.length,
      peopleMoved: moved(village.people, people0),
      teleports: village.stats.teleports,
      wild: g.life.eco.views.length,
      wildMoved: moved(g.life.eco.views, wild0),
      census,
      boxes: g.renderer.entities.count,
      prompt: typeof g.focusPrompt(),
    };
  });
  console.log('life', JSON.stringify(life));
  expect(life.people).toBeGreaterThanOrEqual(40);
  expect(life.peopleMoved).toBeGreaterThanOrEqual(8);
  expect(life.teleports).toBe(0);
  expect(life.wild).toBeGreaterThanOrEqual(150);
  expect(life.wildMoved).toBeGreaterThanOrEqual(20);
  for (const kind of ['deer', 'rabbit', 'boar', 'fox', 'wolf', 'songbird', 'crow', 'gull', 'duck', 'fish']) expect(life.census[kind], kind).toBeGreaterThan(0);
  // That they are drawn is checked by pixels in 'creatures and loose bodies reach the screen'.
  expect(errors).toEqual([]);
});
