# Tidewick

An original first-person voxel sandbox for the browser: a bounded island with a simulated medieval village, a wildlife ecosystem, a full day and season cycle with weather, and physics for water, loose ground, rigid bodies and collapsing structures, drawn by a custom WebGL2 renderer. The repository is named `minecraft` for the genre; the game, its art and its creatures are its own.

## Status

Under construction. What exists today is the base the game is being built on: the block and item registries, world storage, voxel light, the calendar, sky and weather models, and the contracts the simulations are written against. The page boots a WebGL2 context and draws nothing yet. This section is updated as each milestone lands; [the devlog](docs/devlog/summary.md) has the history and [the work plan](docs/work/0_genesis/plan.md) has what is open.

## Running it

Node 24.

```bash
npm install
```

```bash
npm run dev
```

The dev server listens on http://127.0.0.1:5317.

```bash
npm run verify
```

`verify` runs the type check, lint, unit and simulation tests, the docs check and the browser gate. The browser gate needs Playwright's Chromium (`npx playwright install chromium`) and a GPU; set `ALLOW_SOFTWARE_GL=1` on a machine without one.

## Where things are

- [docs/design/spec.md](docs/design/spec.md) — the design, with a section map and the dated decisions.
- [AGENTS.md](AGENTS.md) — gates, invariants and conventions for anyone (or any agent) changing the code.
- `src/core`, `src/world`, `src/sim`, `src/physics` — headless: math, voxels, simulations. They run in Node tests and in workers.
- `src/render`, `src/player`, `src/ui` — what the player sees and touches.

## Part of a fleet

This repo is one of the sibling repos kept side by side under one `github/` folder. Fleet-wide rules and setup live in [fleet](https://github.com/yanfengliu/fleet).
