# Tidewick design

Section map — read the section your work touches, not the whole file.

1. [Product](#1-product) — what the game is and the owner's decisions.
2. [Architecture](#2-architecture) — layers, threads, the frame and the tick.
3. [World model](#3-world-model) — coordinates, sections, block states, light, water kinds.
4. [Rendering](#4-rendering) — the deferred pipeline, pass by pass.
5. [Simulation core](#5-simulation-core) — clock, sky, weather, contracts in `src/sim/api.ts`.
6. [Village](#6-village) — residents, routines, work, economy.
7. [Wildlife](#7-wildlife) — flora, fauna, population dynamics.
8. [Physics](#8-physics) — finite water, loose blocks, structure, rigid bodies.
9. [Player and UI](#9-player-and-ui).
10. [Decisions](#10-decisions) — dated, with reasons.

## 1. Product

Tidewick is an original first-person voxel sandbox that runs in the browser. The player explores a bounded island about 768 blocks across, breaks and places blocks, and trades with a medieval village that goes about its own life: residents sleep, work, eat, shop and gather on a daily and weekly rhythm, and an economy of some twenty goods prices itself from supply and demand. Around the village a wildlife ecosystem lives and dies by its own rules. The sky runs a full day, moon and four-season year; weather moves through clear, cloud, rain, storm, fog and snow. Water flows and conserves volume, loose ground falls and piles, cut trees and undermined buildings come down as rigid bodies.

Owner decisions (2026-11-11): standalone engine (no `../voxel`, no `../civ-engine`); the player is an explorer-builder with an inventory and coins, no health, hunger or combat; all four physics systems (flowing water, rigid bodies, falling loose blocks, structural collapse); a bounded island ringed by endless sea. The owner asked for a clean start: sibling engines and fleet habits do not bind this repo where they hold it back, and such calls are recorded in section 10.

The game is original. The repository is named for the genre; no Minecraft names, textures, characters, sounds or levels may be added.

Visual target: blocky 16-pixel procedural textures under modern lighting — cascaded sun shadows, baked sky and torch light with ambient occlusion, a physically based sky, volumetric clouds and light shafts, reflective and refractive water, wet ground in rain, snow cover in winter, bloom and filmic tone mapping.

## 2. Architecture

Layers, lowest first. A layer may import only from layers above it in this list.

- `src/core` — math, seeded random, noise, events.
- `src/world` — block and item registries, voxel storage, light, walkability, generation.
- `src/sim` — clock, sky, weather, the contracts (`api.ts`), the village (`village/`, `nav/`) and wildlife (`eco/`).
- `src/physics` — fluid, loose blocks, structure, rigid bodies.
- `src/mesh` — section meshing (runs in workers).
- `src/render`, `src/player`, `src/ui` — WebGL2 renderer, first-person controller, DOM interface.
- `src/game.ts`, `src/main.ts` — wiring and the loop.

`core`, `world`, `sim`, `physics` and `mesh` are headless: no DOM, no renderer imports, usable from workers and from Vitest in Node.

Threads: the main thread owns the world arrays, all simulation and rendering. One generation worker builds the island and its first lighting at load. A pool of mesh workers turns sections into vertex buffers; each job receives a copy of a section with a one-cell border.

Time: rendering runs per animation frame. The simulation clock advances in fixed steps of `SIM_DT` = 0.1 simulated seconds; time-lapse runs more steps per frame. Player and rigid-body physics run in real time at 60 Hz regardless of time-lapse.

## 3. World model

One block is one metre. East is +x, south is +z, up is +y. The world is `sx` by `sy` by `sz` cells (default 768 x 128 x 768), stored as 32-cubed sections; a section that is one state throughout stores no array. Outside the world `World.get` returns bedrock below, air above, and to the sides open sea below `seaLevel` and air above it.

A cell holds one Uint16 block state id. `src/world/blocks.ts` defines every state and documents the variant layout (orientation, growth stage, lit, water level) at the top of the file; `B.<name>` is a family's base id and flat arrays (`SOLID`, `OPAQUE`, `LIGHT_OPACITY`, `EMIT`, `WATER_LEVEL`, `MATERIAL`, ...) answer per-state questions. `MATERIALS` carries density, friction, restitution, span and hardness. `src/world/items.ts` derives one item per placeable block family and adds the economy goods.

Light is two flood-filled 0..15 channels per cell (`src/world/light.ts`): sky visibility and block light. Incremental repair after an edit is held to exact agreement with a full recompute by a property test.

Water comes in three kinds. `water_source` is infinite still water: the sea and lakes. `river` (eight direction variants) is infinite water with a baked flow direction: river channels. `water` (sixteen variants, level 1..16 sixteenths) is finite water that moves and conserves volume; it appears when a source spills or something adds water. See section 8.

Walkability has one definition, `standHeight` in `src/world/walk.ts`: feet cell and the cell above clear, and a walkable top beneath — a full-height block below, or a low step (slab, stair, path) in the feet cell.

## 4. Rendering

A custom WebGL2 renderer; no scene-graph library. Per frame:

1. Shadow maps: four cascades of the sun (or moon), depth only, cutout-tested for foliage.
2. G-buffer: albedo, normal and roughness, baked sky light, block light and ambient occlusion, depth. Section meshes, then instanced entities and debris.
3. Screen-space ambient occlusion at half resolution, depth-aware blur.
4. Lighting: sun or moon through the cascades, sky ambient scaled by baked sky light and occlusion, warm block light, emissive, cloud shadows, wetness and snow cover, underwater caustics, aerial perspective.
5. Sky: atmosphere from a per-frame sky-view lookup, sun, moon with phase, stars, volumetric clouds.
6. Water and glass, forward shaded: refraction of the lit scene, screen-space reflection with sky fallback, Fresnel, waves, flow, shoreline foam, rain rings.
7. Particles: rain and snow (occluded by the world heightmap), splashes, smoke, sparks, leaves.
8. Volumetric fog and light shafts at half resolution.
9. Bloom, exposure adaptation, tone mapping and grading, antialiasing.

Section meshes use 8 bytes per vertex: packed position in sixteenths, ambient occlusion, normal, tile layer, sky and block light, tint and wind classes. Textures are generated procedurally at load into a texture array whose layer order is `TILE_NAMES`.

## 5. Simulation core

`Clock` (`src/sim/clock.ts`): one in-game minute is one simulated second; a day is 1440 s, a week seven days, a season one week, a year 28 days. `Fairday` is the weekly market, `Restday` the day of rest.

`src/sim/sky.ts` gives the sun and moon directions for latitude 48 N, so day length runs from about 8 hours in winter to 16 in summer.

`Weather` (`src/sim/weather.ts`) is a Markov chain of regimes whose continuous state eases toward regime targets. Simulations read it through `WeatherView`.

`src/sim/api.ts` holds the contracts: `EntityView` (what the renderer draws), `InspectInfo`, `SimContext`, the cross-simulation services `WildlifeApi` and `LivestockApi`, `WorldActions`, and the `VillagePlan` with `validateVillagePlan`. World generation and every test fixture must produce a plan that validates.

Determinism: simulations take a forked `Rng`, advance only by `SIM_DT`, and never read the wall clock or `Math.random()`. The same seed and the same inputs give the same world.

## 6. Village

Code: `src/sim/village/` and `src/sim/nav/`. Facade: `VillageSim` — constructed from a `SimContext` and a `VillagePlan`, advanced by `tick()` once per clock step, exposing `views` (stable `EntityView` objects, mutated in place), `inspect(id)`, a `LivestockApi`, a ledger for the UI and a trade interface for the player.

Residents come from the plan: one per bed. A building with beds is a household; adults take the trade of the building they live in or commute to a workplace that needs hands, and about a fifth are children with no trade. Each resident has a name, an age, needs (hunger, energy, social), a mood derived from them, a purse, and a home larder shared with their household.

Routine: each trade has a daily template (rise, breakfast, commute, work blocks, midday meal, errands, evening, bed) bent by the weekday (fair day, rest day with a chapel service), the weather (outdoor work stops in hard rain or snow; people shelter) and the season (farm work follows the crop calendar; winter is for maintenance and firewood). An activity resolves to a standing cell, a path there, a timed action with an animation and a held item, and an effect.

Work that changes the world: farmers till, sow, tend and harvest real crop blocks on their fields; woodcutters fell real trees through `WorldActions.fellTree` and plant saplings; bakers and smiths light their oven and forge while working; households light lanterns at dusk when someone is home and awake, and put them out at bedtime; the watch lights the street lamps and walks the patrol at night; doors and gates are opened and closed by whoever passes; the shepherd drives the flock to pasture and back. Other trades (miller, brewer and innkeeper, fisher, hunter, weaver, carpenter, miner, smith, storekeeper, priest, reeve) transform goods at their work spots; the fisher and hunter draw on `WildlifeApi`.

Economy: goods are `ECONOMY_GOODS`. Each business keeps stock and coin and posts prices that rise as its stock falls below target and fall as it piles up. Households buy food, firewood, ale, cloth and tools; workers are paid; a village treasury takes a market fee and pays the watch and the priest. Money is conserved: every coin moves between purses, tills and the treasury. The player buys and sells at the same posted prices and moves them like anyone else.

Movement: A* over standable cells (step up or down one, doors and gates passable, cheaper on paths and roads, expensive across crops, no deep water), with a budget per tick and cached routes. A resident that cannot find a path after repeated tries is moved to its destination and the event counted; tests keep that count near zero.

Required tests, headless on a generated fixture village: the plan validates; over 14 simulated days nobody's hunger stays critical, everyone sleeps in their own bed each night, each trade reaches its workplace on work days, money is conserved to the coin, stocks never go negative, prices stay within bounds, bread is baked and eaten; over a simulated year fields are sown and harvested; the same seed reproduces the same state; a simulated day costs little enough for 60x time-lapse.

## 7. Wildlife

Code: `src/sim/eco/`. Facade: `EcoSim` — constructed from a `SimContext` and options (areas wild animals avoid), advanced by `tick()`, exposing `views`, `inspect(id)`, a `WildlifeApi`, and a census with population history for the UI.

Flora: tall grass and flowers spread onto open grass at a rate set by season and moisture, and are eaten by grazers (the plant block is removed), so grazing pressure is visible. Berry bushes ripen in summer and autumn and are stripped by animals and foragers. Saplings grow into trees through `growTree` when they have room and light; mature trees seed saplings nearby, so felled woodland regrows. Mushrooms come up in shaded forest in autumn.

Fauna: deer in herds (crepuscular grazers, forest by day), rabbits around warrens (fast breeders), boar in woodland, foxes (solitary, hunt rabbits and raid chickens at dusk and night), a wolf pack in the remote highland (hunts deer and boar, sometimes sheep at pasture), songbird flocks, crows, gulls over the coast, ducks on fresh water, and fish schools whose visible numbers follow a stock that regrows logistically and is drawn down by fishing. Each animal has energy, hunger, age and a state machine (graze, rest, flee, hunt, court, sleep); it reproduces in season when well fed, and dies of age, hunger, predation or the hunter. Animals keep away from people (`SimContext.people`, the player), shelter from hard rain, and follow day and night habits.

Movement: walkers follow the ground with `standHeight`, stepping one block, steering around obstacles, deep water and avoided areas; fliers are boids with terrain avoidance and perches; swimmers stay in water.

Required tests, headless: three simulated years on a fixture landscape end with every species present and none above its cap; grazing lowers plant cover and rest restores it; predators reduce prey and starve without it; saplings become trees; the same seed reproduces the same state; a tick stays cheap with a few hundred animals.

## 8. Physics

Code: `src/physics/`. Facade: `Physics` — constructed from a `World`, stepped in real time, exposing body views for the renderer, spawn and pickup calls, a flow query, and an event stream (splash, impact, collapse) for particles.

Units are SI and gravity is 9.81 m/s² for everything.

Fluid: finite water with integer levels 1..16. Each tick an active cell first drains into the cell below, then evens out with its four neighbours, moving whole units toward the lower side. Sources (sea, lake, river) never deplete; they spill finite water into open neighbours and swallow water that reaches them. A finite cell that is full, sits between two sources and rests on water or solid ground becomes a source, so lakes heal. Thin isolated films evaporate. Water entering a cell washes out plants. Only cells that changed, or whose neighbours changed, are simulated; a settled pool costs nothing. Volume is conserved exactly apart from sources and evaporation.

Loose blocks: sand, gravel and snow fall when nothing holds them, land where they come to rest, and slump sideways when a pile is steeper than its angle of repose.

Structure: when a block is removed, anything that was resting on it is tested for a path of solid blocks to the ground. Pieces left hanging become rigid bodies: a felled tree topples as one body and sheds its leaves on impact; an undermined wall comes down in chunks. A material's `span` limits how far it can cantilever.

Rigid bodies: dynamic boxes and compounds of boxes with mass from material density, colliding with the voxel world and each other, stacking and sleeping when at rest, floating or sinking by density, pushed by flowing water, breaking apart on hard impacts. Bodies that settle are returned to the grid or become item drops; a budget caps how many are live. Dropped items are small bodies the player picks up by walking near.

Required tests, headless: a closed basin conserves water to the unit and settles; a breach drains until levels meet; a source refills what is dug beside it; sand dropped from height lands and piles into a slope; cutting a trunk drops the tree and nothing else; a cube dropped on flat ground comes to rest on it and sleeps; a stack of five stays standing; wood floats and stone sinks; the same seed and inputs reproduce the same result.

## 9. Player and UI

First-person: walk, sprint, jump, swim, climb ladders; a box collider against block collision boxes with a half-block step-up. Left button breaks (time by hardness), right button places or uses (doors, gates, picking berries, talking and trading). A hotbar and inventory of item stacks; a purse of coins.

DOM interface over the canvas: crosshair, hotbar, clock and weather readout, inspector for the creature under the crosshair, trade window, village ledger (prices, stocks, population), wildlife census, settings, and time-lapse control.

`window.__tidewick` exposes a debug interface (teleport, set time and weather, read metrics) used by the browser gate and for inspection.

## 10. Decisions

- 2026-11-11 — Standalone engine, raw WebGL2, no Three.js. The owner chose standalone over `../voxel` (whose 1.3 scope excludes streaming, dynamic lights, custom passes and shadows) and `../civ-engine` (2D grid), then asked for a clean start unconstrained by fleet habit. A deferred pipeline with packed vertex formats, custom G-buffers and cascades is plainer and faster against the WebGL2 API than through a scene-graph library whose abstractions it would bypass.
- 2026-11-11 — Bounded island held wholly in memory, generated in one worker at load. A village and ecosystem that keep running wherever the player stands need a closed domain; an island makes the boundary natural and puts the sea on every horizon.
- 2026-11-11 — One Uint16 state id per cell with every variant flattened into the id, so each engine question is one array read.
- 2026-11-11 — Baked voxel light supplies ambient-sky visibility and torch light; sun and moon shadows come from shadow maps. The baked channels are cheap, exact at block scale and give dark interiors and caves; shadow maps give crisp moving shadows.
- 2026-11-11 — Natural water bodies are infinite sources; only spilled or added water is finite. A river simulated as finite flow would never settle and would re-mesh its whole length for ever; baked flow on source cells looks and pushes the same and costs nothing.
- 2026-11-11 — One gravity, 9.81 m/s², SI units, for the player and every body, with a jump of about 1.15 m so full blocks are still climbable.
- 2026-11-11 — Rigid bodies use the Rapier physics library (pending confirmation at integration): stable stacking and compound bodies are where a proven solver beats a hand-rolled one. It is the only runtime dependency.
- 2026-11-11 — No save files yet. Block state ids are positional in the block table; when saving arrives that order becomes a persistent format and must be versioned.
