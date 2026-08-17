/**
 * Shared Playwright driving code for the scripts that verify the real app in a browser
 * (smoke.mjs, export-chair-examples.mjs, and ad-hoc drive scripts). One implementation on
 * purpose, matching the rationale in mesh.mjs: the process-group server kill and the
 * whenIdle() bridge both have sharp edges that must not exist in N copies and drift.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
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

/**
 * Wait until *our* preview is answering, not until something is.
 *
 * A bare `res.ok` accepts anything listening on the port, which is the one place a foreign server
 * and a stale build look identical — and this repo has been bitten by the stale-build half twice.
 * Comparing the served bytes against `dist/index.html` on disk turns "someone is listening" into
 * "our build is being served", which is the property every driven check actually rests on.
 */
async function waitForServer(url, tries, intervalMs) {
  const want = readFileSync(path.join(REPO, 'dist/index.html'), 'utf8');
  let sawForeign = false;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        if ((await res.text()) === want) return;
        sawForeign = true;
      }
    } catch {
      /* not up yet */
    }
    await sleep(intervalMs);
  }
  throw new Error(
    sawForeign
      ? `something is serving ${url} but it is not this repo's dist/index.html — a foreign ` +
          `server, or a preview of a different build, is on that port`
      : 'preview server never came up',
  );
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
    // `reuse` used to rest on the caller's word about which build was listening. It now rests on
    // a measurement: a reused server that is not serving this dist/ fails here rather than
    // silently supplying every later result.
    const served = await fetch(`http://localhost:${port}/`).then((r) => r.text());
    if (served !== readFileSync(path.join(REPO, 'dist/index.html'), 'utf8'))
      throw new Error(
        `port ${port} is serving something other than this repo's dist/index.html — reuse would ` +
          `drive a different build`,
      );
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
 * What software costs, measured on this box: ~300ms per frame, which also caps
 * requestAnimationFrame near 2.5fps and so stretches anything frame-paced. Driving the chair
 * end-to-end takes ~104s software against ~12s with hardware acceleration.
 *
 * Opt-in via MOSAIC_GPU=1, never automatic: CI runs in the Playwright container with no GPU at
 * all, where forcing these would at best fall back and at worst fail to start a context. When it
 * is set, assertGpuActive() below refuses to let a run continue on a software renderer.
 *
 * These flags are Chromium/WSL-specific; revisit if either the CI container image or the WSL
 * graphics stack changes.
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
 * parts will clear the loaded ones" — an unhandled prompt leaves the old kind selected). Both
 * kinds of dialog are covered; see the two handlers below, they are not interchangeable.
 * Separate from launchPage() below so a script that drives several pages off one browser
 * (export-chair-examples.mjs: one page per printer/variant combination) doesn't pay for a fresh
 * browser process each time.
 */
