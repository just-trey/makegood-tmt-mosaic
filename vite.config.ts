import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8'));

export default defineConfig({
  // Relative base so the built site works at any GitHub Pages path
  // (https://<user>.github.io/<repo>/) without hardcoding the repo name.
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  optimizeDeps: {
    // manifold-3d locates its .wasm relative to the module URL; pre-bundling
    // breaks that resolution, so leave it to be served as-is in dev.
    exclude: ['manifold-3d'],
  },
});
