import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.smoke-out/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    // Type-aware linting, scoped to .ts: the .mjs and .config.js blocks below are outside
    // tsconfig's `include`, and projectService errors on files it can't find a project for.
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    // src only. tests/ imports untyped .mjs tooling behind @ts-expect-error (zonebake, harness),
    // so everything downstream of those reads as `any` and buries the real findings: 417 there
    // against 12 here. Typing that tooling is what would widen this.
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Node-run config files, not part of the browser app bundle.
    files: ['*.config.js'],
    languageOptions: { globals: globals.node },
  },
  {
    // Playwright smoke script: Node top-level, but page.evaluate/waitForFunction
    // callbacks are serialized and run in the browser, hence both global sets.
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
  {
    // Skill helper scripts — Node-only tools run by hand, never bundled.
    files: ['.claude/skills/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
);
