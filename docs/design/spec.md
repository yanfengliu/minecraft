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

Layers, lowest first. A layer may import only from layers above it in this list, types included; a lint rule holds every layer to that.

- `src/core` — math, seeded random, noise, events.
- `src/world` — block and item registries, voxel storage, light, walkability, generation, and the village plan with its validator (`plan.ts`: generation produces the plan, so it is defined below the simulations that read it).
- `src/sim` — clock, sky, weather, the contracts (`api.ts`), the village (`village/`, `nav/`) and wildlife (`eco/`).
- `src/physics` — fluid, loose blocks, structure, rigid bodies.
- `src/mesh` — section meshing (runs in workers).
- `src/render`, `src/player`, `src/ui` — WebGL2 renderer, first-person controller, DOM interface.
- `src/workers` — the worker entry points (generation, meshing); thin glue around headless code.
- `src/game.ts`, `src/main.ts` — wiring and the loop.

`core`, `world`, `sim`, `physics` and `mesh` are headless: no DOM, no renderer imports, usable from workers and from Vitest in Node.

Threads: the main thread owns the world arrays, all simulation and rendering. One generation worker builds the island and its first lighting at load. A pool of mesh workers turns sections into vertex buffers; each job receives a copy of a section with a one-cell border.

Time: rendering runs per animation frame. The simulation clock advances in fixed steps of `SIM_DT` = 0.1 simulated seconds; time-lapse runs more steps per frame. The player's movement (steps of 1/120 s) and rigid-body physics (1/60 s) run in real time regardless of time-lapse.

## 3. World model

One block is one metre. East is +x, south is +z, up is +y. The world is `sx` by `sy` by `sz` cells (default 768 x 128 x 768), stored as 32-cubed sections; a section that came out of generation as one state throughout stores no array until its first edit (it is not collapsed again afterwards). Outside the world `World.get` returns bedrock below, air above, and to the sides open sea below `seaLevel` and air above it.

A cell holds one Uint16 block state id. `src/world/blocks.ts` defines every state and documents the variant layout (orientation, growth stage, lit, water level) at the top of the file; `B.<name>` is a family's base id and flat arrays (`SOLID`, `OPAQUE`, `LIGHT_OPACITY`, `EMIT`, `WATER_LEVEL`, `MATERIAL`, ...) answer per-state questions. `MATERIALS` carries density, friction, restitution, span and hardness. `src/world/items.ts` derives one item per placeable block family and adds the economy goods.

Light is two flood-filled 0..15 channels per cell (`src/world/light.ts`): sky visibility and block light. Incremental repair after an edit is held to exact agreement with a full recompute by property tests: edits scattered over rough ground, edits packed into one room so lamps of different strengths stand in each other's light, and edits in the world's top layers. An edit that changes neither how much light a block stops nor how much it gives off (a crop growing, a door swinging, soil wetted, water rising) is not repaired at all: the simulations make such edits all day.

Water comes in three kinds. `water_source` is infinite still water: the sea and lakes. `river` (eight direction variants) is infinite water with a baked flow direction: river channels. `water` (sixteen variants, level 1..16 sixteenths) is finite water that moves and conserves volume; it appears when a source spills or something adds water. See section 8. The one river leaves the lake through its rim at the lake's own level and comes down to the sea in single-block steps, its surface set from the ground as it lay before the channel was cut; no bank is lower than the water beside it, and where a lake stands well above the ground outside its rim the river drops that height in one ledge.

Walkability has one definition, `standHeight` in `src/world/walk.ts`: feet cell and the cell above clear, and a walkable top beneath. That is a block in the cell below whose top is more than half a block up (a full block, and equally a path, farmland or a stair), or a low step of half a block or less (a slab) in the feet cell itself.

## 4. Rendering

A custom WebGL2 renderer; no scene-graph library. `src/render/renderer.ts` runs the frame; the off-screen targets are in `targets.ts`, the end of the frame in `postChain.ts`. Per frame, in order:

