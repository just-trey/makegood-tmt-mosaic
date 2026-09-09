import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  publicDir: 'reference',
  build: { target: 'es2022' },
  optimizeDeps: { exclude: ['manifold-3d'] },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 60000 },
});
