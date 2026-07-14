import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the built site works at any GitHub Pages path
  // (https://<user>.github.io/<repo>/) without hardcoding the repo name.
  base: './',
  optimizeDeps: {
    // manifold-3d locates its .wasm relative to the module URL; pre-bundling
    // breaks that resolution, so leave it to be served as-is in dev.
    exclude: ['manifold-3d'],
  },
});