1. Sky lookup: the atmosphere (Rayleigh, Mie, ozone, single scattering with the planet's shadow) for every direction into a small texture.
2. Clouds: a volume marched at quarter resolution and blended with last frame's. They sit where the wind so far has carried them: the travel is accumulated on the CPU (`drift.ts`) and wrapped at a length the noise cannot tell from a full turn. Nothing the wind moves is placed by the current wind times elapsed time, which would throw it about on every change of wind and further the longer the game has run.
3. Shadow maps: four cascades of the key light (sun, or moon at night), depth only, cutout-tested for foliage, updated in turn. Creatures and bodies cast into the nearer three.
4. G-buffer: albedo and emission, normal and roughness, baked sky light, block light and ambient occlusion, depth. Section meshes, then every creature, loose body, particle and the held item as instanced boxes (`entities/renderer.ts`). A box is one flat colour with a texel-sized grain, or carries a block's six tiles so that a block which leaves the grid keeps its faces.
5. Ambient occlusion at half resolution with a depth-aware blur. Its normal is rebuilt from depth: the G-buffer normal carries each tile's painted relief and must not be used by any screen-space pass.
6. Lighting: key light through the cascades and the cloud shadow, sky ambient scaled by baked sky light and occlusion, warm block light, emission, wetness, puddles and snow cover, then fog. Sky pixels are fogged too, by the weather's fog alone.
7. Water and glass, forward shaded over a copy of the lit scene: refraction, absorption with depth, screen-space reflection with the sky as fallback, Fresnel, waves, flow, surf on the sea and on rivers, rain rings, and caustics on the bed. Spilt (finite) water is marked by the mesher so that being shallow everywhere is not taken for a shoreline. The two share a mesh run and are drawn in two goes: water first, writing depth, so only the nearer of two sheets shows; glass after it without writing depth, because within a section faces come in mesh order and a pane that wrote depth would hide the window behind it.
8. The block outline, then rain or snow and splash rings as instanced quads, stopped by the world's rain heightmap. Drops are stateless: each is placed from its index and a clock that wraps every 1248 s, with fall speeds stepped so the wrap moves nothing.
9. Light shafts: each view ray marched at half resolution through the shadow cascades and the cloud shadow, in air whose density is the weather's fog (same height falloff as the distance fog) plus a little dust, with extinction along the ray; added with a depth-aware upsample.
10. Bloom, tone mapping and grading, antialiasing.

Light and exposure (`environment.ts`): the key light's colour is the sun's or moon's through the atmosphere; near the horizon it is dimmed further and kept from going pure red. Fog takes light out of the key beam and returns part of it as ambient fill, so thick fog has no shadows. Twilight needs no term of its own: each sample along a view ray is tested against the planet's shadow, so the air some kilometres up stays lit after the ground has lost the sun, and the sky fades over about ten degrees of sun (`atmosphere.test.ts` holds that fade free of cliffs). Exposure is computed from the light, not measured from the frame: it normalises an estimate of lit ground to a brightness that is designed by time of day, so night stays darker than day on purpose, and it opens up when the camera is under cover. Light that is authored, not simulated (torches, glowing tiles, stars, the moon's disc, lightning), is pre-scaled so it reads the same whatever the exposure.

Section meshes use 8 bytes per vertex: packed position in sixteenths, ambient occlusion, normal, tile layer, sky and block light, tint and wind classes; the layout is at the top of `src/mesh/mesher.ts`. Textures are painted procedurally at load (`src/render/tiles/`) into a texture array whose layer order is `TILE_NAMES`, and sampled so texels stay crisp squares under anisotropic filtering.

Looking at it: `scripts/capture.mjs` drives a headless browser on the GPU against the dev server and saves full-resolution frames; a spec can crop to part of the frame. The desktop app's own browser pane crops its screenshots when hidden and is not a substitute.

## 5. Simulation core

`Clock` (`src/sim/clock.ts`): one in-game minute is one simulated second; a day is 1440 s, a week seven days, a season one week, a year 28 days. `Fairday` is the weekly market, `Restday` the day of rest.

`src/sim/sky.ts` gives the sun and moon directions for latitude 48 N, so day length runs from about 8 hours in winter to 16 in summer.

`Weather` (`src/sim/weather.ts`) is a Markov chain of regimes (clear, fair, overcast, rain, storm, fog) whose continuous state eases toward regime targets over a few game hours, so a change is watched, not switched. On still, clear nights it also lays a dawn mist that burns off within a few hours of sunrise. Simulations read it through `WeatherView`.

`src/sim/api.ts` holds the contracts: `EntityView` (what the renderer draws; `hidden` marks a creature that is out of sight), `InspectInfo` (every bar reads "full is good"), `SimContext`, the cross-simulation services `WildlifeApi` and `LivestockApi`, `WorldActions`, and the `VillagePlan` with `validateVillagePlan` (both defined in `src/world/plan.ts` and re-exported here). World generation and every test fixture must produce a plan that validates: `generateIsland` checks the plan it returns against the world it built and throws, naming what is wrong, if they do not match, so the game cannot start on a village whose door, bed or field is not where the plan says. The village tests generate seven islands (two full size, five 512 across, where lots have to shift most often).

`src/life.ts` builds the one `SimContext` both simulations share in the game and ticks them each clock step: the wildlife first exists, then the village is given its `WildlifeApi`, and the wildlife the village's `LivestockApi` and its people. A frame runs at most 40 steps, so a time-lapse the simulations cannot keep up with slows time instead of the frame rate.

Determinism: simulations take a forked `Rng`, advance only by `SIM_DT`, and never read the wall clock or `Math.random()`. The same seed and the same inputs give the same world.

## 6. Village

Code: `src/sim/village/` and `src/sim/nav/`. Facade: `VillageSim` — constructed from a `SimContext` and a `VillagePlan`, advanced by `tick()` once per clock step, exposing `views` (stable `EntityView` objects, mutated in place), `inspect(id)`, a `LivestockApi`, a ledger for the UI and a trade interface for the player.

Residents come from the plan: one per bed. A building with beds is a household; adults take the trade of the building they live in or commute to a workplace that needs hands, and about a fifth are children with no trade. Each resident has a name, an age, needs (hunger, energy, social), a mood derived from them, a purse, and a home larder shared with their household.

Routine: each trade has a daily template (rise, breakfast, commute, work blocks, midday meal, errands, evening, bed) bent by the weekday (fair day, rest day with a chapel service), the weather (outdoor work stops in hard rain or snow; people shelter) and the season (farm work follows the crop calendar; winter is for maintenance and firewood). An activity resolves to a standing cell, a path there, a timed action with an animation and a held item, and an effect.

Work that changes the world: farmers till, sow, tend and harvest real crop blocks on their fields; woodcutters fell real trees through `WorldActions.fellTree` and plant saplings; bakers and smiths light their oven and forge while working; households light lanterns at dusk when someone is home and awake, and put them out at bedtime; the watch lights the street lamps and walks the patrol at night; doors and gates are opened and closed by whoever passes; the shepherd drives the flock to pasture and back. Other trades (miller, brewer and innkeeper, fisher, hunter, weaver, carpenter, miner, smith, storekeeper, priest, reeve) transform goods at their work spots; the fisher and hunter draw on `WildlifeApi`. The hunter hunts with a bow, because the game runs from a person at 7 to 16 blocks: tracks the nearest deer, boar or rabbit (first on the plan's hunting ground, then within 150 blocks), closes to about 18 blocks a leg at a time, shoots when there is a clear line (the odds fall with range and on a moving target), walks to the body and carries the meat and hide home. That comes to two or three kills a week on the default island.

Economy: goods are `ECONOMY_GOODS`. Each business keeps stock and coin and posts prices that rise as its stock falls below target and fall as it piles up. Households buy food, firewood, ale, cloth and tools. Pay is a common purse, not a pure market: each evening workers take 45% of their business's takings above its float, and the rest goes to the village chest, which pays the watch, the priest and the reeve, gives relief, and pays every adult an equal dividend; purses above 100 coins are levied. Plain wages and prices had left the bakers holding most of the coin. Money is conserved: every coin moves between purses, tills and the chest, and the tests hold the total constant to the coin. The player buys and sells at the same prices as anyone, filling from the cheapest sellers; a larger lot costs more each and sells for less (`src/player/trade.ts` moves the player's side).

As built, and weaker than the paragraphs above say: miners work at the mine's faces and yield stone, coal and ore by odds without removing rock; nobody patrols between about half past eleven and three; opening stocks are sized for a spring start, and a village started in winter goes hungry before its first harvest (no test covers that). In the game a woodcutter's tree is removed whole (section 10).

Movement: A* over standable cells (step up or down one, doors and gates passable, cheaper on paths and roads, expensive across crops, no deep water), with a budget per tick and cached routes. A search may spend more the farther apart its ends are (260 expansions a block, never fewer than 14,000), and world generation charges a wood or a hunting ground for its distance from the square: on the generated island the first choice of woods was 180 blocks out and nobody could find the way. A resident that cannot find a path after repeated tries is moved to its destination and the event counted; tests keep that count at zero.

Both simulations are also run together, headless, on the island the game generates (`src/life.test.ts`): two days in which nobody is carried by the stuck-walker fallback or stands inside a block, the woodcutters fell trees, the hunter brings game down, every animal the hunter takes is in the wildlife's own count of the hunted, and no simulation tick takes long enough to drop a frame.

Required tests, headless on a generated fixture village: the plan validates; over 14 simulated days nobody's hunger stays critical, everyone sleeps in their own bed each night, each trade reaches its workplace on work days, money is conserved to the coin, stocks never go negative, prices stay within bounds, bread is baked and eaten; over a simulated year fields are sown and harvested; the same seed reproduces the same state; a simulated day costs little enough for 60x time-lapse.

## 7. Wildlife

Code: `src/sim/eco/`. Facade: `EcoSim` — constructed from a `SimContext` and options (areas wild animals avoid), advanced by `tick()`, exposing `views`, `inspect(id)`, a `WildlifeApi`, and a census with population history for the UI.

Flora: tall grass and flowers spread onto open grass at a rate set by season and moisture, and are eaten by grazers (the plant block is removed), so grazing pressure is visible. Berry bushes ripen in summer and autumn and are stripped by animals and foragers. Saplings grow into trees through `growTree` when they have room and light; mature trees seed saplings nearby, so felled woodland regrows. Mushrooms come up in shaded forest in autumn.

Fauna: deer in herds (crepuscular grazers, forest by day), rabbits around warrens (fast breeders), boar in woodland, foxes (solitary, hunt rabbits and raid chickens at dusk and night), a wolf pack in the remote highland (hunts deer and boar, sometimes sheep at pasture), songbird flocks, crows, gulls over the coast, ducks on fresh water, and fish schools whose visible numbers follow a stock that regrows logistically and is drawn down by fishing. Each animal has energy, hunger, age and a state machine (graze, rest, flee, hunt, court, sleep); it reproduces in season when well fed, and dies of age, hunger, predation or the hunter. Animals keep away from people (`SimContext.people`, the player), shelter from hard rain, and follow day and night habits.

Movement: walkers follow the ground with `standHeight`, stepping one block, steering around obstacles, deep water and avoided areas; fliers are boids with terrain avoidance and perches; swimmers stay in water.

Required tests, headless: a fixture landscape left to itself, with no arrivals from outside, ends with every species present and none above its cap; grazing lowers plant cover and rest restores it; predators reduce prey and starve without it; saplings become trees; the same seed reproduces the same state; a tick stays cheap with a few hundred animals.

How long that stability run is: the gate runs one year on one seed and spring and summer on four more (`soak.test.ts`, `seeds.test.ts`); `ECO_SOAK_YEARS=3` runs three years on five seeds, which passed when last run by hand (2026-11-11) and is not part of the gate because it takes over a minute.

The wildlife's side of hunting: `WildlifeApi.shoot` kills an animal where it stands and leaves the body four minutes for the hunter, and its herd runs from where the arrow came; `harvest` takes the meat and hide of that body, or of a living animal within reach. A sapling becomes a tree only where it has room, light, nobody (animal, villager or player) within seven blocks and nothing built within three; saplings due in the same hour come up one at a time, because a tree is some hundreds of block writes.

As built: movement is local steering, with no route planning, so a walker that cannot reach a goal gives it up. On the generated island that costs the wolves their lives: their den is high on the mountain, they come down to hunt, cannot find the way back, and starve within a year; arrivals from beyond the map replace them, and the stability tests on the fixture do not see it. Food for birds and ducks is a seasonal supply, gulls draw on the sea's fish, and boar root from a woodland "mast" store; the plants that are real blocks are grass, flowers, bushes, mushrooms and saplings. When a species has all but died out a few of its kind arrive from beyond the map (on by default, off in the stability tests). Every plant eaten or sprouted is a block write, a thousand or two a simulated day.

## 8. Physics

Code: `src/physics/`. Facade: `Physics` — constructed from a `World`, stepped in real time, exposing body views for the renderer, spawn and pickup calls, a flow query, an event stream (splash, impact, collapse) for particles, and a ledger of what it conserves (finite water by cause, and the blocks and items it has let go for good) that the soak test audits.

Units are SI and gravity is 9.81 m/s² for everything.

Fluid: finite water with integer levels 1..16. Each tick an active cell first drains into the cell below, then evens out with its four neighbours, moving whole units toward the lower side. Sources (sea, lake, river) never deplete; they spill finite water into open neighbours and swallow water that reaches them. A source does not spill where the water would only run straight back into a source: over a lower reach of the same river, which is how a river's steps and a lake's outfall stay at rest when something beside them is disturbed. A finite cell that is full, sits between two sources and rests on water or solid ground becomes a source, so lakes heal. Thin isolated films evaporate. Water entering a cell washes out plants. Anything else written into a cell of finite water (a block placed, a seed sown, a trunk grown) pushes the water into the cells beside it and then up the column; only what fits nowhere is lost, and it is counted. Only cells that changed, or whose neighbours changed, are simulated; a settled pool costs nothing. Volume is conserved exactly apart from sources, evaporation and that counted loss.

Loose blocks: sand, gravel and snow fall when nothing solid holds them (a torch, a crop or a ladder does not), land where they come to rest, and slump sideways when a pile is steeper than its angle of repose.

Structure: when a block is removed, anything that was resting on it is tested for a path of solid blocks to the ground. Pieces left hanging become rigid bodies: a felled tree topples as one body and sheds its leaves on impact; an undermined wall comes down in chunks. A material's `span` limits how far it can cantilever.

Rigid bodies: dynamic boxes and compounds of boxes with mass from material density, colliding with the voxel world and each other, stacking and sleeping when at rest, floating or sinking by density, pushed by flowing water, breaking apart on hard impacts. Bodies that settle are returned to the grid or become item drops; a budget caps how many are live. Dropped items are small bodies the player picks up by walking near.

Required tests, headless: a closed basin conserves water to the unit and settles; a breach drains until levels meet; a source refills what is dug beside it; sand dropped from height lands and piles into a slope; cutting a trunk drops the tree and nothing else; a cube dropped on flat ground comes to rest on it and sleeps; a stack of five stays standing; wood floats and stone sinks; the same seed and inputs reproduce the same result.

As built: rigid bodies collide with voxel colliders at half-block resolution, one per 8-cubed chunk, present only near bodies; shapes those cannot express (paths, fences, furniture) get exact boxes. A falling loose block is an animation on the grid, not a rigid body, so it passes through bodies and the player. A body that comes to rest square to the grid goes back into it (if the player or an item is in the way, it tries again every second); one that lies crooked stays a sleeping body, which the player can hit to break into its blocks (`pickBody`, `breakBody`; the crosshair passes over dropped items, which are picked up by walking). The player is a pusher, not a collider: walking into rubble shoves it at the player's own speed, taken from how far they moved in the step, whatever the frame rate. Ground, for the structure test, is natural rock and soil all the way down to the world's floor. The cantilever rule applies only to built blocks near a removal, and a piece of more than 4096 cells is assumed held: bringing one down would need a staged collapse. A stream the player builds between two sources keeps flowing and costs about two block writes per cell of stream each fluid tick. In the game physics steps in real time whatever the pace of the calendar, and stops when the world is paused. The library adds 4.4 MB to the download and is loaded as its own chunk while the island generates. Determinism holds on one machine and build; the build of Rapier used is not its cross-platform deterministic one.

## 9. Player and UI

First-person: walk, sprint, jump, swim, climb ladders, fly (F; Space rises and C sinks, and no game key uses Control, because Control with W closes the browser's tab and a page cannot stop it); a box collider against block collision boxes with a half-block step-up. The first left click hands the mouse to the game and does nothing else. After that the left button breaks (time by hardness), the right button places or uses (doors, gates, lanterns, picking berries), and on a villager talks or opens trade. While a panel is open the game's own keys and the wheel do nothing; the keys that open and close panels still do. A broken block drops as an item body where it stood and is picked up by walking within about a metre and a half; what does not fit in the pack is left lying. An item nobody picks up is cleared away after five minutes. The held item is drawn in the hand. A hotbar and inventory of item stacks; a purse of coins.

DOM interface over the canvas (`src/ui/`): crosshair, hotbar, clock and weather readout, the card for the creature under the crosshair with a prompt, speech bubbles, and panels: pack (E), village ledger with price histories (L), wildlife census with population curves (K), almanac with the pace of time, the hour and the weather (T), help (H), and the trade window. `[` and `]` change the pace of time, P pauses, F3 shows the frame and physics readout.

`window.__tidewick` exposes a debug interface (teleport, set time and weather, read metrics) used by the browser gate and for inspection.

## 10. Decisions

- 2026-11-11 — Standalone engine, raw WebGL2, no Three.js. The owner chose standalone over `../voxel` (whose 1.3 scope excludes streaming, dynamic lights, custom passes and shadows) and `../civ-engine` (2D grid), then asked for a clean start unconstrained by fleet habit. A deferred pipeline with packed vertex formats, custom G-buffers and cascades is plainer and faster against the WebGL2 API than through a scene-graph library whose abstractions it would bypass.
- 2026-11-11 — Bounded island held wholly in memory, generated in one worker at load. A village and ecosystem that keep running wherever the player stands need a closed domain; an island makes the boundary natural and puts the sea on every horizon.
- 2026-11-11 — One Uint16 state id per cell with every variant flattened into the id, so each engine question is one array read.
- 2026-11-11 — Baked voxel light supplies ambient-sky visibility and torch light; sun and moon shadows come from shadow maps. The baked channels are cheap, exact at block scale and give dark interiors and caves; shadow maps give crisp moving shadows.
- 2026-11-11 — Natural water bodies are infinite sources; only spilled or added water is finite. A river simulated as finite flow would never settle and would re-mesh its whole length for ever; baked flow on source cells looks and pushes the same and costs nothing.
- 2026-11-11 — One gravity, 9.81 m/s², SI units, for the player and every body, with a jump of about 1.15 m so full blocks are still climbable.
- 2026-11-11 — Rigid bodies use the Rapier physics library (`@dimforge/rapier3d-compat` 0.21), confirmed at integration: stable stacking and compound bodies are where a proven solver beats a hand-rolled one. Its voxel colliders slide a cube across block seams where unit boxes caught, and one collider per chunk keeps an edit from waking every sleeping body. It is the only runtime dependency, 4.4 MB, loaded as its own chunk.
- 2026-11-11 — A woodcutter's tree is removed whole; only a tree the player cuts falls through physics. The village pays the woodcutter in logs for the tree he fells, and a trunk left lying as blocks as well would be the same wood twice. Having the villagers gather landed logs instead is the better end state and is not built.
- 2026-11-11 — Exposure is computed from the light of the hour, not measured from the frame, and aimed at a brightness designed by time of day. A measured exposure would lift night to the brightness of day and would pump with what the camera happens to face.
- 2026-11-11 — The sky is single scattering with a small isotropic term for light scattered more than once, and nothing designed on top. A twilight term was added the same day to stop sunset going dark, and removed hours later when review found the real cause: a ray that misses the planet was being taken for one that hits it, which put most of the atmosphere in shadow whenever the sun was low. A symptom that looks like missing physics is checked against the model's own numbers before anything is painted over it.
- 2026-11-11 — The village and the wildlife run on the main thread, a bounded number of steps a frame. Measured in the game they cost about 0.2 ms a step together with 62 residents and 353 animals; moving them to a worker would buy little and would put the world's arrays behind a message boundary.
- 2026-11-11 — No save files yet. Block state ids are positional in the block table; when saving arrives that order becomes a persistent format and must be versioned.
