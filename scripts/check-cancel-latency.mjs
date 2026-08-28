// Measure how long Cancel takes once the CUTTING has started, and whether repeating it leaks.
//
// The 2026-08-25 run clicked at a fixed t+10s, which landed in the 2D region pass
// (docs/findings/2026-08-25-cancel-latency.md). That phase is not this one: the curtain's readout
// runs 0-40% through regions and 40-100% through the per-part cut, so this clicks only once the
// readout is past 42%. Clicking on time is the whole measurement, and the window is short -- the
// cut phase of a 6000-region wheel is seconds against the region pass's minutes -- so the click is
// armed inside the page and fires from a rAF the moment the readout crosses. Driving it from node
// misses the window while the boolean pass holds the main thread.
//
// Rounds after the first re-enter the cut directly: `computeNetRegionsByColor` is memoized on the
// shapes array, and a depth edit does not change the shapes, so the region pass is skipped.
//
// WASM, not the JS heap: a leaked Manifold solid is memory inside the engine's WebAssembly.Memory,
// which usedJSHeapSize does not count. Emscripten's heap grows and never shrinks, so what a repeat
// can show is that it stops growing, not that it returns to where it started.
//
// Usage:
//   npm run build && MOSAIC_GPU=1 node scripts/check-cancel-latency.mjs [regions] [repeats]
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startPreview, launchBrowser, newPage } from './lib/harness.mjs';

// Software rendering caps rAF near 2.5fps (GPU_ARGS in lib/harness.mjs), and both the click and
// the latency ride on rAF, so a software run reports frame-quantised latencies around 0.4s and can
// miss the cut window outright. Refuse rather than print a number that means nothing.
if (process.env.MOSAIC_GPU !== '1')
  throw new Error('set MOSAIC_GPU=1: rAF-paced timing is meaningless software-rendered');

const REGIONS = Number(process.argv[2] || 6000);
const REPEATS = Number(process.argv[3] || 4);
// Checked before anything is started: both reach the point of failure only after a browser and a
// preview server have come up and gone down again, where a typo reads as a crash in the summary.
for (const [name, value] of [
  ['regions', REGIONS],
  ['repeats', REPEATS],
])
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
const PORT = 4176;
const OUT = 'stubs/cancel-latency';

/** N non-overlapping rects in 3 colors, the fixture shape the 2026-08-25 run used. */
function fixtureSVG(n) {
  const cols = Math.ceil(Math.sqrt(n));
  const step = 400 / cols;
  const w = step * 0.7;
  const rects = [];
  for (let i = 0; i < n; i++) {
    const x = (i % cols) * step;
    const y = Math.floor(i / cols) * step;
    const fill = ['#c1272d', '#1e5fa8', '#e8a33d'][i % 3];
    rects.push(
      `<rect x="${x.toFixed(3)}" y="${y.toFixed(3)}" width="${w.toFixed(3)}" ` +
        `height="${w.toFixed(3)}" fill="${fill}"/>`,
    );
  }
  const side = (cols * step).toFixed(3);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}">${rects.join('')}</svg>`;
}

