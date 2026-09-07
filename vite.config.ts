import { loadEnv, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
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
  const feedbackEndpoint = process.env.FEEDBACK_ENDPOINT || env.FEEDBACK_ENDPOINT || '';

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
      __FEEDBACK_ENDPOINT__: JSON.stringify(feedbackEndpoint),
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
    test: {
      coverage: {
        provider: 'v8',
        // Report on every source file, not just the ones some test imported. Without
        // this the never-imported UI wiring modules drop out of the table entirely and
        // the headline percentage reads far better than the code actually is.
        all: true,
        include: ['src/**/*.ts'],
        reporter: ['text', 'html'],
        /**
         * A regression ratchet, not an aspiration: every floor sits just under what the code
         * already achieves, so this never asks for a test that doesn't exist yet — it only stops
         * the number going backwards. Per-directory rather than one global figure, because a
         * single project-wide 80 would sit a tenth of a point from red and would be dominated by
         * the two areas that are deliberately low (see the tripwires below).
         *
         * Statements and branches only. Under the v8 provider `lines` is identical to
         * `statements`, and a `functions` floor would just encode that scheduler.ts and
         * viewport.ts export untested functions — noise a statements floor already catches.
         *
         * Glob floors are aggregates over their matching files, and `perFile` (which would make
         * every floor per-file instead, and fail on viewport.ts alone) must stay off. The
         * top-level numbers apply to every file on top of that, not just unmatched ones.
         *
         * To raise a floor: `npm run test:coverage`, read the actuals, edit by hand. autoUpdate
         * is off deliberately — it rewrites this file mid-run and lands surprise diffs in a PR.
         */
        thresholds: {
          autoUpdate: false,
          'src/geometry/**': { statements: 92, branches: 82 },
          'src/export/**': { statements: 95, branches: 88 },
          'src/state/**': { statements: 90, branches: 90 },
          'src/assembly/**': { statements: 88, branches: 82 },
          'src/raster/**': { statements: 93, branches: 92 },
          'src/svg/**': { statements: 80, branches: 74 },
          'src/app/**': { statements: 76, branches: 85 },
          // Tripwires, not targets — these two are low on purpose and are only here so they
          // can't quietly rot further. src/scene/ is dominated by viewport.ts, which owns the
          // WebGL renderer and needs a GL context; src/app/'s figure carries scheduler.ts, left
          // as-is by maintainer decision in #145. src/ui/ gets the widest margin of any floor
          // because one new untested panel moves it several points on its own.
          'src/scene/**': { statements: 68, branches: 76 },
          'src/ui/**': { statements: 30, branches: 72 },
          statements: 78,
          branches: 84,
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
