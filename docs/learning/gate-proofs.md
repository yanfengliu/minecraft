# Gate proofs

A gate counts only once it has been made to fail by reintroducing the defect it guards. Each entry records the gate, the mutation, the failure it produced, and the commit before the lesson was retired, so `git show <sha>:docs/learning/lessons-evidence.md` can recover the full evidence.

## A browser test that steps the game must own its clock

- Gate: `boot()` in `tests/browser/smoke.spec.ts` waits for the game's own loop to run, then stops it, so only `step()` advances the game.
- Defect: with the loop left running, real frames slipped in between a key press and the step that followed it. How many depended on machine load.
- Seen red: 2026-11-11, with three other agents running tests on the machine, the walk test measured 7.04 m against a limit of 7 m (4.3 m/s for 1.5 s is at most 6.45 m). Not reproduced on purpose afterwards; the failure itself is the proof, and the lesson went straight to its gate without a stay in the queue.
- Commit before the gate: cafaad0.