/** Arm an in-page watcher that presses Cancel the moment the curtain says the cut is running. */
const armClick = (page) =>
  page.evaluate(() => {
    window.__cancelRun = { armedAt: performance.now() };
    const run = window.__cancelRun;
    const overlayHidden = () =>
      document.querySelector('#loading-overlay')?.style.display === 'none';
    const waitForDown = () => {
      if (overlayHidden()) run.doneAt = performance.now();
      else requestAnimationFrame(waitForDown);
    };
    let sawCurtain = false;
    const tick = () => {
      const text = document.querySelector('#loading-text')?.textContent || '';
      const pct = /(\d+)%/.exec(text);
      if (!overlayHidden()) {
        sawCurtain = true;
        if (pct && Number(pct[1]) >= 42) {
          run.readout = text;
          run.clickedAt = performance.now();
          document.querySelector('#loading-cancel').click();
          requestAnimationFrame(waitForDown);
          return;
        }
        // A rebuild that came and went without the readout reaching the cut. Recorded rather than
        // waited out: otherwise a fixture too small to be slow just hangs until a 900s timeout.
      } else if (sawCurtain || performance.now() - run.armedAt > 120_000) {
        // Either the curtain came and went below 42%, or none ever appeared: a rebuild under
        // `SLOW_REBUILD_MS` shows no curtain at all, and nothing about it would ever go hidden.
        run.missed = true;
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

const wasmBytes = (page) =>
  page.evaluate(() => (window.__wasmMem || []).reduce((s, m) => s + m.buffer.byteLength, 0));

async function main() {
  mkdirSync(OUT, { recursive: true });
  const svgPath = path.join(OUT, `wheel-${REGIONS}-regions.svg`);
  writeFileSync(svgPath, fixtureSVG(REGIONS));

  const server = await startPreview({ port: PORT });
  const browser = await launchBrowser();
  const { page, errors } = await newPage(browser);
  await page.addInitScript(() => {
    window.__wasmMem = [];
    const RealMemory = WebAssembly.Memory;
    // By exported value, not by the name `memory`: manifold-3d's glue reaches its heap as
    // `wasmExports["I"]`, so a lookup by name reported a flat 0.0 MB and measured nothing.
    const collect = (result) => {
      const exports = (result?.instance ?? result)?.exports;
      for (const value of Object.values(exports ?? {}))
        if (value instanceof RealMemory && !window.__wasmMem.includes(value))
          window.__wasmMem.push(value);
      return result;
    };
    const instantiate = WebAssembly.instantiate.bind(WebAssembly);
    WebAssembly.instantiate = (...a) => instantiate(...a).then(collect);
    const streaming = WebAssembly.instantiateStreaming?.bind(WebAssembly);
    if (streaming) WebAssembly.instantiateStreaming = (...a) => streaming(...a).then(collect);
    // Emscripten reaches its memory by any of three routes depending on the build flags.
    WebAssembly.Memory = new Proxy(RealMemory, {
      construct: (t, args) => {
        const mem = Reflect.construct(t, args);
        window.__wasmMem.push(mem);
        return mem;
      },
    });
    const RealInstance = WebAssembly.Instance;
    WebAssembly.Instance = new Proxy(RealInstance, {
      construct: (t, args) => collect(Reflect.construct(t, args)),
    });
  });

  const rows = [];
  try {
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForFunction(
      () => {
        const t = document.querySelector('#stat-tris')?.textContent || '';
        return t !== '' && t !== '0 tris';
      },
      null,
      { timeout: 120_000 },
    );

    console.log(`fixture: ${REGIONS} regions, 3 colors -> ${svgPath}`);
    for (let round = 1; round <= REPEATS; round++) {
      await armClick(page);
      if (round === 1) await page.setInputFiles('#svg-input', svgPath);
      // fill() dispatches `input`, which is the event depthPanel.ts listens on. A `change` here
      // would look like the trigger and drive nothing.
      else await page.fill('#p-depth', (1 + round * 0.05).toFixed(2));
      await page.waitForFunction(
        () => window.__cancelRun?.doneAt !== undefined || window.__cancelRun?.missed === true,
        null,
        { timeout: 900_000 },
      );
      const run = await page.evaluate(() => window.__cancelRun);
      if (run.missed)
        throw new Error(
          `round ${round}: the rebuild finished before the readout reached the cut phase. ` +
            `${REGIONS} regions is too small a fixture on this machine`,
        );
      const bytes = await wasmBytes(page);
      const ms = run.doneAt - run.clickedAt;
      // What separates "the press aborted the cut" from "the cut happened to finish just then":
      // a build that completed leaves Export enabled, a cancelled one switches it off.
      const exportOff = await page.evaluate(
        () => document.querySelector('#btn-export')?.disabled === true,
      );
      if (!exportOff)
        throw new Error(
          `round ${round}: Export is still enabled, so the build completed rather than ` +
            `being cancelled -- the click missed the cut phase`,
        );
      const reachedCut = run.clickedAt - run.armedAt;
      rows.push({ round, readout: run.readout.trim(), ms, mb: bytes / 1e6, reachedCut });
      console.log(
        `  round ${round}: cut phase reached after ${(reachedCut / 1000).toFixed(1)}s, clicked at ` +
          `"${run.readout.trim()}" -> cancelled in ${(ms / 1000).toFixed(2)}s, wasm heap ` +
          `${(bytes / 1e6).toFixed(1)} MB, export off`,
      );
    }
  } finally {
    await browser.close();
    server.stop();
  }

  const drift = rows[rows.length - 1].mb - rows[0].mb;
  console.log(
    `\nlatency: ${rows.map((r) => (r.ms / 1000).toFixed(2) + 's').join(', ')}` +
      `\nwasm heap: ${rows.map((r) => r.mb.toFixed(1) + 'MB').join(', ')}` +
      ` (round 1 to ${REPEATS}: ${(drift >= 0 ? '+' : '') + drift.toFixed(1)} MB)`,
  );
  if (errors.length) {
    console.error('\nconsole errors:\n' + errors.join('\n'));
    process.exitCode = 1;
  }
}

await main();
