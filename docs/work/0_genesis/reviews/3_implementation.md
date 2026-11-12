# Review 3: implementation

## Target

Repository `minecraft`, commit `ba7b938` ("Record review round 2: four findings in round 1's repairs, all repaired"): the four repairs made after round 2, which are in `239ed87`. The reviewer read a detached checkout of that commit and was pointed at `git diff 81e2793 HEAD`.

Line numbers in the report are those of `ba7b938`. Recover the reviewed text with `git show ba7b938:<path>`.

## Reviewers and coverage

Run by the fleet's multi-CLI review runbook, from a run folder outside the reviewed tree.

- **Codex, `gpt-6-astra` at `xhigh`, read-only sandbox, one lane.** Asked to check the four repairs of round 2 (F83 to F86) and nothing else, and most of all the search for somewhere to put displaced water, then in its third version: can it create or destroy water, where does it put water a real pool would not, what does a call cost, and could its tests pass with the defect back. It ran 16 minutes. Its log passed the runbook's check: the model and sandbox it reported were the ones asked for, 20 commands ran and none was refused. It reproduced all four findings by running the code in memory; the fourth with the real HUD, input and player code under an event harness, without a browser.
- One lane, as the runbook asks for a check of repairs. No Claude lane. Not covered: anything outside that diff.

The reviewed checkout was unchanged afterwards (`git status --porcelain` empty).

## Reports

The report is the lane's own text, copied by script. The one change is that absolute paths into the reviewed checkout were turned into links relative to this file.

### Codex (gpt-6-astra, xhigh): the repairs of round 2

1. **Major — F83: the search cap still destroys water with reachable room.** [fluid.ts:329](../../../../src/physics/fluid.ts:329) stops after 4,096 expansions and counts the remainder as lost. An in-memory reproduction used a full 96×96×8 pool beneath a ceiling with one opening at the far corner. Replacing a bottom-centre cell lost 16 units: **1,179,648 → 1,179,632**, while the opening remained empty. The new 972-cell deep-pool test passes but misses this geometry. The capped scan made 16,543 world reads; each displacement repeats that work independently of the tick budget, so repeated placements can incur it every tick.

2. **Minor — F84: the linger limit still spills water outside a pool that has room.** [fluid.ts:329](../../../../src/physics/fluid.ts:329) stops after 128 further expansions once open space is found, then uses that spill destination without establishing that the pool is full. In a settled, one-cell-deep, 200-cell trough, the last 16 cells each had one unit of spare capacity. Replacing the first cell sent all 16 displaced units outside. After settling, the trough contained **3,168 of its original 3,184 units**, with 16 outside and no evaporation or loss. The three-cell regression test passes because its spare capacity is reached immediately.

3. **Minor — F84: displacement can pump falling water far uphill.** [fluid.ts:304](../../../../src/physics/fluid.ts:304) immediately fills any partial water encountered, regardless of elevation, while postponing open downhill neighbours. In memory, replacing a one-unit cell at `y=10` beside a full falling column moved that unit into partial water at **`y=41`**; the open cell directly below the placement received nothing. This occurs before either search limit matters. None of the four displacement tests exercises this case.

4. **Minor — F86: Space on Close also reaches the player.** [hud.ts:70](../../../../src/ui/hud.ts:70) prevents the default action but does not stop propagation. Closing immediately enables game input; the same event then reaches the window listener, which records Space despite `defaultPrevented`. An in-memory event harness using the actual HUD, Input and Player code closed the panel and made a grounded player jump on the next frame. The [browser test](../../../../tests/browser/smoke.spec.ts:164) releases Space before stepping, masking this failure.

| Item | Read and disposition |
|---|---|
| F83/F84 | Read `push`, `put`, `edited`, `setLevel`, settling rules and tests; ran all four displacement tests and shape/ledger/cleanup probes. **Not sound: findings 1–3.** |
| F85 | Read `pump`, queue servicing, budget accounting and tests; exercised sustained demand at budgets 1–20, 31, 64, 128 and 700 with deterministic replay. **No starvation or ordering defect found.** |
| F86 | Read activation handlers, repaint focus matching, panel markup, game input and browser test; exercised handlers in memory, without a browser run. **Not sound: finding 4; no additional duplicate-action or wrong-button focus defect found.** |

