# Review 1: implementation

## Target

Repository `minecraft`, commit `d8538f9` ("Record review round 0 in full: 77 findings and what was done about each"): the repairs made after round 0, which are the commits from `b00fc32` to `d8538f9`, and the behaviour added on the way (the hunt with a bow, the path search's allowance by distance). The reviewer read a detached checkout of that commit, separate from the working tree.

Line numbers in the report are those of `d8538f9`. Recover the reviewed text with `git show d8538f9:<path>`.

## Reviewers and coverage

Run by the fleet's multi-CLI review runbook, from a run folder outside the reviewed tree.

- **Codex, `gpt-6-astra` at `xhigh`, read-only sandbox, one lane.** Asked to check the repairs that change behaviour, in twelve groups: the fluid's rules; river and lake generation; village generation and the plan's validator; felling and the woodcutters' knowledge of trees; the hunt with a bow; the watch, shopping and counted relocations; the path search; the player's shove, settling, loose blocks and ground; rendering; light repair; input and interface; wildlife. For each: does the repair remove the defect at its root, did it break anything nearby, and can its test fail. It ran 21 minutes. Its log passed the runbook's check: the model and sandbox it reported were the ones asked for, 53 commands ran and none was refused. It reproduced five of its six findings by running the code in memory, and says how for each.
- One lane, as the runbook asks for a check of repairs. No Claude lane. Not covered: whatever the repairs did not touch.

The reviewed checkout was unchanged afterwards (`git status --porcelain` empty).

## Reports

The report is the lane's own text, copied by script. The one change is that absolute paths into the reviewed checkout were turned into links relative to this file.

### Codex (gpt-6-astra, xhigh): the repairs of round 0

1. **Major — F36: displacement still destroys water when space is available.** [fluid.ts:253](../../../../src/physics/fluid.ts:253) searches only immediate neighbours and the original column, then records the remainder as lost. In an in-memory reproduction, placing stone into a full, two-block-deep pool beneath one ceiling block reduced water from 288 to 272 units, despite open space above neighbouring columns. The 32-cell upward limit also loses water in an unobstructed deeper column. Counting this loss does not satisfy conservation when the connected pool has room.

2. **Major — F16: building on a removed tree’s location remains vulnerable to woodcutters.** The listener at [woods.ts:48](../../../../src/sim/village/woods.ts:48) registers growth but never invalidates a tree when its original trunk disappears. The check at [woods.ts:230](../../../../src/sim/village/woods.ts:230) accepts any replacement log at that location. Reproduction: remove a registered pine, construct a three-log oak post on its stump, then let the woodcutter complete the action. All three construction logs become carried goods and the post becomes a pine sapling.

3. **Major — item 5: changing goals permanently forgets a successful bow kill.** [outdoor.ts:228](../../../../src/sim/village/outdoor.ts:228) stores the corpse exclusively in `targetId` and `target`; [routine.ts:128](../../../../src/sim/village/routine.ts:128) clears both when lunch, sleep or another goal takes priority. Dead animals are absent from `findAnimal`, so subsequent hunting cannot recover that reference. A staged successful shot crossing lunchtime produced one counted kill, zero harvests and an immediately cleared target. The corpse eventually expires, losing its meat and hide. The integration test’s equality between hunted deaths and `animalsHunted` still passes because both count the shot, not retrieval.

4. **Major — item 7: the expanded search allowance blocks unrelated routes for tens of seconds.** [navigator.ts:247](../../../../src/sim/nav/navigator.ts:247) increases the allowance with distance, while [navigator.ts:281](../../../../src/sim/nav/navigator.ts:281) gives the active search every subsequent tick’s budget until completion. On a 768×768 flat world divided by an impassable wall, an unreachable 680-block request kept an unobstructed 20-block request pending for 252 updates—25.2 simulated seconds. All queued, uncached requests behind that search suffer the same delay.

5. **Major — F30: elevated buildings still admit growing tree crowns.** [flora.ts:346](../../../../src/sim/eco/flora.ts:346) checks construction only at the sapling’s base height and below. A neighbouring building whose floor is two blocks higher passes `clearForTree`; tree placement checks trunk clearance but places leaves independently into available cells beyond walls. Reproduction with a sapling at `(20,32,20)` and an enclosed plank room starting at `x=21`, floor `y=34`, grew eight leaf blocks inside the room. The ground-level wall test misses this case.

6. **Minor — F50: panel buttons no longer support keyboard activation.** [hud.ts:64](../../../../src/ui/hud.ts:64) replaces the delegated `click` handler with a `pointerdown` handler only. Enter or Space on a focused native button generates a click without pointerdown, so Close, trade and other panel actions do nothing. There is no keyboard activation handler compensating for the removed click listener.

| Item | Read and disposition |
|---|---|
| 1. Fluid | `fluid.ts`, `leveling.ts`, physics `onChange`, displacement and river tests: finding 1; no additional in-scope F37 finding. |
| 2. River/lake generation | `terrain.ts`, filling and water-boundary checks: no defect found; 32 additional generated islands passed the water-fault probe. |
| 3. Village/validator | Village generation, `fill.ts`, `plan.ts`, `island.ts` and associated tests: no defect found in inspected changes or seed/size probes. |
| 4. Felling/woodland | `createBasicActions`, `woods.ts`, tree generation and felling tests: finding 2; no additional F15 finding. |
| 5. Bow hunting | `hunt`, `shoot`, `harvest`, death handling, resident routines and integration assertions: finding 3. |
| 6. Watch/shopping/relocations | `watch.ts`, `errands.ts`, `meals.ts`, `agent.ts` and associated tests: no defect found; four-day probe conserved coin across 88 purchases. |
| 7. Navigation | `navigator.ts`, A*, node storage, follower and walk signature: finding 4; no additional F26 or unhandled-storage-exhaustion finding. |
| 8. Physics | Pusher, settling, rigid-body callers, loose blocks, structure and cantilever changes: no additional defect found by inspection; Rapier execution not performed. |
| 9. Rendering | Named shaders, face encoding/decoding, post-chain bindings, cascades, atmospheric cache and sleeping-pose placement: no source-level defect found; rendered output not checked. |
| 10. Light invalidation | `light.ts` and block light tables: no defect found; inspected propagation depends on `LIGHT_OPACITY` and `EMIT`. |
| 11. Input/interface | `input.ts`, interaction, HUD, panels, host and trade execution: finding 6; no additional finding in the other named repairs. |
| 12. Wildlife | Flora growth/tests, spatial-grid callers and clock-carry fields: finding 5; no additional F34 or F0 finding. |

## Findings and disposition

New findings continue the work unit's numbering: F77 to F82 are the report's items 1 to 6. Each concerns a repair of round 0 or the hunt added beside them, and is named with the finding it follows. "Red on the old code" means the named test was run against the reviewed behaviour, by putting the defect back for one run, and failed.

| ID | Finding | Disposition and reason | Repair or follow-up |
|---|---|---|---|
| F77 | Follows F36. Displaced water is still lost when the pool has room: the search for room looked only at the four cells beside the block and straight up its own column. Major. | Accepted. The reviewer's case was reproduced: a block set under a ledge in a full pool lost a block's worth with open sky one cell over. | `5b5df1a`, `Fluid.push`: the search goes down, sideways and up, and on through water that is already full, for up to 256 cells; only a body that is full and shut in loses anything. `fluid.test.ts`, "finds room for displaced water across a full pool, round a ledge and far up a shaft", red with the search cut back to the cells beside the block (16 units lost). |
| F78 | Follows F16. The woodcutters' list of trees never forgets a tree somebody else has taken, so a post built on its stump is felled and a sapling planted in it. Major. | Accepted. | `5b5df1a`, `Woods`: a tree whose foot stops being a log, whoever took it, comes off the list. `woods.test.ts`, "forgets a tree somebody else has taken, so a post set on its stump is left standing", red without it (the post was felled). |
| F79 | Concerns the hunt with a bow. A kill is remembered only in the task's scratch fields, which are cleared when a meal or bed takes over; the body then lies until it is cleared away and its meat is lost. The island test could not see it, because both sides count the shot. Major. | Accepted. This was known and had been let stand as a small loss; the reviewer is right that an animal dying for nothing at every midday is not small. | `5b5df1a`: a hunter with a kill down fetches it before any other goal is taken up (`routine.ts`), and fetched kills are counted (`VillageStats.killsFetched`). `village.test.ts`, "fetches a kill that is down before answering hunger or the clock", red without the rule. The island test now requires all but at most one kill to have been brought in; its run shot six and fetched six. |
| F80 | Concerns the path search's allowance by distance. One search holds the only searcher until it ends, so a far goal that cannot be reached kept a 20-block walk waiting 252 ticks on a 768-block world. Major. | Accepted. | `5b5df1a`, `Navigator`: goals within 48 blocks have a queue and a searcher of their own and are served first; a long search keeps two fifths of each tick's budget while it has work, so neither starves the other; and no search may spend more than 80,000 expansions however far its goal. `nav.test.ts`, "answers a short walk while a long search is still looking, and starves neither", red with one queue (27 ticks against 2). |
| F81 | Follows F30. The check for buildings round a sapling looked only at the sapling's own level and below, so a house standing two blocks higher let the crown grow in through its walls. Major. | Accepted. | `5b5df1a`, `Flora.builtInCrown`: nothing built may stand within five blocks of the trunk from the sapling's level to fourteen above it. `flora.test.ts`, "where a sapling may not become a tree", now with a shut plank room on stilts; red without the check (the sapling became a trunk). Not covered, and said so in the code: a cabin of bare logs, which this cannot tell from trees. |
| F82 | Follows F50. Panels act on the pointer's press and no longer on a click, so a button worked from the keyboard does nothing. Minor. | Accepted. | `5b5df1a`, `Hud`: a click with no press behind it (the keyboard's) is acted on as well. No test: the interface has none outside the browser gate. |

The other eleven groups the reviewer was asked about came back with no finding and a line each on what was read; see the table at the end of the report. Two limits on that reading are the reviewer's own: the physics changes were read, not run under Rapier, and the rendering changes were read as source, with no frame looked at. Both were covered in round 0's verification by tests and captures.

## Verification

- On `5b5df1a`: typecheck, lint, 370 unit and soak tests in 49 files (one more skipped by design) and 9 browser tests on the GPU. The docs check passes with this record in place.
- Tests seen red against the reviewed behaviour and green with the repair: F77, F78, F79, F80, F81. F82 has no test.
- The repairs of this round were made in the session, not by workers.

## Round outcome

Closed. One lane checked the repairs of round 0 and found six defects, five of them major: four repairs that had removed the case reported and left its neighbour (F77, F78, F80, F81), one accepted loss in new behaviour that was larger than it had been taken for (F79), and one regression the repair itself made (F82). All six were accepted and repaired in `5b5df1a`, five with a test seen red. Two tests of the session's own were corrected on the way: the island test held ticks to wall-clock time, which measured the machine, and now holds them to blocks written; two trade tests assumed three loaves on the stalls at one minute of the fair. The six repairs go to one lane for a check, as round 2.
