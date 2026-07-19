import { defineConfig, loadEnv, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8'),
);

/**
 * Inject the Umami Cloud analytics script only when UMAMI_WEBSITE_ID is set. The website ID
 * lives in our deploy environment (a GitHub repo Variable) and a local gitignored .env, never
 * in source — so a fork builds without it and never reports to our account.
 */
function umamiBeacon(websiteId: string): Plugin {
  return {
    name: 'umami-beacon',
    transformIndexHtml() {
      return [
        {
          tag: 'script',
          attrs: {
            defer: true,
            src: 'https://cloud.umami.is/script.js',
            'data-website-id': websiteId,
          },
          injectTo: 'body',
        },
      ];
    },
  };
}

export default defineConfig(({ mode }) => {
  // Read UMAMI_WEBSITE_ID from the process env (CI passes it) or a local .env file. The empty
  // prefix lets loadEnv return non-VITE_ vars for build-time use (it isn't exposed to the client).
  const env = loadEnv(mode, process.cwd(), '');
  const umamiWebsiteId = process.env.UMAMI_WEBSITE_ID || env.UMAMI_WEBSITE_ID || '';

  return {
    // Relative base so the built site works at any GitHub Pages path
    // (https://<user>.github.io/<repo>/) without hardcoding the repo name.
    base: './',
    // Preview server config (used by scripts/smoke.mjs). host:true binds 0.0.0.0
    // so the CI Playwright container can reach it.
    preview: {
      host: true,
      port: 4173,
      strictPort: true,
    },
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version || 'dev'),
    },
    build: {
      rollupOptions: {
        // Split the rarely-changing heavy vendors into their own chunks so an app-code
        // edit doesn't force returning visitors to re-download three.js/Turf. (Manifold's
        // WASM is already kept out of the initial load via dynamic import.)
        output: {
          manualChunks: {
            three: ['three'],
            turf: ['@turf/turf'],
          },
        },
      },
    },
    plugins: umamiWebsiteId ? [umamiBeacon(umamiWebsiteId)] : [],
    optimizeDeps: {
      // manifold-3d locates its .wasm relative to the module URL; pre-bundling
      // breaks that resolution, so leave it to be served as-is in dev.
      exclude: ['manifold-3d'],
    },
  };
});
