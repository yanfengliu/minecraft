import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// The layers of `src`, lowest first (AGENTS.md, "Invariants & boundaries"). A file may import from its own
// layer and the ones before it, and from nothing above: not the later layers, and not the wiring at the top
// (the workers, `life.ts`, `game.ts`, `main.ts`). Type-only imports count: the rule is about what a layer
// may know of, and the two violations found in review were both of types.
const LAYERS = ['core', 'world', 'sim', 'physics', 'mesh', 'render', 'player', 'ui'];
const TOP = ['workers', 'life', 'game', 'main'];
const layering = LAYERS.map((layer, i) => ({
  files: [`src/${layer}/**/*.ts`],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [{
        regex: `^(\\.\\./)+(${[...LAYERS.slice(i + 1), ...TOP].join('|')})(/|$)`,
        message: `src/${layer} may import only from ${LAYERS.slice(0, i + 1).join(', ')}: a layer imports only from the layers before it.`,
      }],
    }],
  },
}));

export default defineConfig([
  globalIgnores(['dist/**', 'output/**', 'tmp/**', 'node_modules/**', '.claude/**', 'test-results/**', 'playwright-report/**']),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
  ...layering,
]);
