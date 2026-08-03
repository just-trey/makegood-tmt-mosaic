/**
 * Shared Playwright driving code for the scripts that verify the real app in a browser
 * (smoke.mjs, export-chair-examples.mjs, and ad-hoc drive scripts). One implementation on
 * purpose, matching the rationale in mesh.mjs: the process-group server kill and the
 * whenIdle() bridge both have sharp edges that must not exist in N copies and drift.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Third-party analytics beacons report to a cross-origin endpoint bound to the production
// hostname, so on localhost they CORS-fail by design — filter their console/network noise out
// of every script's error collection, not just smoke.mjs's.
const IGNORE_HOSTS = ['cloudflareinsights.com'];
const isIgnored = (text, url) =>
  IGNORE_HOSTS.some((h) => (text && text.includes(h)) || (url && url.includes(h)));

async function waitForServer(url, tries, intervalMs) {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(intervalMs);
  }
  throw new Error('preview server never came up');
}

// Build inputs, for the staleness check below. public/ is in here because the STLs and the
// filament table are copied verbatim into dist/ — swapping a part mesh changes what the app
// loads without touching a single .ts file.
const BUILD_INPUTS = ['src', 'public', 'index.html', 'vite.config.ts'];

function newestMtime(abs) {
  let st;
  try {
    st = statSync(abs);
  } catch {
    return 0; // an input that doesn't exist can't make dist/ stale
  }
  if (!st.isDirectory()) return st.mtimeMs;
  let newest = 0;
  for (const entry of readdirSync(abs)) {
    newest = Math.max(newest, newestMtime(path.join(abs, entry)));
  }
  return newest;
}

/**
 * Refuse to serve a dist/ that predates the source it was built from.
 *
 * `vite preview` serves a static snapshot — unlike the dev server it never rebuilds, so editing a
 * file and re-running a driven check silently measures the *previous* build. Nothing about that is
 * visible from the browser: the app loads, the run passes, and the numbers describe code that is
 * no longer on disk. That is the failure this repo kept hitting, and it needs no leaked process to
 * happen — a correctly started, freshly spawned preview serves stale bytes just as happily.
 *
 * The port checks below already refuse to trust a server we didn't start; this refuses to trust a
 * build we didn't make. Same idea, other half of the problem. Scripts document `npm run build &&`
 * in their headers, but a comment is not a guard.
 */
function assertFreshDist() {
  const built = newestMtime(path.join(REPO, 'dist', 'index.html'));
  if (!built) {
    throw new Error('no dist/index.html to serve — run `npm run build` first');
  }
  const stale = BUILD_INPUTS.flatMap((rel) => {
    const abs = path.join(REPO, rel);
    return newestMtime(abs) > built ? [rel] : [];
  });
  if (stale.length) {
    throw new Error(
      `dist/ is older than ${stale.join(', ')} — vite preview would serve the previous build.\n` +
        '  Run `npm run build` first, or pass { allowStaleDist: true } if you deliberately want\n' +
        '  to drive the older build.',
    );
  }
}

/**
 * Serve dist/ with `vite preview`. Defaults to owning the port outright: a leftover preview
 * (from an earlier run of this same script, or from something else entirely — this repo has hit
 * both) answers happily on the port and then every result below is of somebody else's build, not
 * the one just built. Pass `reuse: true` only when the caller has independently verified whatever
 * is already listening is the build it wants.
 *
 * Also refuses to serve a stale dist/ — see assertFreshDist above. `allowStaleDist: true` opts
 * out, for the rare caller that means it.
 */
