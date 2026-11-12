# Review 2: implementation

## Target

Repository `minecraft`, commit `81e2793` ("Record review round 1: six findings in the repairs, all repaired"): the six repairs made after round 1, which are in `5b5df1a`, and two small changes made beside them (the brightness aimed at on a night with no moon, `bccf806`, and the trade window's lots, `5c21f35`, which round 1 had already seen). The reviewer read a detached checkout of that commit and was pointed at `git diff d8538f9 HEAD`.

Line numbers in the report are those of `81e2793`. Recover the reviewed text with `git show 81e2793:<path>`.

## Reviewers and coverage

Run by the fleet's multi-CLI review runbook, from a run folder outside the reviewed tree.

- **Codex, `gpt-6-astra` at `xhigh`, read-only sandbox, one lane.** Asked to check the six repairs of round 1 (F77 to F82) and nothing else: does each remove the defect at its root, did it break anything nearby, can its test pass with the defect back. It ran 18 minutes. Its log passed the runbook's check: the model and sandbox it reported were the ones asked for, 28 commands ran and none was refused. It reproduced three of its four findings by running the code in memory; the fourth, on the keyboard, is from reading and says so.
- One lane, as the runbook asks for a check of repairs. No Claude lane. Not covered: anything outside that diff.

The reviewed checkout was unchanged afterwards (`git status --porcelain` empty).

## Reports

The report is the lane's own text, copied by script. The one change is that absolute paths into the reviewed checkout were turned into links relative to this file.

### Codex (gpt-6-astra, xhigh): the repairs of round 1

1. **Major — F77: the search limit still destroys water in open pools.** [fluid.ts:269](../../../../src/physics/fluid.ts:269) stops after 256 queued cells and records the remaining units as lost at line 294, even when connected space remains unexplored. An in-memory reproduction with a 39×39 pool, 21 blocks deep and open above, lost 16 units when stone replaced its bottom-centre cell: 511,056 → 511,040. The limit bounds work to 1,536 neighbour visits, but does not establish that the pool is closed. The new small-pool and narrow-shaft test misses this case.

2. **Minor — F77: displacement can pump water uphill and out of the pool despite lower room.** [fluid.ts:289](../../../../src/physics/fluid.ts:289) fills destinations immediately, before exploring queued full neighbours. Consequently, open space directly above wins over lower space reached through one full neighbour. An in-memory reproduction settled with all 16 displaced units in an outside pocket, while the original pool retained a full cell’s spare capacity; nothing evaporated. The regression test checks conservation, which still passes with this incorrect destination.

3. **Minor — F80: small configured budgets can starve the long queue indefinitely.** [navigator.ts:277](../../../../src/sim/nav/navigator.ts:277) rounds the reserved share down to zero when `budgetPerTick` is 1 or 2. A continuously populated short queue then consumes every tick’s allowance. With budget 2 and one short request added per update, the long search remained pending after 500 updates, having performed only its initial two expansions. The new fairness test uses the default budget of 700 and cannot detect this.

4. **Minor — F82: keyboard activation remains vulnerable to panel refreshes.** The new listener at [hud.ts:69](../../../../src/ui/hud.ts:69) requires a generated click, but [hud.ts:121](../../../../src/ui/hud.ts:121) replaces the entire panel whenever its markup changes. If an almanac or trade refresh occurs between Space keydown and keyup, it removes the focused button; the release cannot activate it. This leaves the keyboard equivalent of the repaint race that motivated `pointerdown`. This finding is from source inspection; browser behavior was not exercised, and no regression test covers it.

| Repair | Read and disposition |
|---|---|
| F77 | `push`, `put`, `edited`, pressure handling and displacement tests; not sound—findings 1–2. |
| F78 | Removal listener, felling callback, replanting, growth registration and tests; no defect found, including an executed same-stump lifecycle probe. |
| F79 | Routine override, retrieval, navigation failure handling, harvest accounting and tests; no defect found in successful, missing, enclosed or unstandable corpse paths. |
| F80 | Both queues, A* instance storage, shared grid, cancellation and fairness tests; not sound—finding 3. |
| F81 | Crown bounds, block classification, growth scheduling, tree shapes and tests; no defect found; none of the default working forest’s 143 registered trees failed the new check. |
| F82 | Both event handlers, repainting and input handling; not sound—finding 4; ordinary pointer/click dispatch did not double-act. |
| Night brightness | Exposure calculation and numerical sweep; no source-level defect found; rendered output not checked. |
| Trade lots | Panel lot selection, quotes, transaction execution and tests; no defect found. |

## Findings and disposition

New findings continue the work unit's numbering: F83 to F86 are the report's items 1 to 4. "Red on the old code" means the named test was run against the reviewed file, put back for one run, and failed.

| ID | Finding | Disposition and reason | Repair or follow-up |
|---|---|---|---|
| F83 | Follows F77. The search for room stops after 256 cells and counts the rest as lost, though the pool is open: a block set at the bottom of a pool 39 by 39 and 21 deep lost its water. Major. | Accepted. Spreading evenly from the bottom of a deep pool, 256 cells do not reach the top. | `239ed87`, `Fluid.push` rewritten: the full water still to be passed through is taken highest first, so the search climbs to the surface from any depth, and it may pass through 4096 cells. `fluid.test.ts`, "raises a deep pool from a block set at its bottom" (a pool 9 by 9 and 12 deep), red on the reviewed file (16 units lost). |
| F84 | Follows F77. Open space above the block was filled before room in the pool one cell farther on was looked for, so water was lifted onto the block and ran off outside a pool that had room. Minor. | Accepted, and repaired with F83 because it is the same function: the order in which room is taken was wrong, not only the reach. | `239ed87`: water with room is taken first, wherever in the body it is met; open air on or against the body only if the body has none; and open air round the block itself last of all. `fluid.test.ts`, "keeps displaced water in a pool that has room, rather than lifting it onto the block", red on the reviewed file (28 of 32 units left in the trough). |
| F85 | Follows F80. The share of a tick kept for the long queue is rounded down, so at a budget of 1 or 2 expansions a tick it is nothing, and a stream of short walks starves the long search. Minor. | Accepted. The game's budget is 700, so this cannot happen in play; it is a fault in what the code promises. | `239ed87`, `Navigator.pump`: a budget too small to share goes to the long queue whole on every other call. `nav.test.ts`, the same test as F80 with a third case at a budget of 2, red without the alternation. |
| F86 | Follows F82. A button worked from the keyboard is acted on by the click a browser makes on the key's release, and a panel repainted between press and release has lost the button by then: the keyboard's form of the race F50 was about. Minor. | Accepted. | `239ed87`, `Hud`: Enter and Space act when the key goes down and the browser's own click is stopped; and a repaint gives the keyboard's focus to the button that does the same thing in the new markup. `tests/browser/smoke.spec.ts`, "a panel opens on its key and its buttons answer the keyboard": new, and the first test the panels' keyboard handling has had; red against the reviewed file, built and served (Space on the Close button left the panel open). |

The reviewer found F78 (the woodcutters' list), F79 (the hunter's kill) and F81 (the crown's space) sound, with a line each on what was read and run, and no defect in the night's brightness or the trade window's lots.

## Verification

- On `239ed87`: typecheck, lint, 372 unit and soak tests in 49 files (one more skipped by design), the docs check and 10 browser tests on the GPU.
- Tests seen red against the reviewed code and green with the repair: F83, F84, F85, F86.

## Round outcome

Closed. One lane checked the six repairs of round 1. Three it found sound (F78, F79, F81). The repair of F77 was not: the search for room had been widened but still gave up in a deep pool, and took open air before water with room, so the function was rewritten (F83, F84). Two more were sound in play and wrong at their edges (F85, F86). All four findings were accepted and repaired in `239ed87`, each with a test seen red. The rewritten search for room, being the third version of one function, goes to one lane for a check as round 3; the three minor repairs go with it.
