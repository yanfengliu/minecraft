# Tidewick

An original first-person voxel sandbox for the browser: a bounded island with a simulated medieval village, a wildlife ecosystem, a full day and season cycle with weather, and physics for water, loose ground, rigid bodies and collapsing structures, drawn by a custom WebGL2 renderer. The repository is named `minecraft` for the genre; the game, its art and its creatures are its own.

## Status

Under construction. Today you can walk, jump, swim and fly (F) around a generated island with a mountain, a lake, a river and forests, break blocks (hold left mouse) and place them (right mouse, number keys pick the slot), under a sun and moon that cross a physically based sky. Rendering has cascaded shadows, baked sky and torch light, ambient occlusion, refractive and reflective water, bloom and tone mapping. Not there yet: clouds and weather effects, the village and its residents, wildlife, the physics systems, and any interface beyond the bare view. This section is updated as each milestone lands; [the devlog](docs/devlog/summary.md) has the history and [the work plan](docs/work/0_genesis/plan.md) has what is open.

Add `?size=256` to the address for a quarter-size island that loads in a second, and `?seed=7` for a different one.

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