export async function startPreview({ port = 4173, reuse = false, allowStaleDist = false } = {}) {
  if (!allowStaleDist) assertFreshDist();
  const already = await fetch(`http://localhost:${port}/`)
    .then(() => true)
    .catch(() => false);
  if (already) {
    if (!reuse) throw new Error(`port ${port} is already serving something — pick another port`);
    return { stop() {} };
  }
  const server = spawn(`npx vite preview --port ${port} --strictPort`, {
    shell: true,
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });
  // server.pid is the shell `spawn` wraps, not vite preview itself — killing just that leaks
  // the real preview process on its port. Kill the whole process group (POSIX) / tree (Windows).
  const stop = () => {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F']);
    } else {
      try {
        process.kill(-server.pid, 'SIGKILL');
      } catch {
        server.kill('SIGKILL');
      }
    }
  };
  try {
    await waitForServer(`http://localhost:${port}/`, 300, 100);
  } catch (err) {
    // No handle has escaped yet, so the caller's finally can't clean this up — and a survivor
    // holds the port, which the check at the top of this function then treats as a hard error on
    // every later run.
    stop();
    throw err;
  }
  return { stop };
}

/**
 * Chromium normally falls back to SwiftShader (CPU rasterisation) here, which is what makes the
 * browser-driven checks slow. On a WSL2 box with GPU passthrough there IS real hardware available
 * — /dev/dxg plus Mesa's d3d12 gallium driver in /usr/lib/wsl/lib — but Chromium does not pick it
 * up on its own, and neither does Mesa: it defaults to llvmpipe (also software). `GALLIUM_DRIVER`
 * is what actually selects it; `MESA_LOADER_DRIVER_OVERRIDE` alone does not.
 *
 * Opt-in via MOSAIC_GPU=1, never automatic: CI runs in the Playwright container with no GPU at
 * all, where forcing these would at best fall back and at worst fail to start a context. When it
 * is set, assertGpuActive() below refuses to let a run continue on a software renderer.
 */
const GPU_ARGS = [
  '--use-gl=angle',
  '--use-angle=gl-egl',
  '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization',
];
const useGpu = () => process.env.MOSAIC_GPU === '1';

function launchOptions() {
  if (!useGpu()) return {};
  return {
    args: GPU_ARGS,
    env: { ...process.env, GALLIUM_DRIVER: 'd3d12', LIBGL_ALWAYS_SOFTWARE: '0' },
  };
}

export async function launchBrowser() {
  return chromium.launch(launchOptions());
}

/** The GL renderer string the page actually got — for asserting GPU mode really took effect. */
export async function glRenderer(page) {
  return page.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return 'no webgl';
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
}

/**
 * MOSAIC_GPU=1 is a request, not a guarantee: a box without passthrough — or one where a WSL or
 * driver update quietly broke it — falls back to SwiftShader and you get the slow run with no
 * indication why. That silent fallback is what made this hard to diagnose in the first place, so
 * asking for GPU and not getting it is an error. The renderer string is readable before any
 * navigation, so this costs one evaluate per browser and needs no cooperation from the scripts.
 */
const SOFTWARE_RENDERERS = /swiftshader|llvmpipe|softpipe|software/i;
const gpuVerified = new WeakSet();

async function assertGpuActive(browser, page) {
  if (!useGpu() || gpuVerified.has(browser)) return;
  gpuVerified.add(browser);
  const renderer = await glRenderer(page);
  if (renderer === 'no webgl' || SOFTWARE_RENDERERS.test(renderer)) {
    throw new Error(
      `MOSAIC_GPU=1 but the browser is still rendering in software: ${renderer}\n` +
        '  Any timing taken from this run is meaningless. Check /dev/dxg exists and that\n' +
        '  /usr/lib/wsl/lib is on the loader path, or re-run without MOSAIC_GPU=1.',
    );
  }
  console.log(`   GPU: ${renderer}`);
}

/**
 * A page on an existing browser, with the console/pageerror collection every script wants, and
 * the confirm-dialog auto-accept every script that switches assembly kinds needs ("switching
 * parts will clear the loaded ones" — an unhandled dialog auto-dismisses and silently leaves the
 * old kind selected). Separate from launchPage() below so a script that drives several pages off
 * one browser (export-chair-examples.mjs: one page per printer/variant combination) doesn't pay
 * for a fresh browser process each time.
 */
