// Drive the real app and measure the part thumbnail beside the Part dropdown, per assembly kind.
//
// It replaces a check that asserted "a canvas exists and the four kinds' images aren't all one
// value". That passed while the accent was being written in linear space, and it would pass today
// with four identical circles — "four canvases exist" is not a claim about the picture. So this
// reads the canvas back instead: its real backing store, and its actual pixels against every
// other kind's.
//
// Usage: npm run build && MOSAIC_GPU=1 node scripts/check-part-thumbnails.mjs
import { startPreview, launchBrowser, newPage, settle } from './lib/harness.mjs';

const PORT = 4176;
const KINDS = ['wheel', 'footrest', 'hubcap', 'chair-body'];
/**
 * The ratio the captures are taken at. 1.5 on purpose and not the headless default of 1: at dpr 1
 * the backing-store rule is satisfied by any code that ignores dpr entirely, so a run at 1 proves
 * nothing about it. 1.5 is also the maintainer's own display, where the softness was reported.
 */
const DPR = 1.5;
/** One fast kind is re-measured at these, so the rule reads as a rule and not as a lucky constant. */
const DPR_SWEEP = [1, 2];
const SWEEP_KIND = 'hubcap';

/**
 * Wait for the kind to finish arriving: the app's own idle counter, then the triangle readout
 * holding still — not a fixed timeout.
 *
 * The thumbnail is redrawn from the parts-changed hook, which fires once per part as an assembly
 * loads, so a capture taken mid-load reads a thumbnail drawn from a subset of the mesh (or, on a
 * kind switch, the previous kind's). Either makes two kinds that differ look identical, or two
 * identical ones look different — the exact failures this script exists to detect, arriving as a
 * false result rather than as a timeout.
 *
 * The readout hold is not enough on its own and this was measured, not assumed: the chair's 13
 * parts load one at a time, and a run gated on a 1.5s hold alone captured it at 181924 tris when
 * the finished part is 368330 — half a chair, reported as a clean pass. whenIdle() is what
 * actually knows the loads are done (assembly/parts.ts brackets each in beginWork/endWork); the
 * hold then covers the redraw that follows the last one.
 */
async function settledOnKind(page, kindId) {
  await page.waitForFunction(
    (want) => document.querySelector('#shape-kind')?.value === `asm:${want}`,
    kindId,
    {
      timeout: 120_000,
    },
  );
  await settle(page, `asm:${kindId}`);
  await page.waitForFunction(
    () => {
      const w = window;
      if (document.querySelector('#loading-overlay')?.style.display === 'flex') return false;
      const tris = document.querySelector('#stat-tris')?.textContent || '';
      if (!tris || tris === '0 tris') return false;
      if (!w.__trisHold || w.__trisHold.text !== tris) {
        w.__trisHold = { text: tris, since: performance.now() };
        return false;
      }
      return performance.now() - w.__trisHold.since >= 1500;
    },
    null,
    { timeout: 240_000, polling: 100 },
  );
}

/** The thumbnail canvas as it actually is on the page: its box, its backing store, its pixels. */
async function readThumb(page) {
  return page.evaluate(() => {
    const box = document.querySelector('#shape-thumb');
    const c = box?.querySelector('canvas');
    if (!box || !c) return null;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const r = c.getBoundingClientRect();
    return {
      dpr: devicePixelRatio,
      cssW: r.width,
      cssH: r.height,
      tileW: box.getBoundingClientRect().width,
      w: c.width,
      h: c.height,
      px: Array.from(ctx.getImageData(0, 0, c.width, c.height).data),
      tris: document.querySelector('#stat-tris')?.textContent || '',
    };
  });
}

/**
 * Fraction of pixels where two captures differ, comparing RGBA per pixel.
 *
 * The tolerance is not cosmetic. Re-reading one unchanged canvas twice on the GPU path came back
 * with a single byte off by one (measured: 1 of 8100, max delta 1) — accelerated 2D canvas
 * readback is not bit-exact. At 0 tolerance that noise reads as "the thumbnail changed"; at 2 it
 * is nothing, and a real difference between two parts is hundreds of pixels at full accent.
 */
const NOISE = 2;
function diffFraction(a, b) {
  if (a.length !== b.length) return 1;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(
      Math.abs(a[i] - b[i]),
      Math.abs(a[i + 1] - b[i + 1]),
      Math.abs(a[i + 2] - b[i + 2]),
      Math.abs(a[i + 3] - b[i + 3]),
    );
    if (d > NOISE) n++;
  }
  return n / (a.length / 4);
}

let failed = 0;
const fail = (msg) => {
  console.log(`   !! ${msg}`);
  failed++;
};

const shots = new Map();
const preview = await startPreview({ port: PORT });
let browser;
try {
  browser = await launchBrowser();
  /** Load one kind at one ratio and return its measured thumbnail, or null after reporting why. */
  const capture = async (kind, deviceScaleFactor) => {
    const { page, errors } = await newPage(browser, {
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor,
    });
    try {
      await page.goto(`http://localhost:${PORT}/?kind=${kind}`);
      await settledOnKind(page, kind);
      const t = await readThumb(page);
      if (!t) {
        fail(`asm:${kind} @dpr ${deviceScaleFactor}: no thumbnail canvas in #shape-thumb`);
        return null;
      }
      // Prove the capture wasn't mid-load rather than trusting the wait above: hold, re-read, and
      // require the same pixels. A thumbnail drawn from a subset of the mesh is still being
      // redrawn, so it does not survive this; a finished one is byte-identical.
      await page.waitForTimeout(2000);
      const again = await readThumb(page);
      const drift = again ? diffFraction(t.px, again.px) : 1;
      if (!again || again.tris !== t.tris || drift > 0) {
        fail(
          `asm:${kind}: thumbnail still changing after settle (${t.tris} -> ${again?.tris}, ` +
            `${(drift * 100).toFixed(1)}% of pixels) — the capture was mid-load`,
        );
      }
      console.log(
        `asm:${kind}  ${t.tris}  tile ${t.tileW}px  canvas ${t.cssW}x${t.cssH} CSS  ` +
          `backing ${t.w}x${t.h}  dpr ${t.dpr}`,
      );
      // The rule, stated the way it has to hold on any display: the backing store is the canvas's
      // own CSS box in device pixels. Asserted against what the page measures, not against the
      // constant in the source — reading THUMB_CSS_PX back would only prove the file compiled.
      const want = Math.round(t.cssW * t.dpr);
      if (t.w !== want || t.h !== want) {
        fail(
          `asm:${kind} @dpr ${t.dpr}: backing store ${t.w}x${t.h}, want ${want}x${want} ` +
            `(${t.cssW} CSS x ${t.dpr})`,
        );
      }
      errors.forEach((e) => fail(`asm:${kind} console: ${e}`));
      return t;
    } finally {
      await page.close();
    }
  };

  console.log(`— backing store and pixels, at dpr ${DPR}`);
  for (const kind of KINDS) {
    const t = await capture(kind, DPR);
    if (t) shots.set(kind, t);
  }

  console.log(`\n— the same rule at other ratios (asm:${SWEEP_KIND})`);
  for (const d of DPR_SWEEP) await capture(SWEEP_KIND, d);
} finally {
  if (browser) await browser.close();
  preview.stop();
}

if (shots.size !== KINDS.length)
  fail(`only ${shots.size} of ${KINDS.length} kinds produced a thumbnail`);

console.log(failed ? `\nFAILED (${failed})` : '\nOK');
process.exit(failed ? 1 : 0);
