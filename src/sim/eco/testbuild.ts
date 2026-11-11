// The wildlife simulation as the game ships it, for the tests that need its
// real speed: one bundle of `testkit.ts`, built by the same tool that builds
// the game. The test runner links modules differently (every imported name is
// looked up through a getter each time it is read), which costs this code
// about as much again as the work itself, so a tick timed in the runner says
// more about the runner than about the tick, and a simulated year takes twice
// as long as it need. Not used by the game.

export type Kit = typeof import('./testkit');

let building: Promise<Kit> | null = null;

/** Build the bundle (once per test file) and hand back what `testkit.ts` exports from inside it. Rejects if it cannot be built. */
export function builtKit(): Promise<Kit> {
  building ??= build();
  return building;
}

async function build(): Promise<Kit> {
  // Named through a variable so the type checker does not pull the bundler's Node types into the game's sources.
  const name = 'vite';
  const vite = (await import(/* @vite-ignore */ name)) as { build: (config: object) => Promise<unknown> };
  const entry = new URL('./testkit.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const result = await vite.build({
    configFile: false,
    logLevel: 'silent',
    build: { write: false, minify: false, lib: { entry, formats: ['iife'], name: 'EcoKit' } },
  });
  const first = (Array.isArray(result) ? result[0] : result) as { output: { code: string }[] };
  return (0, eval)(`${first.output[0]?.code ?? ''}\n;EcoKit`) as Kit;
}
