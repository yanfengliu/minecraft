# Gate proofs

A gate counts only once it has been made to fail by reintroducing the defect it guards. Each entry records the gate, the mutation, the failure it produced, and the commit before the lesson was retired, so `git show <sha>:docs/learning/lessons-evidence.md` can recover the full evidence.

## Ambient occlusion must not read the relief normals

- Lesson retired: a screen-space pass takes its surface normal from depth, never from the G-buffer normal, which carries each tile's painted relief. A tilted normal sees the flat face it sits on as an occluder, and every high-contrast texel grows a dark halo that reads as a blurred texture.
- Gate: `ambient occlusion leaves a flat, high-contrast wall alone` in `tests/browser/smoke.spec.ts`. It builds a wall of birch logs in open air, looks at its shaded face, and fails if the mean of the middle of the frame differs by 3 % or more with `settings.ssao` on and off.
- Mutation: `SSAO_FS` in `src/render/shaders/post.ts` put back to `decodeNormal(texture(uNormal, vUV).rg)`, with the normal buffer bound again in the renderer.
- Seen red: 2026-11-11, 154.1 with occlusion against 173.7 without, 11.3 % darker. With the fix restored: 174.0 against 173.9.
- A trap inside the gate: its first version passed against the mutation, because every `step` in one `page.evaluate` runs without yielding and the mesh workers' answers never arrived, so it was comparing sky with sky. The test now waits for the mesh pool between steps and fails if any probe is sky-blue. Any browser test that edits the world and then reads pixels needs the same wait.
- Commit before the lesson was retired: 26bdbe3.

## A browser test that steps the game must own its clock

- Gate: `boot()` in `tests/browser/smoke.spec.ts` waits for the game's own loop to run, then stops it, so only `step()` advances the game.
- Defect: with the loop left running, real frames slipped in between a key press and the step that followed it. How many depended on machine load.
- Seen red: 2026-11-11, with three other agents running tests on the machine, the walk test measured 7.04 m against a limit of 7 m (4.3 m/s for 1.5 s is at most 6.45 m). Not reproduced on purpose afterwards; the failure itself is the proof, and the lesson went straight to its gate without a stay in the queue.
- Commit before the gate: cafaad0.
