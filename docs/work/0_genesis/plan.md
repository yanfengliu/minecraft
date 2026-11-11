# Tidewick: voxel engine, living village, wildlife, weather and physics

Status: active
Owner: Claude (genesis-1111 session)
Created: 2026-11-11
Updated: 2026-11-11

## Problem and outcome

The repository was empty. The owner asked for a voxel sandbox game with high visual quality (lighting, water), a simulated medieval village with an economy and daily routines, a dynamic day and night cycle and weather, a wildlife ecosystem and realistic physics, documented to the fleet's structure. The outcome is a game that runs from `npm run dev`, passes `npm run verify`, and shows each of those systems working on screen.

## Scope

Included: the engine (world storage, light, generation, meshing, WebGL2 deferred renderer), first-person player with block editing, inventory and trade, sky, weather and seasons, the village simulation, the wildlife simulation, the four physics systems, the DOM interface, gates and docs. The owner's decisions and the design are in [the spec](../../design/spec.md).

Excluded: multiplayer, save files, audio, touch controls, combat and survival stats, continuous integration (none is configured for this repository).

Ownership: the session owns the plan, the contracts (`src/core`, `src/world`, `src/sim/api.ts`, `clock.ts`, `sky.ts`, `weather.ts`), the renderer, generation, the player, the interface and integration. Three delegated workers each own one headless directory against those contracts: `src/sim/village` with `src/sim/nav`, `src/sim/eco`, and `src/physics`.

## Approach

Contracts first, then parallel work. Milestone 0 lands the toolchain, gates, block and item registries, world storage, light, walkability, the clock, sky and weather models, the simulation contracts and the spec. From that base the three headless simulations are built in isolated worktrees while the session builds what the player sees. Each simulation ships a headless soak test of its own invariants, so it can be judged by running it, not by its author's summary. Integration wires the simulations into the game, draws their creatures and bodies, and adds the interface.

Dependencies and architecture calls the owner delegated are recorded in [the spec's decisions](../../design/spec.md#10-decisions).

## Acceptance criteria

- `npm run verify` passes on the merged result: typecheck, lint, unit and soak tests, docs check, and the browser gate on the GPU.
- In the running game, looked at through the real controls: the island renders with sun shadows, baked light and ambient occlusion, a sky that runs through day, dusk, night and dawn, clouds, and reflective and refractive water; weather changes include rain, storm, fog and snow.
- Villagers visibly follow a daily routine, work their trades with visible effects on the world, and trade with the player at prices that move; the ledger shows prices, stocks and population.
- Wildlife is visible, behaves by species and time of day, and the census shows populations that persist over simulated years in the headless soak.
- Spilled water flows, pools and drains; sand and gravel fall and pile; a felled tree or undermined structure comes down as rigid bodies; dropped items can be picked up.
- The frame rate holds 60 frames per second at 1280 x 720 on the development machine, measured through the debug interface.
- Docs follow the fleet structure: AGENTS.md with the canon block, the spec, the devlog summary and detail, the lessons queue, and this work unit with its review rounds.

## Implementation steps

- [x] M0 — Toolchain, gates, registries, world storage, light, walkability, clock, sky, weather, contracts, spec. Session.
- [x] M1 — Island generation, meshing, the deferred renderer, sky, water, the player and block editing. Session.
- [ ] Village simulation and pathfinding, headless with soak tests. Delegated worker, branch from M0.
- [ ] Wildlife simulation, headless with soak tests. Delegated worker, branch from M0.
- [ ] Physics: fluid, loose blocks, structure, rigid bodies, headless with tests. Delegated worker, branch from M0.
- [ ] M2 — Clouds, weather effects, seasons, volumetrics, post-processing. Session.
- [ ] M3 — Village generation, integration of the three simulations, entity and body rendering, interface. Session.
- [ ] M4 — Inspection through the real controls, tuning, performance, independent review, fixes.

## Outcome

Pending while work is open.