## Findings and disposition

New findings continue the work unit's numbering: F87 to F90 are the report's items 1 to 4. "Red on the old code" means the named test was run against the reviewed file, put back for one run, and failed.

| ID | Finding | Disposition and reason | Repair or follow-up |
|---|---|---|---|
| F87 | Follows F83. The search stops after 4,096 cells and counts the rest as lost: a block set in a full pool 96 by 96 and 8 deep, under a roof with one opening in the far corner, lost its water. Each call that fails also costs some 16,500 world reads, and nothing ties that to the tick. Major. | Accepted, and the approach with it. This was the third limit of distance and the third counter-example, so the limit is gone: the search is exact and its work is bounded in time. | `b670977`, new `src/physics/displace.ts`: all of the body's full water is searched, over as many ticks as it takes, and water waiting to be placed is counted in the ledger as `pending`. The searches pass through at most 4,096 full cells between one fluid tick and the next, however many blocks are set down, and as many again on each tick. `displace.test.ts`: "finds the one way out at the far end of a long flooded passage" (5,050 cells in single file), red on the old code (16 units lost); "finds the one opening in the roof over a wide, deep pool", the reviewer's own staging; "does only so much searching between one tick and the next", red without the shared limit (29,990 cells against 4,096). |
| F88 | Follows F84. Once open space is found the search goes on for only 128 cells more and then spills, without knowing the pool is full: a trough of 200 cells with room at its far end sent the water outside. Minor. | Accepted. | `b670977`: the body may rise only when all of its full water has been searched and none has room. "gives the water to room at the far side of a brim-full pool before it lets the pool overflow", red on the old code (6,368 of 6,384 units left in the pool). |
| F89 | Follows F84. Part-full water met anywhere is filled before an open cell below the block is looked at: one unit beside a falling column went to the top of the fall, 31 cells up. Minor. | Accepted. | `b670977`: the water goes first where it goes of itself, into the cell below and then sideways, and only what is left is given to the body. "lets water displaced from a fall go on down, not up the fall", red on the old code (nothing in the cell below). |
| F90 | Follows F86. Space on a panel's Close button also reaches the game: the panel closes, input is the game's again, the same key event arrives at the window, and the player jumps. The browser test let the key go before it stepped the game. Minor. | Accepted. | `b670977`, `Hud`: a key a button acted on goes no farther. The browser test now holds the key down while the game runs and requires the player to stay on the ground; red against a build without the repair (the player rose 0.99 m). |

The reviewer found F85 (the path budget too small to share) sound: no starvation or ordering defect at budgets from 1 to 700.

Three more things were changed in the new search before it was sent on, found by the session reading its own repair and not by a reviewer. Each has a test seen red with the defect put back.

- At each height the nearest full water is taken first. Taken last-found-first, room three steps from the block was found only after 471 cells ("takes the nearest room first").
- A search that runs over several ticks could settle for the open cell it had found though the pool had gained room behind it. It is now told of every change to a cell it has looked at, and looks again, up to twice, before the body is let rise ("looks again when a pool gets room behind the search"; without it 16 units were set on top of the pool).
- A search the world changed under no longer counts water as lost: the water waits and is looked for again, for as long as the changes go on ("does not call water lost while the walls round it are being changed, and does once they are still").

## Verification

- On `b670977`: typecheck, lint, 380 unit and soak tests in 50 files (one more skipped by design), the docs check and 10 browser tests on the GPU.
- Tests seen red against the reviewed code and green with the repair: F87, F88, F89, F90.

## Round outcome

Closed. One lane checked the four repairs of round 2. The path budget was sound. The search for somewhere to put displaced water was not, for the third time: it lost water under a wide roof, spilled it from a trough that had room, and sent a falling unit uphill (F87 to F89). All three came from one cause, a search that gives up after so many cells, so the search was rewritten without one, in its own file. The keyboard repair let the key through to the game (F90). All four findings were accepted and repaired in `b670977`, each with a test seen red. This is the fourth repair of displaced water and the fleet's limit is five attempts at one problem, so the new search goes to one lane for a check as round 4, and what that finds decides whether a fifth is made or the limit is reported.
