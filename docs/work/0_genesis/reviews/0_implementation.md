# Review 0: implementation

## Target

Repository `minecraft`, commit `b00fc32` ("Bring the README, design and devlog up to what is built"), the whole tree: about 35,000 lines of TypeScript and GLSL written in one session, none of it reviewed before. The reviewers read a detached checkout of that commit, separate from the working tree, so later edits could not reach them.

Line numbers in the reports are those of `b00fc32`; the files have moved on since. Recover the reviewed text with `git show b00fc32:<path>`.

## Reviewers and coverage

Run by the fleet's multi-CLI review runbook, from a run folder outside the reviewed tree.

- **Codex, `gpt-6-astra` at `xhigh`, read-only sandbox, two lenses run one after the other.** Lens A: the game loop, the player and the interface, and how they use the simulations (`src/game.ts`, `src/life.ts`, `src/main.ts`, `src/player/`, `src/ui/`, body and particle drawing). Lens B: the renderer, the mesher and world storage (`src/render/` with its shaders, `src/mesh/`, `src/workers/`, `src/world/world.ts`, `light.ts`, `blocks.ts`, `walk.ts`, `raycast.ts`, `attach.ts`). Both logs passed the runbook's check: no failed sandbox commands, 21 and 29 commands run. Every finding cites a file and line; each was checked against the code by the owner, and seven of the fifteen were reproduced by a test that fails on the reviewed code.
- **Claude, `claude-opus-5-5[1m]` at `max`, tools limited to reading.** Asked to cover the whole codebase in six lenses with a subagent each: the village and pathfinding, the wildlife, physics, the contracts and the game's use of them, world and generation and meshing, and rendering. It ran 71 minutes over 166 turns and returned 62 findings, 19 of them major and none critical. The check of its run passed: the model it reported was `claude-opus-5-5[1m]`, its tools were Task, Bash, Glob, Grep and Read, and it made 440 reads, 232 searches and 28 listings itself and through seven subagents. Bash was refused it in practice (its two commands listed the tree and counted lines), so it ran no test and no gate: every finding of its is from reading, and it says so.
- Not covered by either lane in depth: `src/sim/village/`, `src/sim/eco/` and `src/physics/` were in Claude's lenses only. Codex read into them only where the game called them.

The reviewed checkout was unchanged afterwards (`git status --porcelain` empty).

## Reports

Each report is the lane's own text, copied by script. The one change is that absolute paths into the reviewed checkout were turned into links relative to this file.

### Codex (gpt-6-astra, xhigh), lens A: game loop, player, interface

1. **Major — “Next season” kills the wildlife through skipped-time starvation.** [src/ui/hud.ts:264](../../../../src/ui/hud.ts:264) advances the clock directly by seven days. [src/sim/eco/index.ts:150](../../../../src/sim/eco/index.ts:150) adopts that time without resynchronizing animals; [src/sim/eco/brain.ts:52](../../../../src/sim/eco/brain.ts:52) consequently applies seven days of hunger and starvation damage without opportunities to feed. An in-memory reproduction using the existing wildlife fixture killed all 158 non-fish animals after this jump.

2. **Major — Structural collapse duplicates attached doors.** [src/game.ts:126](../../../../src/game.ts:126) installs attachment removal with item drops. Meanwhile, [src/physics/structure.ts:266](../../../../src/physics/structure.ts:266) removes a previously collected body’s cells individually. Removing its floor synchronously detaches and drops a door through [src/world/attach.ts:48](../../../../src/world/attach.ts:48), but the saved door cells remain in the body subsequently handed to physics. A platform-collapse reproduction produced one door item **and** both door halves in the rubble, allowing the same door to be recovered twice.

3. **Major — Breaking and using a block in one frame can duplicate it.** [src/player/interaction.ts:61](../../../../src/player/interaction.ts:61) breaks the target, then [src/player/interaction.ts:75](../../../../src/player/interaction.ts:75) can use the same stale hit when right-click arrives that frame. For a door, `useBlock` writes the old door state back with its open bit toggled at [src/player/interaction.ts:123](../../../../src/player/interaction.ts:123), after the original already yielded an item. Reproduced: one door yielded two door drops after breaking the recreated lower half.

4. **Minor — Harvesting berries silently destroys inventory overflow.** [src/player/interaction.ts:139](../../../../src/player/interaction.ts:139) ignores `Inventory.add`’s remainder and immediately changes the ripe bush to its harvested state. The breaking path makes the same mistake at [src/player/interaction.ts:95](../../../../src/player/interaction.ts:95). With a full pack, the reproduction changed a ripe bush to unripe while awarding zero berries and creating no berry drops. Partial capacity likewise loses the excess.

5. **Minor — Right-click uses the previous frame’s creature target.** Player movement and mouse look run at [src/game.ts:367](../../../../src/game.ts:367), and interaction calls `greet()` at [src/game.ts:382](../../../../src/game.ts:382), before focus is recalculated at [src/game.ts:423](../../../../src/game.ts:423). Turning and clicking between frames can therefore open trade with the villager previously under the crosshair, consuming a click intended for another target. An in-memory update reproduced a trade opening despite the updated viewing ray hitting no creature.

6. **Minor — Children’s picking boxes are scaled down twice.** [src/player/pick.ts:8](../../../../src/player/pick.ts:8) assigns children an already reduced height of `1.15`, then multiplies it by `v.scale` at line 28. [src/sim/village/populate.ts:146](../../../../src/sim/village/populate.ts:146) already supplies the child-size scale, while [src/render/entities/models.ts:151](../../../../src/render/entities/models.ts:151) retains adult body dimensions and enlarges the head before rendering applies that scale. At scale `0.68`, the head centre is approximately `1.026 m` above the feet, but the picking box ends at `0.782 m`. A ray through the visible head returns no target, preventing inspection or conversation there.

7. **Minor — The browser assertion for rendered creatures passes without drawing creatures.** [tests/browser/smoke.spec.ts:341](../../../../tests/browser/smoke.spec.ts:341) returns `entities.count`, and line 353 treats a count above 60 as evidence that people appear in the street. That count measures boxes assembled on the CPU, including off-screen entities, bodies and particles. It does not depend on the rendering call at [src/render/renderer.ts:418](../../../../src/render/renderer.ts:418). Removing creature drawing would leave this assertion—and the separate simulation movement assertions—passing.

No additional findings in the reviewed `src/life.ts`, `src/main.ts`, `src/player/{input,player,collide,inventory,trade}.ts`, player tests, `src/ui/{panels,icons}.ts`, `src/render/{bodies,held,impacts,particles}.ts`, remaining entity-rendering code, `src/sim/api.ts`, or village trade/economy code. No externally sourced, unescaped HTML injection path found in `src/ui/hud.ts` or `src/ui/panels.ts`.

### Codex (gpt-6-astra, xhigh), lens B: renderer, mesher, world storage

1. **Major — Removing a brighter emitter extinguishes surviving weaker emitters.** [light.ts:244](../../../../src/world/light.ts:244) clears neighboring light whenever its level is lower, including cells containing independent emitters. Only the edited cell’s emission is restored at [light.ts:210](../../../../src/world/light.ts:210). A read-only reproduction placed an emitting campfire beside a torch, then removed the campfire: the surviving torch’s block light became **0**, whereas full recomputation restored **14**. This affects ordinary edits through the light listener installed at [game.ts:184](../../../../src/game.ts:184).

