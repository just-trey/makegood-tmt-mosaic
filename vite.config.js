import { defineConfig } from 'vite';

export default defineConfig({
  // Ensure the preview server binds to all interfaces so the Playwright
  // container can reach it. Match the port used in scripts/smoke.mjs.
  preview: {
    host: true, // true -> bind to 0.0.0.0
    port: 4173,
    strictPort: true,
  },
});
