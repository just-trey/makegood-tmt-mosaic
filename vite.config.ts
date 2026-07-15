import { defineConfig, loadEnv, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8'),
);

/**
 * Inject the Cloudflare Web Analytics beacon only when CF_BEACON_TOKEN is set. The token lives
 * in our deploy environment (a GitHub repo Variable) and a local gitignored .env, never in
 * source — so a fork builds without it and never reports to our account.
 */
function cloudflareBeacon(token: string): Plugin {
  return {
    name: 'cloudflare-beacon',
    transformIndexHtml() {
      return [
        {
          tag: 'script',
          attrs: {
            defer: true,
            src: 'https://static.cloudflareinsights.com/beacon.min.js',
            'data-cf-beacon': JSON.stringify({ token }),
          },
          injectTo: 'body',
        },
      ];
    },
  };
}

export default defineConfig(({ mode }) => {
  // Read CF_BEACON_TOKEN from the process env (CI passes it) or a local .env file. The empty
  // prefix lets loadEnv return non-VITE_ vars for build-time use (it isn't exposed to the client).
  const env = loadEnv(mode, process.cwd(), '');
  const cfToken = process.env.CF_BEACON_TOKEN || env.CF_BEACON_TOKEN || '';

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
    plugins: cfToken ? [cloudflareBeacon(cfToken)] : [],
    optimizeDeps: {
      // manifold-3d locates its .wasm relative to the module URL; pre-bundling
      // breaks that resolution, so leave it to be served as-is in dev.
      exclude: ['manifold-3d'],
    },
  };
});
