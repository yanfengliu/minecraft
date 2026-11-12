// The village and the wildlife together, on the island the game actually
// generates. Each has its own soak on a fixture; this is the only headless test
// of what joins them: the fisher and the hunter drawing on the real wildlife,
// animals keeping clear of the real village, and residents finding their way
// over generated ground rather than a flat test world.

import { describe, expect, it } from 'vitest';
import { Rng } from './core/rng';
import { Life } from './life';
import { createBasicActions } from './sim/api';
import { Clock, SIM_DT } from './sim/clock';
import { Weather } from './sim/weather';
import { BLOCKS, OPAQUE } from './world/blocks';
import { generateIsland } from './world/gen/island';
import { DEFAULT_ISLAND } from './world/gen/terrain';
import { buildVillage } from './world/gen/village';
import { LightEngine } from './world/light';

/** Simulated hours the island is run for: two working days and the night between, and on into a third morning. */
const HOURS = 54;

describe('the island, lived in', () => {
  it('runs two days of village and wildlife together', () => {
    const { world, plan } = generateIsland(DEFAULT_ISLAND, buildVillage);
    expect(plan, 'the default island has a village').not.toBeNull();
    const { center, forest, hunting } = plan!;
    // The ground the far trades work is within a walk of the square, there and back inside a working day.
    const walk = (a: { x: number; z: number }): number => Math.hypot(a.x - center.x, a.z - center.z);
    expect(walk(forest), 'forest').toBeLessThan(150);
    expect(walk(hunting), 'hunting ground').toBeLessThan(190);

    // As in the game: light is repaired on every edit the simulations make.
    new LightEngine(world).attach();
    const clock = new Clock(6.5);
    const rng = new Rng(DEFAULT_ISLAND.seed ^ 0x5eed);
    const weather = new Weather(rng.fork('weather'), clock);
    const life = new Life(world, clock, weather, rng.fork('life'), plan, createBasicActions(world));
    const village = life.village!;
    const eco = life.eco;
    const people = village.people.length;
    const kinds = eco.census().length;
    const coin = village.ledger().coin;
    const tradeOf = (name: string): number => village.professions.indexOf(name);
    const woodcutter = tradeOf('woodcutter');
    const hunter = tradeOf('hunter');
    expect(woodcutter).toBeGreaterThanOrEqual(0);
    expect(hunter).toBeGreaterThanOrEqual(0);

    const buried: string[] = [];
    let inForest = 0;
    let stalking = 0;
    let slowest = 0;
    // Blocks written in the tick in hand, and the most in any one tick: what a tick costs the game is mostly
    // what it writes, since every write is relit and its section meshed again.
    let writes = 0;
    let mostWrites = 0;
    world.changed.on(() => {
      writes++;
    });
    const steps = Math.round((HOURS * 60) / SIM_DT);
    for (let i = 0; i < steps; i++) {
      clock.advance(SIM_DT);
      weather.update(SIM_DT);
      writes = 0;
      const began = performance.now();
      life.tick();
      // The first ticks fill the caches that every later one reads.
      if (i > 50) slowest = Math.max(slowest, performance.now() - began);
      mostWrites = Math.max(mostWrites, writes);
      if (i % 600 !== 0) continue;
      for (const r of village.core.residents) {
        const v = r.view;
        // Nobody has been flung off the map, and nobody stands inside the ground or a wall.
        expect(Number.isFinite(v.x + v.y + v.z)).toBe(true);
        const at = world.get(Math.floor(v.x), Math.floor(v.y + 0.3), Math.floor(v.z));
        if (OPAQUE[at]) buried.push(`${r.name} (${r.activity}) at ${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)} in ${BLOCKS[at]!.name} at ${clock.format()}`);
        if (r.trade === woodcutter && Math.hypot(v.x - forest.x, v.z - forest.z) <= forest.radius + 4) inForest++;
        if (r.trade === hunter && /^(Stalking|Taking aim|Fetching)/.test(r.activity)) stalking++;
      }
    }
    const s = village.stats;
    const after = eco.census();
    console.log(
      `island, ${HOURS} hours: ${people} people, ${village.views.length - people} farm animals, ${eco.views.length} wild; meals ${s.meals}, bread ${s.breadBaked}, `
      + `fish ${s.fishCaught}, hunted ${s.animalsHunted} (${s.killsFetched} fetched), trees felled ${s.treesFelled}, lamps lit ${s.lampsLit}, sown ${s.cellsSown}; `
      + `route failures ${s.pathFails}, teleports ${s.teleports}, strays ${s.strays}; forest ${walk(forest).toFixed(0)} and hunting ground ${walk(hunting).toFixed(0)} blocks out; `
      + `woodcutters seen in the forest ${inForest} times, the hunter on a stalk ${stalking} times; slowest tick ${slowest.toFixed(1)} ms, most blocks written in one ${mostWrites}`,
    );

    // The village lived a day: everyone still there, fed, on their feet, and found their way.
    expect(village.people.length).toBe(people);
    expect(s.meals).toBeGreaterThan(people * 2);
    expect(s.breadBaked).toBeGreaterThan(0);
    expect(s.lampsLit).toBeGreaterThan(0);
    expect(s.cellsSown + s.cellsTilled).toBeGreaterThan(0);
    expect(s.teleports).toBe(0);
    expect(buried).toEqual([]);
    expect(village.ledger().coin).toBe(coin);
    // The trades that work away from the village got to their ground and did their work there. (With a
    // search limit that suited the small test village, the woodcutters and the hunter never arrived, and
    // the hunter was carried home; and no game ever stood where the hunter then waited for it.)
    expect(s.treesFelled).toBeGreaterThan(0);
    expect(inForest, 'a woodcutter was seen in the forest').toBeGreaterThan(0);
    expect(stalking, 'the hunter was seen after game').toBeGreaterThan(0);
    expect(s.animalsHunted, 'the hunter brought something down').toBeGreaterThan(0);
    // And walked to it and carried it home: a kill may still be lying at the end of the run, but none is forgotten.
    expect(s.animalsHunted - s.killsFetched, 'kills shot and never brought in').toBeLessThanOrEqual(1);

    // The wildlife is all still there.
    expect(after.length).toBe(kinds);
    for (const row of after) expect(row.count, row.kind).toBeGreaterThan(0);
    for (const row of after) expect(row.count, row.kind).toBeLessThanOrEqual(row.cap);

    // What joins the two: every animal the hunter took came out of the wildlife's own books, not out
    // of thin air, and the fisher's catch came off the stock of the water. (Fish are a stock with a few
    // drawn to stand for it, so the wildlife counts the drawn fish taken out, never more than were landed.)
    const landed = after.find((r) => r.kind === 'fish')!.hunted;
    const taken = after.filter((r) => r.kind !== 'fish').reduce((n, r) => n + r.hunted, 0);
    expect(s.fishCaught).toBeGreaterThan(0);
    expect(landed).toBeLessThanOrEqual(s.fishCaught);
    expect(taken).toBe(s.animalsHunted);

    // No tick does a frame's worth of work at once. What is held to is the blocks one tick writes, not the
    // time it takes: time on a shared machine says as much about the neighbours (the same run has measured
    // 13 ms alone and 94 ms beside the rest of the suite), and each write is what costs the game, in light
    // and in meshing. One felled tree is some 170 writes. Every sapling due on a day once became a tree in
    // the same tick, 120 ms of it; `flora.test.ts` holds trees to one a tick, and this holds everything else.
    expect(mostWrites).toBeLessThan(600);

    // And the wild animals have kept out of the built-up middle (foxes may slip in at night).
    const inside = eco.views.filter((v) => v.kind !== 'fox' && v.kind !== 'songbird' && v.kind !== 'crow' && v.kind !== 'gull' && Math.hypot(v.x - center.x, v.z - center.z) < 40);
    expect(inside.map((v) => v.kind)).toEqual([]);
  });
});
