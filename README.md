# Tidewick

An original first-person voxel sandbox for the browser: a bounded island with a simulated medieval village, a wildlife ecosystem, a full day and season cycle with weather, and physics for water, loose ground, rigid bodies and collapsing structures, drawn by a custom WebGL2 renderer. The repository is named `minecraft` for the genre; the game, its art and its creatures are its own.

## Status

Playable. You walk, jump, swim and fly (F) around a generated island with a mountain, a lake, a river, forests and a village, break blocks (hold left mouse) and place them (right mouse; number keys pick the slot), and trade with the villagers.

- **The village.** About sixty residents with names, households and sixteen trades keep a daily and weekly routine: they sleep, eat, work their fields, ovens, forges and looms, light the lamps at dusk, gather on the square on fair day and shelter from rain. Twenty-two goods are made, carried, sold and used, at prices that move with the stores; coin is conserved exactly. Right-click a villager to talk, or to trade if they are at a counter or stall. `L` opens the ledger.
- **Wildlife.** Deer, rabbits, boar, foxes, a wolf pack, songbirds, crows, gulls, ducks and fish live off the plants and each other, breed in season and die of age, hunger and predators. Plants spread, ripen and are grazed; felled woodland regrows. `K` opens the census with each kind's numbers over time.
- **Sky and weather.** A sun and moon cross a physically based sky through a 28-day year of four seasons. Weather moves between clear, fair, overcast, rain, storm and fog, with dawn mist, volumetric clouds that cast shadows, wet ground and puddles, snow cover and lightning. `T` opens the almanac, which can set the hour, the pace of time and the weather.
- **Physics.** Spilt water flows, pools and conserves its volume; sand, gravel and snow fall and heap; a tree you cut or a wall you undermine comes down as rigid bodies; broken blocks drop as items you pick up by walking over them.
- **Rendering.** A custom WebGL2 deferred renderer: four shadow cascades, baked sky and torch light, ambient occlusion, light shafts through mist, refractive and reflective water with caustics, bloom and filmic tone mapping. About 5 ms a frame at 1280 x 720 on the development machine with everything running.

Not there: sound, saving, any combat or survival pressure, and touch controls. Known rough edges are listed at the end of [the work plan](docs/work/0_genesis/plan.md); [the devlog](docs/devlog/summary.md) has the history.

Add `?size=256` to the address for an island a third as wide that loads in a second (it is too small to hold the village), and `?seed=7` for a different one. `H` in the game lists the keys.

## Running it

Node 24.

```bash
npm install
```

```bash
npm run dev
```

The dev server listens on http://127.0.0.1:5317.

```bash
npm run verify
```

`verify` runs the type check, lint, unit and simulation tests, the docs check and the browser gate. The browser gate needs Playwright's Chromium (`npx playwright install chromium`) and a GPU; set `ALLOW_SOFTWARE_GL=1` on a machine without one.

To look at the game without a window, `node scripts/capture.mjs <spec.json>` drives a headless browser on the GPU against the running dev server and saves full-resolution frames to `output/captures/`; the header of that script describes the spec.

## Where things are

- [docs/design/spec.md](docs/design/spec.md) — the design, with a section map and the dated decisions.
- [AGENTS.md](AGENTS.md) — gates, invariants and conventions for anyone (or any agent) changing the code.
- `src/core`, `src/world`, `src/sim`, `src/physics` — headless: math, voxels, the village (`sim/village`, `sim/nav`), the wildlife (`sim/eco`), and physics. They run in Node tests and in workers.
- `src/render`, `src/player`, `src/ui` — what the player sees and touches.
- `src/game.ts`, `src/life.ts` — the loop, and the context the two simulations share.

## Part of a fleet

This repo is one of the sibling repos kept side by side under one `github/` folder. Fleet-wide rules and setup live in [fleet](https://github.com/yanfengliu/fleet).
