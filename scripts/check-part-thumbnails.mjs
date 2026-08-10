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
 * The pair this check exists for: a thick cylinder and a thin disc that bolts onto it. Face-on
 * they were the same circle. Named explicitly and given its own line because it is the pair a
 * four-way average would let slide — the chair differs from everything, and that alone would
 * carry a summary number over any bar worth setting.
 */
const MATTERS = ['wheel', 'hubcap'];
/**
 * How much of the silhouette two kinds must differ over, as symmetric difference / union.
 *
 * Set from the measurements, and the numbers are worth keeping because the margin is not large.
 * Face-on, the wheel and the hubcap came in at 4.5% — the same circle, and the tech-debt item this
 * check closed. From the three-quarter camera they are 13.2%, which is a cylinder against a disc
 * and reads as one. The nearest pair of properly different parts, footrest vs hubcap, is 19.5%.
 *
 * So 10% is above the failure by 5.5 points and below the worst honest pass by 3.2. It is a low
 * bar on purpose: the wheel and the hubcap are the same diameter and one bolts onto the other, so
 * a bar set where two *unrelated* parts land would be asserting something untrue about them. If a
 * re-pack ever drops a pair under it, the answer is to look at the two thumbnails, not to move
 * this number.
 */
const MIN_DIFF = 0.1;
/**
 * Widest the boundary may ramp, in device pixels.
 *
 * 1.0 is not a tuned threshold — it is the floor. The boundary is decided on the device grid with
 * binary alpha, so no pixel is ever partially covered and every crossing is exactly one pixel
 * wide. The measurement was 2.13 / 2.03 / 2.08 / 2.04 across the four kinds beforehand (and 2.14
 * at dpr 1, 2.09 at dpr 2 — the ramp is the downscale filter's footprint, so more samples never
 * narrowed it). Anything above 1.0 here means a ramped boundary is back.
 */
const MAX_EDGE = 1.0;

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
 * Mean width, in device pixels, of the alpha ramp across the silhouette's boundary.
 *
 * This is the number that says "sharp" or "blobby", so it is the number reported. A boundary that
 * goes from opaque straight to transparent between two neighbouring device pixels measures 1. Two
 * intermediate pixels of partial alpha measure 3, which is the blur a small mark reads as soft.
 *
 * Measured along rows and columns both: every scanline is reduced to the positions where it is
 * definitely inside (alpha >= 230) or definitely outside (<= 25), and each adjacent inside/outside
 * pair contributes the gap between them. A diagonal edge reads up to sqrt(2) wider than an
 * axis-aligned one, which is why this is only ever compared against another run of itself.
 */
const OPAQUE = 230;
const CLEAR = 25;
function boundaryGradient(px, w, h) {
  const gaps = [];
  const scan = (steps, lines, at) => {
    for (let l = 0; l < lines; l++) {
      let prev = null;
      for (let s = 0; s < steps; s++) {
        const a = px[at(l, s) * 4 + 3];
        const side = a >= OPAQUE ? 'in' : a <= CLEAR ? 'out' : null;
        if (!side) continue;
        if (prev && prev.side !== side) gaps.push(s - prev.s);
        prev = { side, s };
      }
    }
  };
  scan(w, h, (y, x) => y * w + x);
  scan(h, w, (x, y) => y * w + x);
  return gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
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

/**
 * Fraction of the box where the two silhouettes don't overlap — the symmetric difference of their
 * coverage masks, over the area either one covers.
 *
 * This, not diffFraction, is the number that answers "do these read as the same object". Measured
 * before this check had it: the face-on wheel and hubcap differ in 60.2% of their *pixels* while
 * being the same circle, because the depth gradient across a disc is not the same for a 60mm-thick
 * one as for a 3mm one and almost every covered pixel shifts a little. A pixel diff therefore
 * passes for two thumbnails a user cannot tell apart, which is the failure this file replaced.
 * Outline is what a 30px picture communicates, so outline is what gets the bar.
 */
function maskDiff(a, b) {
  if (a.length !== b.length) return 1;
  let differ = 0,
    union = 0;
  for (let i = 3; i < a.length; i += 4) {
    const inA = a[i] > 127,
      inB = b[i] > 127;
    if (inA || inB) union++;
    if (inA !== inB) differ++;
  }
  return union ? differ / union : 0;
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
      t.edge = boundaryGradient(t.px, t.w, t.h);
      console.log(
        `asm:${kind}  ${t.tris}  tile ${t.tileW}px  canvas ${t.cssW}x${t.cssH} CSS  ` +
          `backing ${t.w}x${t.h}  dpr ${t.dpr}  boundary ${t.edge.toFixed(2)}px`,
      );
      if (t.edge > MAX_EDGE) {
        fail(
          `asm:${kind}: boundary resolves over ${t.edge.toFixed(2)} device px, over the ` +
            `${MAX_EDGE} bar — the silhouette reads soft`,
        );
      }
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

// Every pair, not an average over the four. The thumbnail's job is to tell the user which part
// they have; a set where three kinds differ wildly and two are the same circle fails at that for
// the two, and any four-way summary hides it behind the three.
console.log('\n— every pair of kinds: how much of the silhouette, and of the pixels, differs');
const ids = [...shots.keys()];
for (let i = 0; i < ids.length; i++) {
  for (let j = i + 1; j < ids.length; j++) {
    const [a, b] = [ids[i], ids[j]];
    const f = diffFraction(shots.get(a).px, shots.get(b).px);
    const m = maskDiff(shots.get(a).px, shots.get(b).px);
    const marked = MATTERS.includes(a) && MATTERS.includes(b);
    console.log(
      `  ${a} vs ${b}: ${(m * 100).toFixed(1)}% of the silhouette, ${(f * 100).toFixed(1)}% of ` +
        `pixels${marked ? '   <- the pair this change is for' : ''}`,
    );
    if (f === 0) fail(`asm:${a} and asm:${b} are the same image`);
    if (m < MIN_DIFF) {
      fail(
        `asm:${a} and asm:${b} have the same outline to ${(m * 100).toFixed(1)}% — under the ` +
          `${(MIN_DIFF * 100).toFixed(0)}% bar, so the thumbnail does not tell them apart`,
      );
    }
  }
}

console.log(failed ? `\nFAILED (${failed})` : '\nOK');
process.exit(failed ? 1 : 0);