2. **Major — Missing `sampler2D` precision can corrupt depth reconstruction and HDR rendering.** The shared header at [gl.ts:32](../../../../src/render/gl.ts:32) declares several sampler types as `highp` but omits `sampler2D`. Consequently, depth at [lighting.ts:98](../../../../src/render/shaders/lighting.ts:98) and HDR inputs at [post.ts:145](../../../../src/render/shaders/post.ts:145) inherit `lowp`. On implementations that do not promote this precision, sampled depth can lose the precision needed for world-position reconstruction or round to the sky cutoff; HDR values also lose their required precision and range. Float precision declarations do not override sampler precision. [GLSL ES 3.00, §§4.5.4 and 8](https://registry.khronos.org/OpenGL/specs/es/3.0/GLSL_ES_Specification_3.00.pdf)

3. **Major — Atmospheric calculations classify rays missing the planet as planet-shadowed.** The intersection helper returns a positive first component for a miss at [atmosphere.ts:48](../../../../src/render/atmosphere.ts:48), but the scattering calculation interprets any positive first component as occlusion at [atmosphere.ts:94](../../../../src/render/atmosphere.ts:94). The CPU implementation repeats this mistake at [atmosphere.ts:180](../../../../src/render/atmosphere.ts:180) and line 209. A normalized sun direction with `y = 0.005`, still above the horizon, returns zero RGB transmittance. This incorrectly cuts direct illumination and atmospheric scattering near sunrise and sunset.

4. **Major — Transparent faces write depth without being sorted within a section.** [renderer.ts:468](../../../../src/render/renderer.ts:468) enables depth writes during alpha blending. Reversing the section list does not sort its faces: [sectionStore.ts:155](../../../../src/render/sectionStore.ts:155) draws each complete translucent run, emitted in coordinate order at [mesher.ts:272](../../../../src/mesh/mesher.ts:272). Meshing two windows at `x=10` and `x=14` in one section emitted the nearer window first when viewed from smaller x. Its partially transparent pane writes depth and rejects the farther window entirely, making windows behind glass disappear depending on viewing direction.

5. **Major — Weather motion accelerates with session duration.** Cloud displacement uses **current wind × total elapsed time** at [clouds.ts:69](../../../../src/render/shaders/clouds.ts:69), although wind continually changes at [weather.ts:206](../../../../src/sim/weather.ts:206). Every wind change therefore retroactively changes the entire accumulated displacement. In a deterministic one-hour simulation held in fair weather, wind around **3.82 m/s** produced a cloud sampling displacement change equivalent to approximately **747 m/s**. Clouds and their shadows increasingly jump or reverse during longer sessions. Precipitation repeats the same calculation at [precip.ts:41](../../../../src/render/shaders/precip.ts:41), causing particle jumps as wind changes.

6. **Minor — Translucent blocks at the world ceiling lose incoming skylight.** Sky seeding starts above the column’s highest block at [light.ts:153](../../../../src/world/light.ts:153); when that block occupies the top layer, the seed range is empty. Incremental repair handles the ceiling only for zero-opacity blocks at [light.ts:205](../../../../src/world/light.ts:205), excluding leaves and water. A read-only reproduction with a 32×32 leaf canopy in a 128-block-high world measured skylight **14** in the canopy and **13** underneath at `y=126`, but **0** at both locations when moved to `y=127`. Building a translucent roof against the ceiling therefore incorrectly darkens its interior.

7. **Minor — Reversed `smoothstep` edges make clouds, ambient occlusion and stars implementation-dependent.** Calls at [clouds.ts:72](../../../../src/render/shaders/clouds.ts:72), [post.ts:52](../../../../src/render/shaders/post.ts:52), and [lighting.ts:127](../../../../src/render/shaders/lighting.ts:127) pass the larger edge first. GLSL defines this case as undefined, rather than a supported descending interpolation. These paths execute during normal rendering, so another GPU/compiler can distort or remove these effects. [GLSL ES 3.00, §8.3](https://registry.khronos.org/OpenGL/specs/es/3.0/GLSL_ES_Specification_3.00.pdf)

8. **Minor — Rain ripples feed negative bases to `pow`.** At [water.ts:187](../../../../src/render/shaders/water.ts:187), `pow((r - life * 0.42) * 9.0, 2.0)` receives a negative base inside an expanding rain ring. GLSL leaves this undefined even with exponent `2.0`; implementations can produce NaNs, which propagate into the water normal at line 190 and subsequent lighting. This creates a portability risk of invalid or flashing water pixels during rain. [GLSL ES 3.00, §8.2](https://registry.khronos.org/OpenGL/specs/es/3.0/GLSL_ES_Specification_3.00.pdf)

No additional findings in the reviewed `src/render/{targets.ts,postChain.ts,geometry.ts,frame.ts,shadows.ts,meshPool.ts,environment.ts,mat4.ts,bodies.ts,held.ts,particles.ts,impacts.ts}`, `src/render/entities/{renderer.ts,pose.ts}`, `src/render/tiles/index.ts`, `src/render/shaders/{common.ts,chunk.ts,volumetric.ts,entity.ts,overlay.ts}`, `src/mesh/{extract.ts,job.ts,mesher.test.ts}`, `src/workers/{gen.worker.ts,mesh.worker.ts}`, `src/world/{world.ts,blocks.ts,walk.ts,raycast.ts,attach.ts,world.test.ts}`, or `src/core/events.ts`.

### Claude (claude-opus-5-5[1m], max), whole codebase in six lenses

# Review of Tidewick at commit b00fc32

19 major and 43 minor findings; none critical. Bash was denied in this session, for me and for the seven read-only subagents, so no gate, test or rendered frame was run. Every finding below comes from reading the code, and I re-traced each against the lines cited. Subagent findings I could not confirm, or that needed implausible conditions, were dropped. One was corrected: the night-watch loop lasts three hours each evening, not until sunrise. The visual findings still need a capture to confirm.

The headless layers contain no `Math.random`, `Date.now` or `performance.now`; the injected clocks feed only timing stats.

## 1. Village simulation and pathfinding (`src/sim/village`, `src/sim/nav`)

**Major**

1. **A woodcutter's fell takes neighbouring trees and leaves floating leaves.** `src/sim/api.ts:131-149`, also used by the game at `src/game.ts:145-155`.
   - **Neighbour trunks go too.** The flood follows logs through all 26 neighbours at any distance, and leaves within Manhattan 4 of the cut column. A neighbour's leaf next to its own trunk falls inside that zone whenever two crowns touch, so the neighbour's whole trunk is removed while its outer leaves stay.
   - **Touching crowns are normal.** Generation plants on a jittered 4-cell grid at 62% density in forest (`src/world/gen/fill.ts:188-203`).
   - **Even a lone tree leaves leaves behind.** Pines' lowest skirt and big oaks' limb tufts reach Manhattan 5 (`src/world/gen/trees.ts:68-69, 84-89`).
   - **Nothing ever clears them.** No code decays leaves, and structure checks ignore them (`src/physics/structure.ts:68-70`).
   - **Effects** (`src/sim/village/outdoor.ts:210-226`): the woodcutter is paid for every log taken, one sapling is planted per fell, and a co-felled tree is later dropped with no sapling. The forest thins faster than it is replanted.
   - **Tests miss it:** fixture trees stand 5–9 apart, and the soak checks only `saplingsPlanted === treesFelled`.

2. **The player's log builds in the village forest get felled.** `src/sim/village/outdoor.ts:58-85`.
   - `Woods.scan` treats any column in `plan.forest` as a tree if it has two upright logs on non-log ground and only logs, leaves or air above.
   - A player's log wall or pillar qualifies. The starter kit has 32 logs (`src/player/inventory.ts:81`); only a non-log roof hides the build.
   - The fell then removes up to 600 connected logs.

3. **One missing street-lamp lantern makes the watch shuttle for three hours every evening.** `src/sim/village/watch.ts:126-134, 176-184`, `src/sim/village/core.ts:258-268`, `src/sim/village/routine.ts:221-222, 234`.
   - **Why it loops:**
     - On a cell with no lantern, `setLit` does nothing, but `lampRound` still marks the lamp lit in memory.
     - The next `think()` sees nothing pending and sends the guard to the nearest patrol post.
     - The per-second `sweep` re-reads the block as unlit, and on arrival `GOAL_LAMPS` (which outranks patrol and meals) sends the guard straight back.
   - **How long:** it runs until the 3-hour grace (`LAMP_GRACE`) has passed since the lamps were due, after which `sweep` writes `lamp.lit = wanted` every second. That is about sunset − 1.25 h to sunset + 1.75 h, every night, after the player breaks one lantern or its post.
   - **Other guards:** they find the lamp "taken" and stand at the guardhouse instead of eating supper or patrolling.
   - A lamp whose stand cannot be reached has the same effect over the same window.

4. **A hungry adult who cannot afford the chosen seller's food loops at the counter and blocks it.** `src/sim/village/meals.ts:89-92`, `src/sim/village/errands.ts:69-106, 153-191`, `src/sim/village/economy.ts:185-187`.
   - **Mechanism:**
     - `hungryWithNothing` falls back to alms or foraging only when `shop()` returns false.
     - `shop()` returns true as soon as `pickSeller` picks someone, and `pickSeller` never checks affordability.
     - `retryAt` is never set on this path.
   - **Trigger:** 0 < coin < one unit at that seller (bread starts at about 6.9, and an empty larder favours the bakery). Each lap is a 4 s "talk", `buy` gets nothing, then the same seller again.
   - **Knock-on:** the completion callback releases the customer cell, and `think()` re-holds it in the same `tickResident` call (`agent.ts:329-334` → `errands.ts:180-181`). Other customers wait for ever, and their `GOAL_SHOP` outranks work (`routine.ts:160` vs `:174`).
   - **How long:** the meal window, or, when hunger is urgent, until bedtime or the 18:00 relief payment; the free alms meal is never reached. How often this happens was not measured.

5. **The soak's "each trade reaches its workplace" check passes for live-in workers who never leave bed.** `src/sim/village/soak.test.ts:73-79, 132-136, 334-345`.
   - `atWork` accepts any sample inside the job building, counted from 04:00.
   - Adults take their home building's trade first (`populate.ts:188-191`), and every fixture workplace has beds (`fixture.ts:24-41`).
   - So a farmer who never reaches a field passes on the strength of being asleep at 04:00. Only the commuters are really tested.

**Minor**

6. **The player can sell goods for 0 coins.**
   - `bid` floors the offer and does not refuse zero (`economy.ts:392-395`), and `trade.ts:82-85` refuses only null.
   - The window shows "0" with Sell enabled (`src/ui/panels.ts:115-116`).
   - At opening stocks every bid for one firewood (0.56–0.70) or one stone (0.83–0.89) floors to 0.
   - The test asserts only `offer >= 0` (`village.test.ts:135`).

7. **The spec's pricing claims are false.**
   - **Lot price:** each seller's chunk is rounded up with a minimum of 1 (`economy.ts:352-353`), and bids are rounded down (`:392-393`). For cheap goods a larger lot is therefore cheaper per unit, not dearer. Stone at opening: 1 costs 2 and 5 cost 7; selling 1 earns 0, selling 5 earns 4.
   - **"Same prices as anyone":** villagers pay `round(price × n)` (`economy.ts:105, 188`). The player pays a rounded-up price set from the post-sale stock, and is paid 70% of the posted price, floored.
   - Spec §6 and the trade window (`panels.ts:121`) say otherwise.

8. **Farmers skip meals because two tasks share `retryAt`.** Gathering firewood sets it 2 game hours ahead (`fields.ts:311, 334`). The same field gates buying food (`meals.ts:89`), so in that window the meal is skipped or taken as alms.

9. **A tavern drinker's mug count is read as a shop id.** `tavernEvening` keeps its mug count in `r.targetId` (`pastimes.ts:101-110`). When it runs as the fallback of `GOAL_SHOP` (`routine.ts:279-283`), the next `think` keeps `GOAL_SHOP` (`:160`), and `shop()` looks up business 2 or 1 (`errands.ts:157`).

10. **The patrol gap is wider than the spec says.** The first watch stops patrolling at 22.65 h (`routine.ts:234`, `watch.ts:21`), so nobody patrols from about 22:40 to 03:00, not from "half past eleven".

11. **The teleport counter misses relocations.**
    - A firm `go` with nothing standable within 2 returns "arrived", and `lieDown` or `sit` then moves the body onto the bed or stool from wherever it is (`agent.ts:44-51, 230-271`).
    - `seek` silently snaps a resident up to 2 cells (`:125-136`).
    - `stats.teleports` (`:184`), which the soak and browser gate hold at 0, counts only the 3-try fallback.

12. **Cached step costs go stale.** `WALK_SIGNATURE` treats path and farmland alike (39) and air and shallow water alike (0), though their walk costs differ (`navigator.ts:60-69, 315`). Such edits invalidate neither the walk grid nor cached routes.

13. **Several coin checks cannot fail.**
    - `ledger.coin` is defined as purses + tills + treasury (`economy.ts:460`). `soak.test.ts:384`, `village.test.ts:102` and `robust.test.ts:101, 151` assert exactly that, so the "walled shut" and "lone house" tests check no conservation.
    - Alms meals count toward `meals` and `breadEaten` (`needs.ts:142-146`), so the hunger and "bread eaten" assertions can be met without any trade.

14. **The village the player sees is never simulated headless.** No test builds a `VillageSim` from `buildVillage`'s plan. Only the 48-resident fixture and the small hamlets in `robust.test.ts` are run.

I found no path that creates or destroys coin. Balances change only in `Economy.pay` (whole coins, no overdraft, `economy.ts:96-101`) and in the two player paths (`:374-375, 410`).

## 2. Wildlife (`src/sim/eco`)

**Major**

1. **Rabbits in their burrows are never hidden.**
   - `src/sim/eco/grazers.ts:45-51` sets only `ST_HIDE`, and no file anywhere assigns `hidden`.
   - So `life.ts:56-57` draws them, piled on 9 seats 0.3 apart for up to 12 rabbits (`grazers.ts:38-43`), and the inspector says "Down its burrow".
   - `findAnimal` passes `notState = -1` (`eco/index.ts:130`) and `harvest` has no state check (`:132-139`). The village hunter (`outdoor.ts:28, 348-354`) therefore shoots rabbits sitting still in the warren.
   - `api.test.ts` compares against a brute-force list that also includes hidden rabbits, so it cannot see this.

2. **Saplings grow into trees through the player, villagers and walls.**
   - **No check for people:** growth waits only for wild animals within 4 (`flora.ts:95, 378`); the player and villagers are never checked.
   - **Only the trunk is checked:** `canPlaceTree` looks at trunk cells (`trees.ts:100-112`), and leaves fill every dry replaceable cell in the crown, walls or not (`:127-131`).
   - **Player-planted saplings count:** `visit` registers any sapling standing in the open, including ones the player plants from leaf drops (`interaction.ts:96-98`).
   - **The building check is skipped for them:** the "nothing built within 3" rule (`flora.ts:327-346`) applies only to natural seeding (`:315`).
   - **Result:** a sapling planted beside a house fills its rooms with leaves, and a tree can grow round a standing person.

3. **The spec's required three-year soak is not in the gate.**
   - `soak.test.ts:9` defaults `ECO_SOAK_YEARS` to 1, and `npm test` is plain `vitest run` (`package.json:21`).
   - Spec §7 lists three years as required, and the devlog says "proven stable for three years".

**Minor**

4. **Fox and wolf raids query livestock of any kind.**
   - `fox.ts:196-197` and `wolf.ts:183-184` call `findLivestock` without the `kinds` filter the contract provides (`api.ts:84-85`).
   - So a nearer sheep or cow makes the fox give up hens for 240 s (`fox.ts:206`).
   - The test fake holds a single animal (`behaviour.test.ts:392-403`).

5. **`killLivestock` never marks the view dead** (`livestock.ts:65-78`), while the eco checks `anim === 'dead'` (`fox.ts:315`, `wolf.ts:82`).
   - A second fox chasing a hen that is already gone still "kills" it, counts a raid and eats (`fox.ts:323-334`).
   - Every real kill also shows feathers twice (`fox.ts:325`, `livestock.ts:77`).

6. **The spatial hash files moving animals one column late.** `hash.moved(a)` runs before `a.x` and `a.z` change (`motion.ts:230/232, 286/293, 340/342, 396/398`; `spatial.ts:55-60`). An animal that stops just past a 16-block boundary is missed by queries whose box excludes its old cell.

7. **Paddling ducks take off for no reason.** `perchFloor` is set only on landing (`birds.ts:124`), and `movePaddler` changes column without refreshing it (`motion.ts:392-396`). The "branch cut" test (`birds.ts:152-155`) then fires on lily pads, under overhanging crowns and at river steps.

## 3. Physics (`src/physics`)

**Major**

1. **Finite water is destroyed uncounted when anything is placed into it.**
   - `src/physics/index.ts:249-258` only wakes the fluid. Finite water is replaceable (`src/world/blocks.ts:396-399`).
   - So the player's `place` (`src/player/interaction.ts:152-161, 202`) deletes up to 16 units per block, and so do villager sowing (`fields.ts:243-244`) and sapling trunks (`trees.ts:109, 133`).
   - `Fluid.displace` exists for this, but only loose landings and settling bodies call it.
   - `addWater` into a source returns the units as fitted but never counts them as absorbed (`fluid.ts:132`).
   - This contradicts `fluid.ts:9-10`, spec §8 and the README's "conserves its volume".

2. **A river step, once disturbed, churns water for ever.**
   - **Geometry:** generation lowers the river surface in whole-block steps (`terrain.ts:201-202`; `fill.ts:79-83`). At each step the upper reach's top source at (A, L) has open air at (B, L) downstream.
   - **The cycle, once woken:**
     - `source()` gives B 4 units a tick (`fluid.ts:392-403`).
     - B is never swallowed, because a source is beside it (`:278-284`), and it passes water on to C, which swallows it.
     - Every `setLevel` re-adds A through `addAround` (`cellset.ts:77`), so the system never settles.
   - **Cost:** about four world writes per disturbed step every 1/6 s, each remeshing a section, rerunning light repair and dirtying the rain heightmap.
   - **Trigger:** any edit beside the upper reach at a step, such as a dam, a bridge or digging the bank. There is one step per block of descent, up to about 20.
   - Contradicts spec §8 ("a settled pool costs nothing") and the rationale in §10. No test uses a generated river.

3. **The player's shove on rubble is only right at 60 fps.**
   - `Pusher.set` stores the displacement since the last frame (`pusher.ts:44-58`). `apply` divides it by the 1/60 s substep, and only on the first substep after a report (`:71-73`). The game calls `set` once per frame (`game.ts:394`).
   - At 144 Hz the shove is about 0.41 of walking speed, so rubble moves at about 2.4 m/s against the player's 4.3 m/s and the player walks through it. At 30 fps the shove is about twice too strong.
   - The only test steps exactly 1/60 s (`rigid.test.ts:226-233`).

4. **The physics soak checks none of the physics conservation invariants.** `soak.test.ts:48-56, 86-111` asserts finiteness, bounds, budgets and rest, but no water, block or item totals. Its own random digging (`:64`) can delete finite water and still pass.

**Minor**

5. **Any second course resets the cantilever span.** `reach(j, n === 2 ? 0 : d + 1)` (`cantilever.ts:121`) gives anything resting on a block distance 0. A two-layer beam therefore never exceeds distance 2; the test uses a one-course beam (`structure.test.ts:217`).

6. **"Ground" is a guess with visible holes.**
   - Any natural block with three natural blocks beneath counts as ground (`structure.ts:24, 73-82`), so a floating four-high stack of placed dirt holds a structure up.
   - Pieces over 4096 cells are assumed held (`:245-248`).

7. **Sand and gravel rest on torches, crops and ladders.** "Can fall through" means replaceable (`loose.ts:153, 208-213`), and those fittings are not.

8. **A body refused once at settle time never returns to the grid.** `snapRefused` (`rigid.ts:266-268`) clears only on waking (`:398-401`), so rubble that settled square while the player or an item was in a target cell (`settle.ts:52, 66-70`) stays a body.

## 4. Contracts, game loop, player and UI

**Major**

1. **Descending while flying forward closes the tab.**
   - Ctrl descends (`src/player/player.ts:133`), so Ctrl+W is the natural "down and forward". Chrome and Edge reserve it, and a page cannot prevent it outside keyboard-locked fullscreen.
   - `input.ts:26` prevents only Space, Tab and the arrows, there is no `beforeunload` guard, and there are no saves, so the session is lost.
   - Ctrl+S and Ctrl+D open browser dialogs the same way.
   - The help panel (`hud.ts:276-280`) does not mention the binding.

2. **The browser gate's "creatures are drawn" check cannot fail.**
   - `smoke.spec.ts:353` asserts `entities.count > 60`, but `count` is every box queued (`render/entities/renderer.ts:84-97`).
   - That includes every creature within 260 m with no view test (`game.ts:458-460`), plus bodies, particles and the hand, so it passes regardless of what reaches the screen.
   - The same spec has other hollow checks:
     - the "day comes back" test never returns to day (`:85-103`);
     - `focusPrompt` is collected but never asserted (`:342`);
     - page errors are asserted in only 3 of 7 tests.

**Minor**

3. **Dropped items vanish after 300 s.** The default `itemLifetime` is not overridden (`rigid.ts:96`, `items.ts:94-104`, `game.ts:185`). This covers trade overflow (`game.ts:161-163`) and full-pack throw-backs (`game.ts:402`), contradicting spec §9's "left lying". Berries picked into a full pack are discarded outright (`interaction.ts:95, 139`).

4. **Turning the clock back from the almanac stalls weather and wildlife.**
   - `setHour` can move time back almost a day (`game.ts:267-269`).
   - The weather's `nextChange` and `nextStrike` are absolute (`weather.ts:160, 189-192, 230`), so the regime and lightning freeze until the clock catches up.
   - Wildlife timers such as burrow `until` and carcass `removeAt` are absolute too (`grazers.ts:75-80`, `eco/index.ts:285-286`).
   - Only the village resyncs (`village/index.ts:86, 151-176`).

5. **Input problems:**
   - The click that takes pointer lock, and left-drag looking without lock, also hold "break" (`game.ts:171-173`, `input.ts:34-39`), so a plant at the crosshair breaks in 0.05 s.
   - `hit()` ignores `enabled`, so with a panel open F toggles flight and 1–9 change the slot (`input.ts:77-79`, `player.ts:80`, `interaction.ts:83`).
   - Ten or more wheel notches in one frame make the slot index negative (`interaction.ts:85`), and then nothing can be placed.
   - F3 is not prevented, so it may also open the browser's find bar (medium confidence).

6. **An item lying on the aimed block blocks it.** `pickBody` hits item colliders and shortens the block ray (`physics/index.ts:226-233`, `game.ts:372-383`), while `breakBody` refuses items (`:242`). An item 1.45–5.2 m away on that block stops breaking, placing and using it.

7. **Panel clicks can be lost.** Open panels other than pack and help are rebuilt with `innerHTML` every 0.5 s (`hud.ts:150-154`). A press and release that straddle a rebuild find no `data-act` (`:95-98`). By timing that is roughly one click in four or five in trade and almanac; how the browser dispatches such a click was not verified.

8. **Per-frame costs:**
   - The status line is rewritten every frame (`hud.ts:120`), and the inspector card is rebuilt every frame while a creature is in focus (`:182-185`).
   - The HUD then reads `clientWidth` and `clientHeight` after those writes (`:198-199`), forcing a layout each frame.
   - Any world edit re-uploads the full 768×768 rain heightmap every 16 frames (`game.ts:131-133`, `renderer.ts:336-342`), which is permanent because the simulations always edit.

9. **`validateVillagePlan` misses things the simulation trusts** (`api.ts:296-359`). It does not check:
   - that a pen's gate is a gate block;
   - work-spot blocks, though `core.ts:160-165` uses `counter.block`;
   - that a storage chest exists;
   - which half of the bed `bed.block` is, or whether it is next to its stand (`agent.ts:260-270`);
   - field orientation: with `z0 > z1` the check loop does nothing (`:333-342`), and `populate.ts:29-37` then builds arrays of negative length;
   - that a field's owner is a farm.

10. **Layering:** `src/ui/hud.ts:6` and `src/ui/panels.ts:5` import `Game` from the top layer (type-only). No lint rule enforces the layer order (`eslint.config.js`).

11. **Doc claims that are not true:**
    - Spec §2 says the player runs at 60 Hz; it runs at 120 Hz (`player.ts:21`).
    - README says `?size=256` is "quarter-size"; it is a third of the 768 width (`terrain.ts:18`).
    - README says known rough edges are "at the end of the work plan"; the plan's last section reads "Pending" (`plan.md:47-49`).
    - `api.ts:93-95` says the game replaces `fellTree` "with a physical collapse"; `game.ts:145-155` removes the tree whole.

Checked with no defect found: wildlife reads `ctx.livestock` at think time (`fox.ts:194`), so `life.ts`'s construction order is safe. The 40-step cap discards excess time rather than bursting later (`game.ts:354-359`). Every value interpolated into HTML in `hud.ts` and `panels.ts` is escaped or numeric.

## 5. World, light, generation, meshing, workers

**Major**

1. **On every seed the river cuts an air trench through the lake.**
   - **Mechanism:**
     - The first river point (`terrain.ts:194`, s = 0.5 × lakeRadius) always lies inside the lake, because the lake radius is at least 0.78 × lakeRadius.
     - `at()` reads the already-carved floor (`:110, 166-169`), so `level` drops at once to about lakeLevel − 7 (`:202`) and never recovers.
     - The skip at `:218` needs `level === lakeLevel`, so it never fires.
   - **Result:** river cells in the lake hold water only up to about lakeLevel − 7 (`:219-223`, `fill.ts:79-83`). That leaves a channel about 3–4 wide with about 7 blocks of air between standing walls of lake water, from mid-lake to the rim, which the bank code also lowers (`:226-227`).
   - **Missed by the test:** `island.test.ts:59-71`, titled "never ... hanging beside open air", checks only the cell below each water cell.

2. **On other seeds, later village stages wreck lots that had to shift.** A lot that fails its terrain check moves ±3 or ±6 along the road (`world/gen/village/index.ts:140`), but later stages ignore built lots:
   - **Lamps:** `lamp()` checks only that the cell above is air (`:214-222`). Its sites coincide with the doorsteps of the hall, chapel or bakery shifted +6, the weaver or west house shifted −6, the mine or north house shifted +3, and the south house shifted −3. Two fence posts then block the door.
   - **Fields:** `level()` clears 16 blocks above a farm lot shifted +6 (`:284-289`).
   - **Pen lane:** it cuts a shifted shepherd's cottage or house (`:301-305`).
   - **Not caught:** the game never validates the plan (`gen.worker.ts:25-30`, `game.ts:119`), the only validating test uses the default seed (`village.test.ts:10`), and the README offers `?seed=7`.

3. **Fields fall back to the wrong owner when a farm doesn't fit.**
   - `idOf('farm', 1)` falls back to `buildings[0]`, normally the tavern (`index.ts:187, 293`). With one farm, fields 1 and 3 become the tavern's: it gets their crop stock and target and never works them (`populate.ts:27-46`).
   - Validation only checks that the owner id exists (`api.ts:332`).
   - On the default seed one 3-bed lot fails (65 beds in the slots against 62 residents in the devlog). It is a house, a farm or the mine; nothing shows which.

**Minor**

4. **Closed gates are standable on top.** As SHAPE_BOXES they get the default walk cost of 1.3 (`blocks.ts:223, 496-499`), with a top height of 1.0. `standHeight` therefore accepts the cell above (`walk.ts:42-45`), and wild animals step over closed gates (`eco/motion.ts:55-63`), against `walk.ts:12`. Standing lanterns and campfires are standable the same way.

5. **Wall faces beside slabs, stairs and paths render dark.** `shadeFace` averages in the light of the cell the face looks into (`mesher.ts:185, 199-207`), and a light-tight partial block always holds 0 there (`light.ts:275`).

6. **Light repair runs on every edit** (`light.ts:72-74, 187-218`): crop stages, doors, farmland wetting, every finite-water change. It never checks whether opacity or emission changed.

7. **The light property test misses source removal and the top layer.** Its 600 edits stay within y 14–39 of 64 (`world.test.ts:173-176`). The roughly 120 emitters it places are almost never overwritten, and the single torch-removal test asserts one cell (`:155-156`).

8. **The generated-village tests are weaker than their names.**
   - They cover one seed and one size.
   - The reachability flood allows a 1.01 step with no headroom check (`village.test.ts:44-58`), whereas A* requires headroom and has its own step limit, with `isClear` duplicating `passable()` without walk options (`nav/astar.ts:20, 183-214`; `nav/cells.ts:69-72`). "Reachable on foot" therefore does not mean routable.
   - "Keeps trees out of the streets" checks only building footprints (`:83-96`).

9. **A failed mesh worker hangs the loading screen.** Mesh workers have no `onerror` (`render/meshPool.ts:32-37`). A worker that fails to load or throws strands its section, and `Game.create` waits for `pending === 0` for ever, with no message (`game.ts:189-197`).

10. **Layering:** `src/world/gen` imports types from `src/sim/api` (`island.ts:5`; `village/index.ts:8`, `buildings.ts:12`, `frame.ts:6`), against "a layer imports only from layers before it". The contract's home in `sim/api.ts`, which itself imports `world`, forces this.

11. **Doc claims that are not true:**
    - Spec §3's low step "(slab, stair, path)": in the code a low step has top ≤ 0.5 (`walk.ts:37`), so stairs and paths are not low steps.
    - "A one-state section stores no array": `world.ts:138-143` allocates an array on the first `set` and never collapses it back.
    - `src/world/tiles.ts:4` names `src/render/textures.ts`, which does not exist.

## 6. Rendering (`src/render`)

**Major**

1. **Wind-driven animation multiplies elapsed time by the current wind.**
   - **Where:** the gust phase (`renderer.ts:313`), cloud drift (`shaders/clouds.ts:69`), rain and snow (`shaders/precip.ts:41-43`) and water (`shaders/water.ts:102, 172`).
   - **Why it goes wrong:** the wind eases continuously (`weather.ts:206-210`). Each change therefore shifts the pattern by elapsed time × the change, instead of advancing it by the integral.
   - **Size:** after 10 minutes at a typical 0.1 m/s² of wind change, clouds and their shadows slide on the order of 100 m/s, rain and snow streak sideways, and foliage flickers. The error grows with session length and with time-lapse.
   - **Seams:** `water.ts:172` also pulls adjacent river cells with different flow directions apart in pattern space.

2. **The lighting pass uses the relief-carrying G-buffer normal as the surface normal.**
   - `shaders/chunk.ts:129-141` tilts the normal by the tile relief within 40 m.
   - `lighting.ts:181` decodes that normal and uses it for the shadow normal offset (`:16-20` via `:214`), puddle flatness (`:194, 200`), snow (`:204`) and the caustic mask (`:225`).
   - This breaks the AGENTS.md invariant and spec §4 step 5.

**Minor**

3. **Wet/dry flips per pixel on walls (medium confidence).** The rain-heightmap lookup is NEAREST at the unbiased reconstructed position (`lighting.ts:164, 191-192`; `renderer.ts:215-218`). On vertical faces, depth error flips the sample between columns, so wetness and snow flip from pixel to pixel.

4. **Bloom is thresholded before exposure.** The threshold applies to raw HDR (`post.ts:115-117`), while exposure is applied only at `:174`.
   - By day, sunlit ground (about 2.5 with `SUN_INTENSITY` 22) feeds the glow.
   - On dark nights, flames (about 0.3 after `preExposure`, `environment.ts:159-165`) never reach the threshold.

5. **Glass ignores key and cloud shadows** (`water.ts:149`).

6. **Rain rings on water ignore the rain heightmap** (`water.ts:179`), so they appear under roofs and bridges.

7. **Light shafts march through water.** They use `gbuffer.depth`, which has no water (`renderer.ts:529, 537`).

8. **Children's sit and sleep poses use adult metres** (`pose.ts:91, 96-97`), added unscaled (`entities/renderer.ts:177-179`).

9. **Cascade texel snapping breaks during the sprint FOV ramp** (`shadows.ts:79-86, 105`; `game.ts:432`).

10. **Per-frame waste:**
    - Two sky-dome integrations run every frame, allocating tuples at every step (`environment.ts:109-110`; `atmosphere.ts:145-241`).
    - With zero boxes queued, `bufferSubData` with length 0 uploads the whole 393 KB instance array (`entities/renderer.ts:231`).

11. **Robustness:**
    - No `webglcontextlost` handling anywhere in `src`.
    - `OES_texture_float_linear` is required (`gl.ts:222`) although no 32-bit float texture is created.
    - GLSL undefined behaviour: `pow` of a negative base (`water.ts:187`), and `smoothstep` with edge0 > edge1 (`lighting.ts:127`, `clouds.ts:72-73`).

Not re-verified by me (the rendering subagent's checks, found consistent): the 8-byte vertex packing against the shader's unpacking, the std140 Frame block against `frame.ts`, the absence of feedback loops, GL state between passes, and the pairing of each cascade's matrix with its own shadow map.

## Findings and disposition

IDs follow the order of the reports: F0 to F6 are Codex lens A's findings 1 to 7, F7 to F14 are lens B's 1 to 8. F15 to F76 are the Claude lane's findings in the order of its report: section 1's fourteen are F15 to F28, section 2's seven F29 to F35, section 3's eight F36 to F43, section 4's eleven F44 to F54, section 5's eleven F55 to F65 and section 6's eleven F66 to F76. "Red on the old code" means the named test was run against the reviewed behaviour, by putting the defect back for one run, and failed.

| ID | Finding | Disposition and reason | Repair or follow-up |
|---|---|---|---|
| F0 | Setting the clock forward (the almanac's "Next season") starves the wildlife: the gap is applied as hunger with no chance to feed. Major. | Accepted. The reviewer reproduced it: 158 of 158 non-fish animals dead after a seven-day jump. | Game side in `17ca604`: the almanac sets the clock through `Game.setClock`, and `Weather.resync` re-plans from the new time (`weather.test.ts`, "carries on changing after the clock is set"). The wildlife's own handling of a jump was assigned to the worker that owns `src/sim/eco`. Repaired in `79bf007` (merged at `930577a`): a gap between two ticks that is negative, or longer than five simulated seconds, is taken as the clock having been set, and every time the wildlife remembers is carried along with it (`Eco.carry`). `clockset.test.ts`, five tests, four of them red with the carrying switched off; the seven-day jump reproduces the die-off. |
| F1 | A door on a collapsing structure comes out twice: once as an item when its sill goes, once inside the rubble. Major. | Accepted. | `17ca604`, `Structure.release`: a cell that no longer holds what was traced is not part of the piece. `physics.test.ts`, "does not double a door, a torch or a lantern", red on the old code (two doors). |
| F2 | A block broken and right-clicked in the same frame is used on the stale hit; a door is written back after yielding its item. Major. | Accepted. | `17ca604`, `Interaction.update` aims again after a break. `interaction.test.ts`, "does not bring back a door", red on the old code. |
| F3 | Berries picked into a full pack are lost and the bush is stripped anyway. Minor. | Accepted. | `17ca604`: berries come off as an item drop through the `gained` hook; without a hook they go into the pack only if they fit (`Inventory.room`). `interaction.test.ts`, "picks a ripe bush". |
| F4 | A right click greets the creature that was under the crosshair last frame. Minor. | Accepted. | `17ca604`, `Game.greet` picks afresh from the current view. No test of its own: it needs the game loop; the browser trade test exercises the path. |
| F5 | A child's picking box is scaled down twice and ends below its head. Minor. | Accepted. | `17ca604`, `CREATURE_HEIGHT.child` is the unscaled model height. `interaction.test.ts`, "finds a child by its head", red on the old code. |
| F6 | The browser gate's proof that creatures are drawn counted boxes handed to the renderer, not pixels. Minor. | Accepted. | `17ca604`, "creatures and loose bodies reach the screen" compares probe grids with and without a row of creatures and a wall of bodies. Red with the draw call removed (19 and 17 cells changed, by shadows alone, against 85 and 114). |
| F7 | Taking away a bright lamp puts out a dimmer one standing in its light. Major. | Accepted. The property test that held incremental repair to a full recompute scattered its edits too thinly for two lamps ever to meet. | `7610dca`, `LightEngine.darken` gives swept emitters their light back. `world.test.ts`, "keeps a weaker lamp alight" and "crowded lamps", both red on the old code. |
| F8 | `sampler2D` precision is not declared, so depth and HDR samples are `lowp` where the hardware honours it. Major. | Accepted. Desktop GPUs ignore the qualifier, which is why nothing showed here. | `7610dca`, the shader header names every sampler type. No test: this machine cannot show the difference. |
| F9 | The atmosphere takes a ray that misses the planet for one that hits it: the sun goes out just above the horizon and most of the sky is in false shadow when it is low. Major. | Accepted. This was the cause of the dark sunsets that an earlier commit had painted over with a twilight term. | `7610dca`, `hitsGround` on both the CPU and GLSL sides; the twilight term removed. `atmosphere.test.ts`, three tests red on the old code. Captures at four times through dusk. |
| F10 | Translucent faces write depth but are not sorted within a section: a window hides the window behind it from one side. Major. | Accepted. | `7610dca`: water is drawn first with depth writes, glass after it without. Looked at from both ends of four windows in line; no automated test. |
| F11 | Clouds and rain are placed by the current wind times elapsed time, so each change of wind moves them by more the longer the game has run. Major. | Accepted, and the same fault was then found by the owner in the water ripples and the swell headings. | `7610dca`: travel is accumulated in `Drift` and wrapped; rain and snow use a wrapped clock with each fall starting somewhere new (`drift.test.ts`). The water follow-up is in the commit after it. The shader side has no automated test; rain, snow and sea were looked at. |
| F12 | Translucent blocks in the world's top layer get no sky light. Minor. | Accepted. | `7610dca`, `seedCeiling`. `world.test.ts`, "lets the sky into translucent blocks in the very top layer", red on the old code. |
| F13 | `smoothstep` with its edges reversed is undefined in GLSL (four sites). Minor. | Accepted. | `7610dca`: each written as one minus the rising ramp, which is the same value on hardware that computed it the obvious way. No test. |
| F14 | `pow` with a negative base in the rain rings. Minor. | Accepted. | `7610dca`: squared by multiplying; one Fresnel term clamped for the same reason. No test. |
| F15 | A woodcutter's fell takes neighbouring trees with it and leaves floating leaves. Major. | Accepted. | `7874faf`: a felling takes one trunk, the hanging wood nothing else holds up (twelve logs at most) and the leaves nearer to it than to any wood left standing. `woods.test.ts`, "takes a tree that stands alone whole", "leaves the tree beside it whole when their crowns mingle" (1,260 pairs) and "yields nothing for wood that is not a standing trunk"; red on the old flood (20 leaves left of a lone oak; a neighbour's log taken). The wildlife's regrowth test had taken its thresholds from the leaves the old fell left hanging over a clearing; they are restated in `d7b5c2e`. |
| F16 | The player's log builds inside the village forest are scanned as trees and felled. Major. | Accepted. | `7874faf`: the woodcutters know the trees that stood at the founding and those that come up from a sapling, not any two logs in the forest. `woods.test.ts`, "fells trees and leaves the logs of a build among them alone"; red with the old rescan (the player's post was felled and a sapling planted in it). That knowledge cannot be read back off the blocks: once there are save files it has to be saved. |
| F17 | One missing street-lamp lantern makes the watch shuttle for three hours every evening. Major. | Accepted. | `7874faf`: a guard is on the lamp round only while there is a lamp that guard can tend. `watch.test.ts`, two tests; red on the old code (with one lantern gone: 11 lightings for 7 lamps, the round ran until 20:06, no supper and no patrol in the hour after dark). |
| F18 | A hungry adult who cannot afford the chosen seller's food loops at the counter and blocks it. Major. | Accepted. | `7874faf`: a shopper is sent only to a seller with something the purse covers, and a trip that brings no food is followed by alms or foraging. `errands.test.ts`, "feeds an adult whose purse covers nothing"; red (the old code held the counter for 148 s of 180 and gave no meal). |
| F19 | The soak's "each trade reaches its workplace" passes for live-in workers who never leave bed. Major. | Accepted. | `22a7f22`: indoors counts as at work only at a work spot or with hands busy, never asleep. Proved by mutation: with live-in workers kept in bed, the old check passes and the new one fails. |
| F20 | The player can sell goods for 0 coins. Minor. | Accepted. | `7874faf`: a lot worth less than one coin gets no offer. `village.test.ts`, "trades with the player", red ("expected +0 to be null"). |
| F21 | The spec's pricing claims are false. Minor. | Accepted as a false statement; the rules themselves stay. | The spec now gives them as the code has them: villagers pay the posted price; the player buys from the cheapest sellers at a price that looks ahead to the emptier shelf, rounded up once per seller, and sells for 70% of a price that looks ahead to the fuller one, rounded down. One cheap item is the dearest way to buy. |
| F22 | Farmers skip meals because two tasks share `retryAt`. Minor. | Accepted. | `7874faf`: shopping and firewood each have their own wait. `errands.test.ts`, "lets a farmer just in from gathering firewood", red with the waits shared again. |
| F23 | A tavern drinker's mug count is read as a shop id. Minor. | Accepted. | `7874faf`: the mug count is its own field. `errands.test.ts`, "leaves a drinker at the tavern with the one mug", red. |
| F24 | Nobody patrols for longer than the spec says. Minor. | Accepted as a false statement. | The spec now says nobody patrols from about a quarter to eleven until about a quarter past three. |
| F25 | The teleport counter misses relocations. Minor. | Accepted. | `5426dad`: lifting someone out of a cell that cannot be stood in is counted, and nobody is moved onto a bed or a stool they did not walk up to. `robust.test.ts`, two tests, red on the old code. The counting turned up one uncounted lift in the island test, a walker stopped half-way up a step and re-seated; walkers now set off from where they are. |
| F26 | Cached step costs go stale. Minor. | Accepted. | `bdc6254`: the walk signature carries step cost and wading depth. `nav.test.ts`, two tests, red on the old signature. |
| F27 | Several coin checks in the tests cannot fail. Minor. | Accepted. | `22a7f22`: the coin checks count the wallets against the count at the start. Proved by mutation (a coin lost on payments over three: the old lines pass in three tests, the new fail in four). The other half, meals counted net of alms, was not proved red. |
| F28 | The village the player sees is never simulated headless. Minor. | Accepted, and it mattered more than its rank: run on the generated island, the woodcutters and the hunter never reached their ground. | `0c98827`, `src/life.test.ts` runs the village and the wildlife together on the default island. Red on its first run (6 route failures, one resident carried, nothing hunted, a 121 ms tick). |
| F29 | Rabbits down their burrows are never hidden: drawn in a pile, found by `findAnimal`, shot by the hunter. Major. | Accepted. | `2cc32a9` (the wildlife's worker): `hidden` is set while a rabbit is below, `findAnimal` passes over it. `behaviour.test.ts` holds `hidden` to the inspector's "Down its burrow." for every view over a day; `api.test.ts`, "a rabbit down its burrow is not there to be found". |
| F30 | Saplings grow into trees through the player, villagers and walls. Major. | Accepted. | `3ecf57b`: a sapling waits while a villager or the player is within seven blocks, and never grows with something built within three (it dies after its fortnight). `flora.test.ts`, "where a sapling may not become a tree", red with the rule off (the walled sapling became a trunk). |
| F31 | The three-year stability soak the spec requires is not in the gate. Major. | Accepted as a false statement, not as a missing gate: three years on five seeds takes over a minute. | The spec now says what the gate runs (one year on one seed, spring and summer on four more) and that the three-year run is by hand. It was run on `79bf007`: five seeds, three years, every species present and under its cap. |
| F32 | Fox and wolf raids ask for livestock of any kind, so a nearer cow makes the fox give up the hens. Minor. | Accepted. | `2cc32a9`: foxes ask for chickens, the pack for sheep. `stock.test.ts`, with a decoy of the other kind standing nearer. |
| F33 | `killLivestock` never marks the view dead, so a second fox kills a hen that is gone. Minor. | Accepted. | `7874faf`: the view is marked dead and the village raises no cue of its own, so the predator's is the only one. `village.test.ts`, "serves predators through the livestock api", red twice (not marked dead; two bursts of feathers). |
| F34 | The spatial grid files a moving animal one column late. Minor. | Accepted. | `3ecf57b`, `SpatialHash.moved` files by the column just entered. `spatial.test.ts`; not run against the old code, which by reading leaves the animal in its old cell. |
| F35 | Paddling ducks take off for no reason whenever they pass under anything. Minor. | Accepted. | `3ecf57b`, `movePaddler` keeps the remembered air floor current. `behaviour.test.ts`, "a duck paddling under a bough stays on the water", red with the line removed. |
| F36 | Finite water is destroyed uncounted when anything is placed into it. Major. | Accepted. | `1a9dcd8`: the physics layer tells the fluid what every outside edit replaced. Finite water is pushed into the cells beside it, then up the column, and only what fits nowhere is counted as lost; water poured into a source is counted as absorbed. `fluid.test.ts`, "moves water aside when anything is put where it stands, and loses none", and `physics.test.ts`, "keeps every unit of water when a block is placed in it, a crop is sown in it and a tree grows up through it". Red: 848 of 864 units left after one placed stone. |
| F37 | A river step, once disturbed, churns water for ever. Major. | Accepted, and worse than reported: on the default island the old rules made 2,973 world writes a tick, for ever, once the exposed sources had been woken. | `1a9dcd8`, in the fluid's rules: a source does not spill where the water would run straight back into a source; water lying on a source is swallowed unless two sources hold it; a cell beside a source does not pass water on to where it would be swallowed. `river.test.ts`, six tests on a hand-built stepped channel, a hole in deep water and a generated island, all red on the old rules (the active set never emptied). On the tree with F55's river: 92 places where a source stands over lower water, all quiet 16 ticks after being disturbed, and none beside a drop onto land. |
| F38 | The player's shove on rubble is only right at 60 frames a second. Major. | Accepted. | `1a9dcd8`: the player's speed is the move reported divided by the length of the step that follows, smoothed over a twentieth of a second. `rigid.test.ts`, "shoves at the player's own speed whatever the frame rate", from 20 to 240 Hz; red on the old pusher (a 3 m/s walk flung a rock at 9.26 m/s at 20 Hz and left it behind at 144 Hz). |
| F39 | The physics soak checks none of the conservation invariants. Major. | Accepted. | `2af02f2`: the soak audits finite water against a ledger of where water came from and went (`Physics.ledger`), and every kind of block and item across the grid, the bodies and the drops. Red three ways: water deleted under a block again, an item despawned uncounted, a shed leaf unreported. The audits found no leak in the repaired code. |
| F40 | Any second course resets the cantilever span. Minor. | Accepted. | `1a9dcd8`. `structure.test.ts`, "holds a beam two courses deep to the same span as one", red on the old line. |
| F41 | "Ground" is a guess with visible holes. Minor. | Accepted in part. | `1a9dcd8`: ground is natural rock and soil all the way down to the world's floor, not any natural block with three below it. `structure.test.ts`, "does not take a stack of placed earth for the ground once its foot is dug away", red. Not repaired: a piece of more than 4096 cells is still assumed held; bringing one down properly is a staged collapse, which is a redesign. The limit is stated at `VISIT_CAP`. |
| F42 | Sand and gravel rest on torches, crops and ladders. Minor. | Accepted. | `1a9dcd8`: only something solid holds a loose block up, and the same for rubble going back into the grid. `loose.test.ts`, "is not held up by a torch, a crop or a ladder", red (the sand rested on the torch). |
| F43 | A body refused once at settle time never returns to the grid. Minor. | Accepted. | `1a9dcd8`: a settle refused because the player or another body is in the cell is tried again every second. `physics.test.ts`, "goes back into the grid once the player, or an item, is out of the cell it lies in", red. |
| F44 | Flying down and forward is Control with W, which closes the browser's tab. Major. | Accepted. A page cannot prevent that shortcut, so the binding had to go. | `3ecf57b`: down is C alone, and the help panel says so. No test: it is a key binding. |
| F45 | The browser gate's "creatures are drawn" check cannot fail, and other checks in the same file are hollow. Major. | Accepted. The creature check was F6 and already reads pixels; the prompt was already asserted by the trade test. | `3ecf57b`: every browser test now fails if the page threw or logged an error (it was three of nine), and the night test goes on round to the next morning. |
| F46 | Dropped items vanish after 300 s, against the spec's "left lying". Minor. | Accepted as a false statement: a lifetime keeps the count of live bodies bounded. The berries lost to a full pack were F3. | The spec says five minutes. |
| F47 | Turning the clock back from the almanac stalls the weather and the wildlife. Minor. | Accepted; the same defect as F0, found from the other side. | `17ca604` (`Weather.resync`) and `79bf007` (`Eco.carry`); see F0. |
| F48 | Input: the click that takes the mouse also breaks; keys and wheel act through an open panel; ten wheel notches in a frame leave a negative slot; F3 also opens the browser's find bar. Minor. | Accepted, all four. | `3ecf57b`. `interaction.test.ts`, "choosing from the belt": the wheel and the open panel, not run against the old code. The capture click and F3 have no test: they need a real pointer lock. |
| F49 | An item lying on the block aimed at blocks it. Minor. | Accepted. | `1a9dcd8`: the crosshair's ray passes over dropped items. `physics.test.ts`, "does not let a dropped item come between the crosshair and what lies behind it", red on the unfiltered ray. |
| F50 | A panel click is lost when the panel repaints between press and release. Minor. | Accepted. | `3ecf57b`: panels act on the press, and repaint only when their markup changes. The browser trade test presses a real button; the lost click itself was not reproduced. |
| F51 | Per-frame costs: the interface rewrites and re-measures every frame; every edit re-sends the rain map. Minor. | Accepted. | `3ecf57b`: markup is written on change, the root is measured on resize, and the rain map is sent only after an edit at the top of a column. No test; the frame budget in the browser gate is unchanged at 4.8 ms. |
| F52 | `validateVillagePlan` misses things the simulation trusts. Minor. | Accepted. | `5fc6507`: the validator (now in `src/world/plan.ts`) checks a pen's gate, the work-spot blocks, the storage chest, which half of a bed is named and that its stand is beside it, which way round a field's corners are, and that a field's owner is a farm; and beyond the finding, a roof over every building column and the door and its step. Six tests in `plan.test.ts`, red against the old validator. |
| F53 | The interface imports the game from the layer above; no lint rule holds the layer order. Minor. | Accepted. | `3ecf57b`, `src/ui/host.ts` names what the interface needs of the game. `b3e372e`, a lint rule for every layer, seen red on an upward import. |
| F54 | Doc claims that are not true (the player's step rate, "quarter-size", the plan's rough edges, the `fellTree` comment). Minor. | Accepted. | `3ecf57b` for the spec and README, `b3e372e` for the comment; the plan's Outcome lists the limits. |
| F55 | On every seed the river cuts an air trench through the lake. Major. | Accepted, and worse than reported: the river took its own freshly cut bed for the ground, so on every seed it sank to sea level within a few points of its start and ran the whole way to the sea in a gorge about 27 deep. | `5fc6507`, `terrain.ts`: the course is laid first, the surface is set from the ground as it lay before the river, the lake's level is held across the lake and its rim, and no bank is left lower than the water beside it. `island.test.ts`, "never leaves water resting on nothing or standing beside open air", "keeps the lake whole" and three islands of "holds its water": five tests red on the old terrain. Looked at before and after in captures: the slot in the lake, with a tree growing at the bottom of it, is gone. The river now comes down from the lake to the sea in single-block steps. |
| F56 | On seeds where a lot has to shift, later village stages wreck it. Major. | Accepted. Rare at full size (one seed in 400 surveyed), common on islands 512 across (23 of 150). | `5fc6507`: the builder records what is under a roof; lamps step off doorsteps, fields refuse built ground, the pen lane takes a free row. `generateIsland` now validates the plan it returns and throws with the validator's message, so the game cannot start on a village that does not match its plan. `village.test.ts` runs every test on seven islands; red with the lamp check removed and with the field check removed. The pen lane through a cottage was not reproduced on about 1,100 seeds; the same mask guards it. |
| F57 | Fields fall back to the wrong owner when a farm does not fit. Major. | Accepted: on 18 of 80 full-size seeds the tavern owned fields it never worked. | `5fc6507`: fields are shared among the farms that were built, and a village with no farm has none. Red on the old fallback ("field#0: owner tavern#0 is not a farm"). A village with one farm gives it all four fields; that case is not simulated. |
| F58 | Closed gates, standing lanterns and campfires can be stood on, so animals step over a closed gate. Minor. | Accepted. | `5fc6507`: those states have walk cost 0 in `blocks.ts`; no state id moved. `walk.test.ts`, "lets nobody stand on a shut gate, a fence, a lantern or a campfire" and a check of every fitting in the table, both red against the old table. |
| F59 | Wall faces beside slabs, stairs and paths render dark. Minor. | Accepted. | `d27d6b7`: a face averages only the cells that hold light, and one that looks into a slab, a stair or a path borrows the light beside that cell. Water went through the same code: under a raised slab it was black. `mesher.test.ts`, two tests, red. Looked at under an overcast sky, where it shows. |
| F60 | Light repair runs on every edit, whether or not the edit can change light. Minor. | Accepted. | `3ecf57b`, `LightEngine.attach` skips an edit that changes neither opacity nor emission. `world.test.ts`, "does no repair for an edit that changes neither"; not run against the old code, where it would list three repairs. |
| F61 | The light property test misses source removal and the top layer. Minor. | Accepted; already repaired in this round as F7 and F12. | `7610dca`: "crowded lamps" and "the very top layer" in `world.test.ts`. |
| F62 | The generated-village tests are weaker than their names. Minor. | Accepted. | `5fc6507`: seven islands instead of one; the reachability flood takes the path search's own step rule (`src/world/gen/testkit.ts`, with a test that it refuses what the search refuses); the tree check covers all made ground and every building. The stronger tests found two more generation defects, repaired in `fill.ts` and each seen red: crowns hanging into roads and through walls, and caves cut into the river bank. |
| F63 | A failed mesh worker hangs the loading screen. Minor. | Accepted. | `d27d6b7`: the pool listens for a worker's failure, keeps the first, and gives a silent worker's section to another. `meshPool.test.ts`, five tests, four red without the handlers. `649b878`: the loading screen stops with the message. |
| F64 | `src/world/gen` imports types from `src/sim/api`, against the layer order. Minor. | Accepted. | `5fc6507`: the plan's types and its validator live in `src/world/plan.ts` and are re-exported from `src/sim/api.ts`. `plan.test.ts`, "imports nothing from a layer above it", and the lint rule of F53. |
| F65 | Doc claims that are not true (what a low step is, one-state sections, a file that does not exist). Minor. | Accepted. | `3ecf57b`. |
| F66 | Wind-driven animation multiplies elapsed time by the current wind. Major. | Accepted; the same defect as F11, which Codex found in the clouds and rain and the owner then found in the water. | `7610dca` and `d7845ff`; see F11. |
| F67 | The lighting pass uses the relief-carrying G-buffer normal as the surface normal. Major. | Accepted, and repaired another way than the finding asked. A normal rebuilt from depth was built first and looked at: beyond a few hundred metres one step of depth is a fair part of the gap between pixels, and the far cliffs whitened with snow. | `afaee3b`: the geometry passes record which way each face looks in a spare channel of the G-buffer (`FACE_CODE`). The shadow offset, puddles, snow and the caustic mask read that; shading keeps the painted relief. No unit test: it is a shader. Looked at in snow and rain on walls, a sunlit square and a far hillside: no acne, no detached shadows, no specks of snow on walls. The invariant in AGENTS.md is reworded to allow either source of the face. |
| F68 | Wet and dry flip from pixel to pixel on walls. Minor. | Accepted. | `afaee3b`: the rain map is asked half a block out along the face. Looked at: the stripes across a house wall in rain are gone. |
| F69 | Bloom is thresholded before exposure. Minor. | Accepted. | `37c986d`: what glows is judged after exposure. Looked at: a fire on a moonless night glows where it did not; a clear day is about 7% darker for losing the veil (118.7 to 110.8 on the gate's noon probe, inside its limits). |
| F70 | Glass ignores key and cloud shadows. Minor. | Accepted. | `93f3266`. Looked at in sun and under cloud. |
| F71 | Rain rings on water ignore the rain heightmap. Minor. | Accepted. | `93f3266`: each ring asks the rain map at the point its drop falls. Looked at under a plank roof over open water. |
| F72 | Light shafts march through water. Minor. | Accepted. | `93f3266`: shafts stop at the water's surface. Looked at: the milky haze over the sea is gone. |
| F73 | Children's sit and sleep poses use adult metres. Minor. | Accepted, and the frames showed a second defect: on real beds every sleeper, adult or child, lay the wrong way round, feet on the pillow. | `d27d6b7`: a pose's lift and shift scale with the creature, and a sleeper lies from the feet toward the heading, as the village places it. `entities/renderer.test.ts`, two tests, red. `649b878`: a sleeper is picked along the bed, where it had to be aimed at by the foot. |
| F74 | Cascade texel snapping breaks during the sprint field-of-view ramp. Minor. | Accepted. | `d27d6b7`: the cascades are sized for the widest field of view the camera will use, which leaves them about 11% coarser at rest. `shadows.test.ts`, "stay on one grid while the field of view widens for a sprint and comes back", red with per-frame fitting. |
| F75 | Per-frame waste: two sky-dome integrations, and a zero-length upload that sends the whole instance array. Minor. | Accepted. | `d27d6b7`: the sky integrals allocate nothing and run only when the clock has moved the sun or the moon; nothing is uploaded when no boxes are queued. Three tests, red. Measured by the worker on the full island, base and branch in turn: a frame from the air fell from about 3 ms to about 1.7 ms. |
| F76 | No handling of a lost WebGL context; an extension required that nothing uses. Minor. | Accepted in part. | `d27d6b7`: the unused extension is no longer required (`gl.test.ts`, red). `5c0f133` and `649b878`: a lost context is noticed, drawing stops, and the player is told to reload. Not repaired: bringing the picture back, which needs a way to rebuild every object the GPU held. |

## Verification

- `npm run verify` on the tree with every repair merged: typecheck, lint with the new layer-order rule, 365 unit and soak tests in 49 files (one more skipped by design), the docs check and 9 browser tests on the GPU, at `5c21f35`. A frame on the full island takes 1.8 ms from the air and 1.2 ms in the street at 1280 x 720; it was 4.6 and 4.5 before this round's repairs, most of the difference being the sky integrals that F75 stopped running every frame.
- Codex's findings: tests proved red against the reviewed behaviour and green with the repair for F1, F2, F5, F6, F7 (two tests), F9 (three tests) and F12. F3 and F11 have tests that were not run against the old code. F4, F8, F10, F13 and F14 have none, for the reasons in the table.
- Claude's findings: each row says whether its test was seen red. Tests not run against the old code: F34, F48, F60 and the sleeper's picking box under F73. No test, by their nature: F44, F50, F51 and the shader repairs F67 to F72, which were looked at instead.
- Looked at in full-resolution captures. After Codex's findings: sunset at four times, a moonlit night, dawn mist, rain, snow, a storm, four windows in line from both ends, the sea. After Claude's: the lake and the river before and after, a river step dug out and dammed in the running game, snow and rain on a house wall, a fire on a moonless night, sleepers on their beds, glass in sun and under cloud, the hunter aiming and fetching a kill, the trade window with cheap goods in the pack.
- Four workers made the repairs to the village, the physics, world generation and the renderer, each in a worktree of its own from `0c98827`; the game's, the interface's, the wildlife's and the light engine's were made in the session. A worker's report was not taken as the result: each branch was read as a diff, merged, and its tests run on the merged tree. Two repairs changed ground another stood on, and both were checked there: the fluid's river test against the new river (92 places where a source stands over lower water, all at rest after being disturbed, none beside a drop onto land), and the wildlife's regrowth test against the new felling (its thresholds, taken from a run in which leaves were left hanging over the clearing, are restated in `d7b5c2e`). One repair broke the interface downstream of it and was caught by looking: with no offer for a lot worth less than a coin (F20), the trade window showed no way to sell firewood or stone at all; `5c21f35`.

## Round outcome

Closed. Three lanes returned 77 findings, 27 of them major, in code that had passed every gate; all 77 were accepted. Seventy-five are repaired or, where the finding was a false statement in the docs, corrected (F21, F24, F31, F46, F54, F65). Two are repaired in part and their limit stated: a detached piece of more than 4096 cells is still assumed to hold (F41), and a lost graphics context is reported to the player but not recovered from (F76). Four of Claude's findings were defects Codex had already found from another side (F45 with F6, F47 with F0, F61 with F7 and F12, F66 with F11); the other 58 were new, most of them in the three simulations Codex had not been pointed at. Reading the simulations on the generated island, which no lane had done and F28 asked for, found four more defects that are not in this table (see the devlog entry of the same day): the far trades could not reach their ground, the hunter could not take game, trees grew in one tick, and walkers sank into steps. The repairs that change behaviour go to one lane for a check, as round 1.