export async function newPage(browser, { viewport = { width: 1280, height: 1000 } } = {}) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (isIgnored(m.text(), m.location()?.url)) return;
    errors.push('[console] ' + m.text());
  });
  page.on('pageerror', (e) => {
    if (isIgnored(e.message)) return;
    errors.push('[pageerror] ' + e.message);
  });
  page.on('dialog', (d) => void d.accept());
  await assertGpuActive(browser, page);
  return { page, errors };
}

/** Convenience for scripts that only ever need one browser and one page. */
export async function launchPage(opts = {}) {
  const browser = await launchBrowser();
  try {
    const { page, errors } = await newPage(browser, opts);
    return { browser, page, errors };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

export { useGpu };

/**
 * Wait for the app to report itself idle via src/app/idle.ts (exposed as
 * window.__mosaic.whenIdle), instead of polling DOM text for a fixed quiet window. Requires the
 * build actually expose the hook — vite-preview output does, since it's not
 * import.meta.env.DEV-gated.
 */
export async function settle(page, label, timeoutMs = 120_000) {
  const t0 = Date.now();
  const idle = page.evaluate(() => {
    const w = /** @type {any} */ (window);
    if (!w.__mosaic) throw new Error('window.__mosaic.whenIdle is not exposed by this build');
    return w.__mosaic.whenIdle();
  });
  // Timer cleared on the way out either way: the losing branch would otherwise hold the Node
  // event loop open for the rest of the timeout, so a script that returns instead of calling
  // process.exit() just sits there.
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`never settled: ${label} (>${timeoutMs}ms)`)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([idle, timeout]);
  } finally {
    clearTimeout(timer);
  }
  console.log(`   settled: ${label} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

/**
 * Block until the rebuild triggered by whatever we just clicked has actually finished.
 *
 * `#btn-export` alone is not that signal: it stays enabled from the *previous* build while the
 * next one is scheduled and running, so waiting on it returns immediately and exports stale
 * geometry — which is how a run produced files carrying the design's initial single-zone sticker
 * placement instead of the all-zones fill that had been selected. An assembly rebuild always
 * raises the "Rebuilding geometry…" curtain, so wait for it to come up (past scheduler.ts's
 * debounce) and go back down, then confirm the export button.
 *
 * settle() above is the same idea through the app's own idle counter; this one reads nothing but
 * the DOM, so it needs no cooperation from the build. Use either, but not a private copy of this:
 * the two scripts that wanted it had already drifted to different rebuild timeouts.
 */
export async function settledAfterRebuild(page, { rebuildTimeoutMs = 900_000 } = {}) {
  const overlay = (visible) =>
    page.waitForFunction(
      (want) => (document.querySelector('#loading-overlay')?.style.display === 'flex') === want,
      visible,
      { timeout: visible ? 30_000 : rebuildTimeoutMs },
    );
  // If the curtain has already been and gone we're past it; don't hang waiting to see it rise.
  await overlay(true).catch(() => {});
  await overlay(false);
  await page.waitForFunction(() => !document.querySelector('#btn-export')?.disabled, null, {
    timeout: 120_000,
  });
}

/**
 * Screenshot clipped to the canvas, so callers don't each re-derive its bounding box.
 *
 * No rAF wait before the capture, despite the render loop drawing on the frame after the one that
 * dirtied it: page.screenshot() drives a frame of its own, so the rAF our loop draws in has run by
 * the time the pixels are read. Measured under software rendering (where the gap would be a full
 * ~300ms frame) — capturing immediately after settle() and after an explicit two-rAF wait produced
 * byte-identical PNGs across three runs.
 */
export async function shot(page, dir, name) {
  const box = await page.locator('#canvas-host canvas').boundingBox();
  await page.screenshot({ path: path.join(dir, name), clip: box ?? undefined });
}
