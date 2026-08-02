/**
 * Shared Playwright driving code for the scripts that verify the real app in a browser
 * (smoke.mjs, export-chair-examples.mjs, and ad-hoc drive scripts). One implementation on
 * purpose, matching the rationale in mesh.mjs: the process-group server kill and the
 * whenIdle() bridge both have sharp edges that must not exist in N copies and drift.
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { chromium } from 'playwright';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/**
 * Serve dist/ with `vite preview`. Defaults to owning the port outright: a leftover preview
 * (from an earlier run of this same script, or from something else entirely — this repo has hit
 * both) answers happily on the port and then every result below is of somebody else's build, not
 * the one just built. Pass `reuse: true` only when the caller has independently verified whatever
 * is already listening is the build it wants.
 */
export async function startPreview({ port = 4173, reuse = false } = {}) {
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
  await waitForServer(`http://localhost:${port}/`, 300, 100);
  return {
    // server.pid is the shell `spawn` wraps, not vite preview itself — killing just that leaks
    // the real preview process on its port. Kill the whole process group (POSIX) / tree (Windows).
    stop() {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F']);
      } else {
        try {
          process.kill(-server.pid, 'SIGKILL');
        } catch {
          server.kill('SIGKILL');
        }
      }
    },
  };
}

/**
 * Chromium normally falls back to SwiftShader (CPU rasterisation) here, which is what makes the
 * browser-driven checks slow. On a WSL2 box with GPU passthrough there IS real hardware available
 * — /dev/dxg plus Mesa's d3d12 gallium driver in /usr/lib/wsl/lib — but Chromium does not pick it
 * up on its own, and neither does Mesa: it defaults to llvmpipe (also software). `GALLIUM_DRIVER`
 * is what actually selects it; `MESA_LOADER_DRIVER_OVERRIDE` alone does not.
 *
 * Opt-in via MOSAIC_GPU=1, never automatic: CI runs in the Playwright container with no GPU at
 * all, where forcing these would at best fall back and at worst fail to start a context. Verify a
 * machine with `MOSAIC_GPU=1` and check the renderer string is not SwiftShader/llvmpipe before
 * trusting any timing taken with it.
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
  return { page, errors };
}

/** Convenience for scripts that only ever need one browser and one page. */
export async function launchPage(opts = {}) {
  const browser = await launchBrowser();
  const { page, errors } = await newPage(browser, opts);
  return { browser, page, errors };
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
  const timeout = sleep(timeoutMs).then(() => {
    throw new Error(`never settled: ${label} (>${timeoutMs}ms)`);
  });
  await Promise.race([idle, timeout]);
  console.log(`   settled: ${label} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

/** Screenshot clipped to the canvas, so callers don't each re-derive its bounding box. */
export async function shot(page, dir, name) {
  const box = await page.locator('#canvas-host canvas').boundingBox();
  await page.screenshot({ path: path.join(dir, name), clip: box ?? undefined });
}