export async function newPage(
  browser,
  { viewport = { width: 1280, height: 1000 }, deviceScaleFactor } = {},
) {
  // Headless Chromium is devicePixelRatio 1 unless asked otherwise, so anything that sizes a
  // canvas backing store off dpr is untested by default — the maintainer's own display is 1.5.
  const page = await browser.newPage({ viewport, deviceScaleFactor });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (isIgnored(m.text(), m.location()?.url)) return;
    // With the URL: a bare "Failed to load resource: … 404" names neither the resource nor the
    // origin, and one such line failed smoke twice in 2026-08 without ever reproducing under a
    // request listener. An error a gate rejects on has to say what it was.
    const url = m.location()?.url;
    errors.push('[console] ' + m.text() + (url ? ` (${url})` : ''));
  });
  page.on('pageerror', (e) => {
    if (isIgnored(e.message)) return;
    errors.push('[pageerror] ' + e.message);
  });
  page.on('dialog', (d) => void d.accept());
  // The app's confirms are NOT native — src/ui/dialogs.ts replaced window.confirm() with a themed
  // <dialog>, which fires no 'dialog' event, so the handler above never sees the "switching parts
  // will clear the currently loaded ones" prompt. Selecting a kind then leaves the modal open and
  // the OLD kind selected, and the script goes on driving the wheel while its log says "chair".
  // Auto-accept it the same way, by clicking its OK button whenever it opens.
  //
  // Counted, not just accepted: "no confirmation was needed" and "one appeared and was silently
  // clicked away" are otherwise the same observation, so no script can assert that a destructive
  // action *did* warn, nor notice that one stopped warning. `page.confirmsAccepted()` below makes
  // that observable. Establishing the 2026-08-08 review's "switching part shape carries artwork
  // across with no confirmation" needed a run with this hook removed entirely; with the count it
  // is a normal assertion.
  await page.addInitScript(() => {
    window.__confirmsAccepted ??= 0;
    const accept = () => {
      const d = document.querySelector('#confirm-dialog');
      if (d && d.open) {
        window.__confirmsAccepted++;
        document.querySelector('#confirm-ok')?.click();
      }
    };
    const watch = () =>
      new MutationObserver(accept).observe(document.body, {
        attributes: true,
        subtree: true,
        attributeFilter: ['open'],
      });
    if (document.body) watch();
    else document.addEventListener('DOMContentLoaded', watch);
  });
  await assertGpuActive(browser, page);
  page.confirmsAccepted = () => page.evaluate(() => window.__confirmsAccepted ?? 0);
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
export async function settle(page, label, timeoutMs = 120_000, { quiet = false } = {}) {
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
  if (!quiet) console.log(`   settled: ${label} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

/**
 * Block until the rebuild triggered by whatever we just clicked has actually finished.
 *
 * `#btn-export` alone is not that signal: it stays enabled from the *previous* build while the
 * next one is scheduled and running, so waiting on it returns immediately and exports stale
 * geometry — which is how a run produced files carrying the design's initial single-zone sticker
 * placement instead of the all-zones fill that had been selected.
 *
 * The curtain is not that signal either. "The curtain never came up" and "no rebuild was ever
 * scheduled" are the same DOM observation, so waiting on it and swallowing the timeout is how a
 * caller ends up asserting against the previous state and passing. Measured before this was fixed,
 * calling this after doing nothing at all returned success after 30009ms, which reads as a slow
 * rebuild rather than a missing one, and cost two runs' debugging while check-zone-occlusion.mjs
 * was being written.
 *
 * **`rebuildsSoFar()` (src/app/idle.ts) is the authority here, and it is checked first.** It is
 * bumped once per completed rebuild, including one that threw. Waiting on it directly is what
 * makes "no rebuild ran" a distinct, accurate failure instead of a downstream Playwright timeout,
 * and it costs nothing when the caller's own wait already sat out the rebuild — the old ordering
 * burned the curtain's full 30s timeout on exactly that case, which added ~30s to every smoke run.
 *
 * The curtain and the export button are still waited on afterwards, because the counter is bumped
 * in the scheduler's `finally` *before* the overlay is hidden, so the UI trails it by a frame.
 *
 * **The baseline has to be read before the action, which is why afterRebuild() below exists.**
 * Reading it here is too late whenever the caller put a `waitForSelector` in between: that already
 * waits the rebuild out, so the count has moved before this is entered.
 */
export async function settledAfterRebuild(page, { rebuildTimeoutMs = 900_000, since } = {}) {
  if (since == null)
    throw new Error(
      'settledAfterRebuild needs a `since` baseline read before the action, or it cannot tell ' +
        '"the rebuild finished" from "no rebuild ran". Use afterRebuild(page, action).',
    );
  // Three causes, three messages. Collapsing them is the exact defect this function exists to
  // remove: a missing hook is a broken harness and a destroyed context is a crashed page, and
  // reporting either as "no rebuild ran" sends the reader somewhere else entirely.
  await page
    .waitForFunction(
      (n) => {
        const f = window.__mosaic?.rebuildsSoFar;
        if (typeof f !== 'function') throw new Error('__mosaic.rebuildsSoFar missing');
        return f() > n;
      },
      since,
      { timeout: rebuildTimeoutMs },
    )
    .catch((e) => {
      if (/rebuildsSoFar missing/.test(e.message))
        throw new Error(
          'window.__mosaic.rebuildsSoFar() is missing, so no driven check can tell whether a ' +
            'rebuild ran. Serving a build older than the counter, or main.ts stopped exposing it.',
        );
      if (!/Timeout .* exceeded/i.test(e.message)) throw e; // a crash, not a missing rebuild
      throw new Error(
        `no rebuild ran within ${rebuildTimeoutMs}ms. The action scheduled nothing, so every ` +
          'assertion after this point is about the PREVIOUS state.',
      );
    });
  // The counter bumps once per pass, and the scheduler starts a queued `dirty` follow-up before
  // releasing the current pass's idle reservation (see runNow) — so the counter alone can return
  // mid-way through a second pass. whenIdle() is the app's own signal that no pass is outstanding,
  // and it is maintained precisely so that handoff shows no zero-width gap.
  await settle(page, 'rebuild follow-up', rebuildTimeoutMs, { quiet: true });
  // The curtain is hidden after the counter bumps, so the UI trails it by a frame. Same budget as
  // the rebuild itself: a `dirty` follow-up can re-raise it, and the caller asked for that budget.
  await page.waitForFunction(
    () => document.querySelector('#loading-overlay')?.style.display !== 'flex',
    null,
    { timeout: rebuildTimeoutMs },
  );
  await page.waitForFunction(() => !document.querySelector('#btn-export')?.disabled, null, {
    timeout: 120_000,
  });
}

/** The app's completed-rebuild count, or null on a build that predates it. */
export async function rebuildCount(page) {
  return page.evaluate(() => window.__mosaic?.rebuildsSoFar?.() ?? null);
}

/**
 * Run `action`, then block until the rebuild it triggered has finished — and fail if it triggered
 * none.
 *
 * This is settledAfterRebuild() with the baseline read at the only moment it is meaningful: before
 * the action. Taking the action as an argument is what makes that correct by construction rather
 * than by the caller remembering.
 *
 * Measured on the wheel: a real rebuild returns in ~0.6s, and a no-op action throws after exactly
 * `rebuildTimeoutMs` with the accurate message. Only the failing path is slow, which is the right
 * way round: the ordering this replaced spent the curtain's full 30s timeout on every *successful*
 * call whose action had already waited the rebuild out, and that alone was ~90s of a smoke run.
 */
export async function afterRebuild(page, action, opts = {}) {
  const since = await rebuildCount(page);
  if (since === null)
    throw new Error(
      'window.__mosaic.rebuildsSoFar() is missing, so this run cannot tell whether an action ' +
        'triggered a rebuild. The served build predates the counter — rebuild dist/.',
    );
  await action();
  return settledAfterRebuild(page, { ...opts, since });
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
