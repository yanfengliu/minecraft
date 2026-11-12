# AGENTS.md — minecraft (Tidewick)

## What this is

Tidewick is an original first-person voxel sandbox that runs in the browser: a bounded island with a simulated medieval village (residents with daily routines, an economy of some twenty goods), a wildlife ecosystem, a day, moon and four-season cycle with weather, and physics (finite flowing water, loose blocks, rigid bodies, structural collapse). Stack: strict TypeScript, a custom WebGL2 deferred renderer with no scene-graph library, Vite, Vitest and Playwright; Rapier is the one runtime dependency.

The repository is named for the genre. The game is original: never add Minecraft's names, textures, characters, sounds or levels.

Non-goals: multiplayer, a modding API, touch controls, survival combat, and any promise about save files (there are none yet).

The owner asked for a clean start here (2026-11-11). This repo does not build on `../voxel` or `../civ-engine`, and where a fleet habit or sibling code holds the work back, say so, use judgement, and record the call in [the design's decisions](docs/design/spec.md#10-decisions).

Session start: read `docs/learning/lessons.md`, the section map of [docs/design/spec.md](docs/design/spec.md), and the newest lines of `docs/devlog/summary.md`. Open work and its status live in `docs/work/`.

<!-- FLEET-CANON:BEGIN sha=7f2f32ea7a5c generated from ../fleet/FLEET.md by `npm run sync-canon` — do not edit inside this block; this repo's own rules go in docs/policies/local-rules.md -->
## Fleet constitution

Shared rules for every repo under `github/`, kept in `../fleet/FLEET.md`; `../fleet/` is fleet's checkout beside this repo's primary checkout. Where a rule gives its reason, use the reason to judge cases the rule does not name; each `[Rn]`'s history is in `../fleet/docs/canon-rationale.md`. This repo's `docs/policies/local-rules.md` may add rules but cannot change these permissions or limits. [R13]

The main agent owns delivery and may implement directly. Use subagents when bounded, independent work or independent judgment materially improves speed or quality; keep small or tightly coupled work with one agent (owner directive, 2026-11-07). [R2, R3]

The designated coordinator reads `../fleet/docs/skills/coordinator.md` before planning and after each compaction, and any agent reads that file's "Delegate" section before delegating. Before these kinds of work, read the matching section of `../fleet/docs/work-rules.md`: standing loops and unattended runs; editing skills, agent instructions or rules; handing off or stopping mid-task.

### Permissions

- Commit, merge to main and push without asking. Force-pushing and rewriting history (they destroy history), and deploying and publishing (they reach other people), need the owner's OK. [R14]
- Ask before a major architecture or product change, a new major dependency, a change to a persistent format or a security boundary, or any other consequential action outside this machine, such as posting or sending something. [R8]
- Change fleet rules (FLEET.md, fleet skills and runbooks, agent memory) or add a rule to a repo's `docs/policies/local-rules.md` only when the owner asks, because the owner sets policy. You may add a proposal with its evidence to `../fleet/canon-candidates.md`, but not edit its entries. [R8]

### Sharing the machine

- Other Claude and Codex sessions may be working in this checkout, and you cannot see them. Do anything beyond a quick read in your own worktree, because two sessions in one tree spoil each other's gates and commits. Never revert, overwrite or delete changes you did not make. When resuming, check which worktrees, branches and files already exist. [R7]
- Done means merged to main and pushed: the owner archives sessions, and work left on a branch is lost. Merge on your branch, get the gates passing there, then move main, because other worktrees build on local main. Judge the merged result itself, not a worker's summary. Then remove your worktree and branch, and report where any unmerged work is. [R14]

### Doing the work

- The repo's gates must pass before any commit that touches code. Docs-only changes need content checks and any gate the repo names for docs, not runtime tests or CI waits. [R14]
- Check the thing that should have changed (the file, the page, the number), not just the exit code or a tool's report: both can pass over a defect. Retest a blocker you inherit before repeating it. Never weaken a test or hide a failure to get green. [R9]
- Look at visual and interactive work rendered at full resolution, through the real controls, from fixed and random views, because passing tests say nothing about pixels. Run it headless unless a visible window is needed. [R16]
- Slowness on the critical path, such as a gate rendering on the CPU of a machine with a GPU, is a defect to fix. [R22]
- After pushing code, follow CI to the end; read a failed job's steps before blaming the code, since a billing limit fails jobs before any step runs. [R15]
- If a fix fails twice for one reason, rethink it. After five real repair attempts at one problem, whatever the approach and counting earlier sessions, stop and report, unless the owner set another limit; for a problem that keeps winning, run the search in `../fleet/docs/skills/hard-problem.md`. Stop when the task's criteria are met; do not invent follow-up work. [R11]
- For substantial or high-risk changes, use independent review when available. High-risk includes persistence and migrations, security and auth, concurrency, money, supply chain, and code changes in another repo. Review the exact revision against the task's criteria, and say so when review was unavailable. Fix the findings that matter and have those fixes checked; note minor ones instead of starting another round. `../fleet/docs/skills/multi-cli-review.md` provides the review mechanics. [R10]
- A defect the owner reports gets a test for its whole class and an entry in `docs/learning/defect-register.md`, because a fix without a check tends to come back. [R17]
- Sessions run long: take new requests in the same session, and never hand off to a new session to shed context. Split work expected to need more than about 200k tokens of context into milestones, each merged to main. [R6]

### Records, sized to the work

- Read `docs/learning/lessons.md` at session start; it lists this repo's known traps, and its header says how to add one. [R18]
- Every change that alters behaviour adds a dated line to `docs/devlog/summary.md` (`../fleet/docs/devlog-template.md`) when it lands, because later sessions orient from its newest entries. Work that spans sessions, has several agents writing, or gets an independent review also keeps its plan and review records in `docs/work/` (`../fleet/docs/work-docs.md`); other work needs none. [R24]
- Raw output (logs, captures, screenshots) stays in ignored folders. Never commit a binary over 512 KiB or any file over 1 MiB; LFS needs the owner's OK. [R23]

### Style and environment

- Plain words; one line per paragraph, no hard wrapping. A report says what changed, how it was checked (including any check skipped or failed) and what is not done. [R25]
- Node 24 is the baseline. Products pin the model IDs they call in their own repo, and nowhere else. Reviewer model pins live only in `../fleet/docs/skills/multi-cli-review.md`. Runtime model calls are allowed and paid for; make per-item calls one-shot, not agent sessions. [R28, R29]
<!-- FLEET-CANON:END -->

## Gates

Toolchain: Node 24, pinned in `.nvmrc`. `npm run verify` runs every gate below in order and must pass before any commit that touches code.

- `npm run typecheck` — strict `tsc` over `src` (DOM types) and over the configs and browser tests (Node types).
- `npm run lint` — ESLint with zero warnings allowed.
- `npm test` — Vitest over `src/**/*.test.ts`: unit and property tests, and headless simulation soaks that run in-game weeks. Each simulation soaks on a small fixture of its own; `src/life.test.ts` runs the village and the wildlife together on the island the game generates, which is where a limit tuned on a fixture shows.
- `npm run docs:check` — Markdown links resolve, the fleet doc shape holds, every queued lesson names its gate, no file breaks the size limits.
- `npm run test:browser` — builds, serves the production build and drives it in Chromium on the GPU. It fails on a software renderer unless `ALLOW_SOFTWARE_GL=1` says the host has none.

Visual work is not done until the rendered frame has been looked at. `npm run dev` serves the game on port 5317; `window.__tidewick` is the debug interface (teleport, set the time and weather, read metrics) that the browser gate and inspection both use. `node scripts/capture.mjs <spec.json>` saves full-resolution frames from a headless browser on the GPU to `output/captures/`; use it rather than a desktop browser pane, whose screenshots crop when the pane is hidden.

A browser test that steps the game by hand owns its clock: `boot()` in the smoke spec stops the game's own loop first. One that edits the world and then reads pixels must yield until the mesh pool is empty, because the workers' answers do not arrive inside one synchronous `page.evaluate`. Timing budgets in unit tests are judged on the best of several runs: the suite runs many files at once and other sessions share the machine.

## Invariants & boundaries

- Layering, lowest first: `src/core`, `src/world`, `src/sim`, `src/physics`, `src/mesh`, then `src/render`, `src/player`, `src/ui`, then `src/life.ts` and `src/game.ts`. A layer imports only from layers before it, types included; `npm run lint` fails on anything else. The first five are headless: no DOM and no renderer imports, because they run in workers and in Node tests.
- Simulation is deterministic: a forked `Rng`, fixed steps of `SIM_DT`, and no `Math.random()`, `Date.now()` or `performance.now()` in `src/world`, `src/sim` or `src/physics`.
- Contracts between world, simulations and renderer live in `src/sim/api.ts`. The village plan and its validator are defined one layer down, in `src/world/plan.ts`, because generation produces the plan; `api.ts` re-exports them. A `VillagePlan` from world generation or any test fixture must pass `validateVillagePlan`, and `generateIsland` throws if the village it built does not. Coin in the village is conserved exactly: between villagers every balance changes through `Economy.pay`, and the only coin that enters or leaves is the player's, through `VillageSim.buy` and `sell`.
- No screen-space pass reads the G-buffer normal as the surface normal: it carries each tile's painted relief. Rebuild the face normal from depth, as the ambient occlusion pass does.
- Block state ids are positional in the `B` table of `src/world/blocks.ts`, and tile order in `src/world/tiles.ts` is the GPU texture-array layer order. Append rather than reorder; once save files exist the id order becomes a persistent format.
- One block is one metre, units are SI, and one gravity (9.81 m/s²) applies to the player and every body.
- Walkability has one definition, `standHeight` in `src/world/walk.ts`; generation, pathfinding and animation all use it.
- Raw output (captures, traces, logs) goes in `output/` or `tmp/`, both ignored.

## Conventions

- Keep files under about 500 lines; split by responsibility before a file grows past that.
- Tests sit beside the code as `*.test.ts`. A simulation ships with a headless soak test of its own invariants.
- Shaders are template strings in `src/render/shaders/`.
- Comments say why, or state a contract; they do not narrate the code.
- Ports are fixed: dev server 5317, built preview and browser gate 4317.
- Keep `README.md` truthful about what is implemented and [docs/design/spec.md](docs/design/spec.md) aligned with the contracts.
