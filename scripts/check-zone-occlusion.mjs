// Does a zone-pick click hit what is visible? (ui-conventions.md convention 12)
//
// Usage:
//   npm run build && node scripts/check-zone-occlusion.mjs [outDir]
//   npm run build && MOSAIC_GPU=1 node scripts/check-zone-occlusion.mjs stubs/occlusion
//
// ---------------------------------------------------------------------------
// The oracle, and why it is not a second copy of the code under test
// ---------------------------------------------------------------------------
//
// The shape to avoid (see the header of scripts/lib/harness.mjs): a success signal derived from
// something adjacent to the property being asserted. A check that answers "which zone is visible at this pixel?" by raycasting the chart
// meshes cannot fail when the raycast is what is wrong — it would agree with zonePick.ts by
// construction, including about the bug.
//
// So the oracle here is the rendered image, and it is produced by the app's own user-facing
// behaviour: bind a design to a zone and the design appears on that zone's surface. A full-bleed
// single-colour design scaled past every zone is clipped to the zone, so every pixel where that
// zone's surface is visible comes back in the design's colour, and every pixel where it is not,
// does not.
// That is "visibly nearest" in the only sense that matters to a user, and it shares nothing with
// the raycast but the chart geometry both are entitled to trust.
//
// Two passes, because they answer different halves:
//
//   * ALL-ZONES pass (one rebuild). Every zone inked at once, so an un-inked pixel means no zone
//     is visible there at all. This is the half that catches occlusion: `ink(p) == false` and
//     `pick(p) != null` is a click landing on something behind what the user can see. Probed at
//     several camera angles, because whether a handle covers the back panel is a fact about the
//     view, not about the model.
//
//   * PER-ZONE passes (one rebuild each, swept through five views). Only zone Z inked, so `ink(p)`
//     names Z specifically and the pick can be checked for identity, not just for non-null.
//
// Both traps are guarded explicitly, see GRID COVERAGE and AMBIGUITY below.
//
// NOT IN CI. It needs a browser and takes ~12 minutes on hardware acceleration, so it is a driven
// check you run by hand (`npm run check:zone-occlusion`) after touching zonePick.ts or anything
// that moves a zone chart — the same standing as check-view-fit.mjs and check-csg-failure.mjs.
// Nothing runs it for you.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startPreview, launchBrowser, newPage, glRenderer, useGpu } from './lib/harness.mjs';

const OUT = process.argv[2] || 'stubs/occlusion';
mkdirSync(OUT, { recursive: true });
const PORT = 4176;
const VIEWPORT = { width: 1440, height: 1000 };

/**
 * Full-bleed, single-colour, and deliberately NOT filling its own viewBox: a colour that covers the
 * whole canvas can be read as the artwork's background and never cut, which would leave the ink map
 * empty and every assertion below trivially true. The 2% inset keeps it a foreground shape.
 *
 * Sized in absolute mm rather than left to auto-fit. Auto-fit sizes a design to the part FACE, and
 * measured here that is well under a zone: at the Scale slider's 400% ceiling the auto-fit design
 * still gained 46 newly-inked samples over 200%, i.e. it had not finished covering. 600mm is past
 * every zone's extent at 100%, which leaves the whole slider range available to the coverage check
 * below rather than spending it getting to the surface in the first place.
 *
 * Magenta because nothing else in the scene is: the body renders neutral grey, the grid and canvas
 * are dark blue-grey, and the warning colours never reach the viewport. Classification below is by
 * hue and saturation rather than an exact match, since the inlay is lit like any other surface.
 */
const INK_HEX = '#ff00ff';
const INK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="600mm" height="600mm" viewBox="0 0 100 100">
  <rect x="2" y="2" width="96" height="96" fill="${INK_HEX}"/>
</svg>`;

/** Design scale (%) the ink maps are sampled at. */
const INK_SCALE_PCT = 200;
/** A larger scale, only ever compared against the one above — see the coverage check. */
const SCALE_HIGH_PCT = 400;
/** The bottom of the same slider: used to prove the control is live, and to orbit past the gizmo. */
const SCALE_MIN_PCT = 25;

/** Grid step in canvas device pixels. ~40x45 samples on this viewport. */
const GRID_STEP_PX = 24;
/** Square read around each grid point; a sample only carries a claim if the whole patch agrees. */
const PATCH_PX = 5;

/**
 * Camera angles for the all-zones pass, as OrbitControls drags in (dx, dy) CSS pixels.
 *
 * **Each drag continues from where the last one left the camera** — nothing here resets the view,
 * and there is no cheap way to. So these are a sweep, not four independent poses, and they are
 * named for where the sweep arrives rather than for where a drag would land from the default. An
 * earlier version of this list read as four poses from the default and paired +260 with −260,
 * which cancelled: the two were the same azimuth and the right rear was never looked at, while the
 * log claimed four viewpoints. The frame hash in orbitTo() cannot catch that — the view did change,
 * just not to the place the name promised.
 */
const ANGLES = [
  { id: 'a0-front', drag: null },
  { id: 'a1-left', drag: { dx: 260, dy: 40 } },
  { id: 'a2-rear', drag: { dx: 260, dy: 0 } },
  { id: 'a3-right', drag: { dx: 260, dy: -40 } },
];

/**
 * The widest run of unpickable pixels, in canvas device pixels, that is excused rather than failed.
 *
 * A printed part seam is a real hole in the pick surface. The chair's widest measured contact gap
 * is 0.530mm (scripts/lib/zonebake.mjs and the `_note` in scripts/zone-configs/chair-body.json —
 * `seamWeldTolMm` is 0.6, the tolerance chosen to clear that gap, not the gap itself) and each
 * part's chart
 * stops at its own edge, so a ray aimed exactly down a seam passes between the two charts, lands on
 * the far part's chart, and finds the near part's edge wall in front of it. Rejecting that is
 * geometrically correct — something solid really is in front of the chart the ray hit. But the
 * rendered pixel is dominated by the inlay either side of a 0.3px crack, so the picture says "zone
 * here" and the ray says "no". This is the oracle being unable to resolve the geometry, not the app
 * being wrong.
 *
 * 5px is not chosen to make a number pass: it is `CLICK_MOVE_TOLERANCE_PX` in zonePick.ts, the
 * pointer slop the click model already treats as the same place. A dead line narrower than that is
 * inside the aim tolerance the interaction is built on; anything wider is a region the user cannot
 * select and fails. The run width is measured and reported either way — see
 * docs/tech-debt.md, "A part seam is a hairline the zone pick can't be aimed into".
 */
const HAIRLINE_MAX_PX = 5;
/** How far out to walk looking for the far side of a null run before calling it unbounded. */
const HAIRLINE_WALK_PX = 16;

/**
 * Views the per-zone identity pass sweeps through, as cumulative orbit drags from the framed
 * default. Chosen so each of the five zones is face-on enough in at least one of them to leave an
 * interior ink sample; the two flanks are edge-on from front and back alike and need the sweep.
 */
const IDENTITY_SWEEP = [
  { id: 'v0', drag: null },
  { id: 'v1', drag: { dx: 200, dy: 0 } },
  { id: 'v2', drag: { dx: 200, dy: 0 } },
  { id: 'v3', drag: { dx: 200, dy: 0 } },
  { id: 'v4', drag: { dx: 0, dy: -140 } },
];

/**
 * The two sightings the tech-debt entry names, pinned as concrete expectations rather than left to
 * a grid to stumble into. Each is a canvas point (as a fraction of canvas size) at a named angle.
 * Both were located by running this check against the build with no occlusion test at all and
 * looking at `allzones-a1-left-flagged.png` — they are the top and bottom halves of the red run
 * down the near side of that image, not points chosen to be easy.
 *
 * `wasPick` is what the unfixed build selected there and is documentation, not an assertion: the
 * assertion is that the pixel is bare body and nothing is selected on it.
 */
const NAMED_CASES = [
  {
    name: 'handle in front of the zone behind it',
    angle: 'a1-left',
    fx: 420 / 1100,
    fy: 372 / 920,
    cls: 'body',
    expect: null,
    wasPick: 'front',
  },
  {
    name: 'storage in front of seat',
    angle: 'a1-left',
    fx: 468 / 1100,
    fy: 516 / 920,
    cls: 'body',
    expect: null,
    wasPick: 'seat',
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ page-side helpers */

/**
 * Sample the live WebGL canvas at every grid point and classify each one.
 *
 * Runs in the page rather than over a screenshot so the classification is done on the drawing
 * buffer the app actually rendered (preserveDrawingBuffer is on in viewport.ts), with no PNG
 * round-trip and no CSS-vs-device pixel confusion: everything below is in canvas device pixels,
 * which is also the space the NDC conversion uses.
 *
 * Three classes carry a claim and one does not:
 *   ink   — the design's colour. Saturated magenta, and the only saturated magenta in the scene.
 *   body  — bare part surface. Neutral: the body renders grey under white light, so a near-zero
 *           saturation is what "no design here" looks like at any brightness or shading.
 *   other — saturated and not magenta: the canvas background, the grid, and the design gizmo,
 *           which draws with depthTest off and so paints its frame and handles OVER the model.
 *           Excluded, because a gizmo pixel genuinely tells you nothing about the surface beneath
 *           it; background and grid pixels are excluded with them and cost nothing, since no chart
 *           can be in front of a part that isn't there.
 *   mixed  — see below.
 *
 * AMBIGUITY, and why it is a patch rather than a pixel. A single pixel on the boundary between
 * inlay and body is an antialiased blend of the two and is honestly neither, and the gizmo's
 * frame is a one-pixel line whose blend with the body underneath can land anywhere. So each
 * sample reads a PATCH_PX square and only carries a claim when every pixel in it agrees. A
 * disagreeing patch is 'mixed', excluded, and counted — folding those into "not ink" would
 * manufacture an occlusion failure along every edge in the scene, which is precisely the
 * ambiguous-case-indistinguishable-from-a-real-result shape this check exists to not have.
 */
function samplePageFactory() {
  return ({ step, patch, hueDeg, hueTolDeg, satInk, satBody }) => {
    const canvas = document.querySelector('#canvas-host canvas');
    const w = canvas.width,
      h = canvas.height;
    const c2 = document.createElement('canvas');
    c2.width = w;
    c2.height = h;
    const ctx = c2.getContext('2d');
    ctx.drawImage(canvas, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;

    const classOf = (px, py) => {
      const i = (py * w + px) * 4;
      const r = data[i] / 255,
        g = data[i + 1] / 255,
        b = data[i + 2] / 255;
      const max = Math.max(r, g, b),
        min = Math.min(r, g, b);
      const sat = max === 0 ? 0 : (max - min) / max;
      if (sat < satBody) return 'body';
      let hue;
      if (max === r) hue = 60 * (((g - b) / (max - min)) % 6);
      else if (max === g) hue = 60 * ((b - r) / (max - min) + 2);
      else hue = 60 * ((r - g) / (max - min) + 4);
      if (hue < 0) hue += 360;
      let dh = Math.abs(hue - hueDeg);
      if (dh > 180) dh = 360 - dh;
      return sat >= satInk && dh <= hueTolDeg ? 'ink' : 'other';
    };

    const half = patch >> 1;
    const out = [];
    for (let py = step >> 1; py < h; py += step) {
      for (let px = step >> 1; px < w; px += step) {
        let cls = null;
        for (let dy = -half; dy <= half && cls !== 'mixed'; dy++) {
          for (let dx = -half; dx <= half; dx++) {
            const x = Math.min(w - 1, Math.max(0, px + dx));
            const y = Math.min(h - 1, Math.max(0, py + dy));
            const c = classOf(x, y);
            if (cls === null) cls = c;
            else if (c !== cls) {
              cls = 'mixed';
              break;
            }
          }
        }
        out.push({
          px,
          py,
          cls,
          ndcX: ((px + 0.5) / w) * 2 - 1,
          ndcY: -(((py + 0.5) / h) * 2 - 1),
        });
      }
    }
    return { w, h, samples: out };
  };
}

/** Zone each grid point picks, by the same path a click takes (window.__mosaic.zoneIdAtNdc). */
function pickPageFactory() {
  return (pts) => pts.map((p) => window.__mosaic.zoneIdAtNdc(p.ndcX, p.ndcY));
}

/** A cheap fingerprint of the drawing buffer, for proving a camera drag actually moved something. */
function frameHashFactory() {
  return () => {
    const canvas = document.querySelector('#canvas-host canvas');
    const c2 = document.createElement('canvas');
    c2.width = 64;
    c2.height = 64;
    const ctx = c2.getContext('2d');
    ctx.drawImage(canvas, 0, 0, 64, 64);
    const d = ctx.getImageData(0, 0, 64, 64).data;
    let hash = 2166136261;
    for (let i = 0; i < d.length; i += 4) {
      hash = Math.imul(hash ^ d[i], 16777619) >>> 0;
      hash = Math.imul(hash ^ d[i + 1], 16777619) >>> 0;
      hash = Math.imul(hash ^ d[i + 2], 16777619) >>> 0;
    }
    return hash;
  };
}

/* ------------------------------------------------------------------ driving */

async function waitRebuild(page, label, timeoutMs = 900_000) {
  const t0 = Date.now();
  const overlay = (visible) =>
    page.waitForFunction(
      (want) => (document.querySelector('#loading-overlay')?.style.display === 'flex') === want,
      visible,
      { timeout: visible ? 30_000 : timeoutMs },
    );
  await overlay(true).catch(() => {});
  await overlay(false);
  await page.evaluate(() => window.__mosaic.whenIdle());
  // The render loop draws on the frame after the one that dirtied the scene; the sampler reads the
  // drawing buffer directly rather than through page.screenshot(), which would drive a frame of its
  // own, so wait for two real frames before reading pixels.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`   rebuilt: ${label} (${secs}s)`);
  return Number(secs);
}

/** Set the design scale and wait for the recut it triggers. Never re-frames the camera. */
async function setScale(page, pct, label) {
  await page.fill('#p-scale-num', String(pct));
  await page.dispatchEvent('#p-scale-num', 'change');
  await waitRebuild(page, label ?? `scale ${pct}%`);
}

/** The fit values a gizmo drag would move. Read before and after every orbit — see orbitTo. */
const fitValues = (page) =>
  page.evaluate(() =>
    ['p-offset-x', 'p-offset-y', 'p-scale-num', 'p-rot']
      .map((id) => document.getElementById(id)?.value)
      .join('|'),
  );

/**
 * Orbit by dragging on the canvas, and refuse to continue unless the camera — and only the
 * camera — moved.
 *
 * Four ways a viewport drag fails silently here, all of them hit while writing this: the design
 * gizmo claims any drag landing inside its frame, its corner handles claim drags landing on them,
 * a rebuild re-frames the camera underneath you, and — the one that actually bit — a design large
 * enough to cover every zone has a frame larger than the canvas, so there is no "outside the
 * frame" left to start from. The caller shrinks the design first (see orbitAt); the two checks
 * here are what makes that a fact rather than a hope. A drag the gizmo took moves the fit inputs
 * and would otherwise report as a successful orbit, because the screen does change.
 */
async function orbitTo(page, box, drag) {
  if (!drag) return;
  const before = await page.evaluate(frameHashFactory());
  const fitBefore = await fitValues(page);
  const sx = box.x + box.width * 0.06;
  const sy = box.y + box.height * 0.94;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(sx + (drag.dx * i) / 12, sy + (drag.dy * i) / 12);
  }
  await page.mouse.up();
  // OrbitControls' damping keeps easing for a while after release; let it settle before sampling.
  await sleep(1500);
  const after = await page.evaluate(frameHashFactory());
  const fitAfter = await fitValues(page);
  if (fitAfter !== fitBefore) {
    throw new Error(
      `orbit drag (${drag.dx}, ${drag.dy}) moved the DESIGN, not the camera (${fitBefore} -> ` +
        `${fitAfter}) — the gizmo took the gesture. Shrink the design before orbiting.`,
    );
  }
  if (before === after) {
    throw new Error(
      `orbit drag (${drag.dx}, ${drag.dy}) changed nothing on screen — the gizmo or a handle ` +
        'probably swallowed it. Any per-angle result from here would be the same angle repeated.',
    );
  }
}

/**
 * Orbit with the design shrunk out of the way, then put it back.
 *
 * The design has to be big enough to cover every zone for the ink map to mean anything, and at
 * that size its placement frame is bigger than the canvas — so the orbit gesture has nowhere to
 * land that the gizmo will not take. Scaling down for the duration of the drag is the cheapest
 * way out; it costs two recuts per angle and changes nothing about the view.
 */
async function orbitAt(page, box, drag, samplePct) {
  if (!drag) return;
  await setScale(page, SCALE_MIN_PCT, `shrink to ${SCALE_MIN_PCT}% to orbit`);
  await orbitTo(page, box, drag);
  await setScale(page, samplePct, `back to ${samplePct}%`);
}

/**
 * Screenshot with the flagged samples ringed, so a failure is a picture of where it happened
 * rather than a list of pixel coordinates nobody can place on a chair. Red = picked a zone on bare
 * body, cyan = picked nothing on a pixel showing a design.
 */
async function markShot(page, box, dir, name, marks) {
  await page.evaluate((marks) => {
    const host = document.querySelector('#canvas-host');
    const canvas = host.querySelector('canvas');
    const layer = document.createElement('div');
    layer.id = '__occl_marks';
    layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:9999';
    for (const m of marks) {
      const d = document.createElement('div');
      d.style.cssText =
        `position:absolute;left:${(m.px / canvas.width) * canvas.clientWidth - 5}px;` +
        `top:${(m.py / canvas.height) * canvas.clientHeight - 5}px;width:10px;height:10px;` +
        `border:2px solid ${m.color};border-radius:50%`;
      layer.appendChild(d);
    }
    if (!host.style.position) host.style.position = 'relative';
    host.appendChild(layer);
  }, marks);
  await page.screenshot({ path: path.join(dir, name), clip: box });
  await page.evaluate(() => document.querySelector('#__occl_marks')?.remove());
}

const CLASSIFY = {
  step: GRID_STEP_PX,
  patch: PATCH_PX,
  hueDeg: 300,
  hueTolDeg: 25,
  satInk: 0.5,
  satBody: 0.3,
};

/**
 * Ink samples with all four grid neighbours also inked.
 *
 * The ink map OVERSTATES a zone by a hair and never understates it, and the two need different
 * treatment. Overstating: a recess is a pocket, and at a grazing angle its side wall — which is the
 * inlay's colour — is visible for a pixel or two past the chart the pocket was cut in. Measured on
 * the pre-fix build, that is one sample in 1748 at one angle, on the rim of the back panel. So a
 * claim of the form "a zone is visible here, the pick must find it" is only made where the ink is
 * an interior sample.
 *
 * Understating has no equivalent mechanism — the design covers every zone (see the coverage check)
 * and the recess is cut wherever the chart is claimed — with one exception, a CSG failure leaving a
 * part uncut. That would punch a grey hole in the middle of a zone and read as a through-pick, so
 * it is checked for separately rather than absorbed here.
 */
function interiorInk(samples) {
  const at = new Map(samples.map((s) => [`${s.px},${s.py}`, s.cls]));
  const step = GRID_STEP_PX;
  return samples.filter(
    (s) =>
      s.cls === 'ink' &&
      at.get(`${s.px - step},${s.py}`) === 'ink' &&
      at.get(`${s.px + step},${s.py}`) === 'ink' &&
      at.get(`${s.px},${s.py - step}`) === 'ink' &&
      at.get(`${s.px},${s.py + step}`) === 'ink',
  );
}

/**
 * Split samples that picked nothing into ones sitting on a seam hairline and ones that name a
 * region the user genuinely cannot select. See `HAIRLINE_MAX_PX` for what a hairline is and why
 * one exists at all.
 */
async function splitHairlines(page, w, h, nulls) {
  if (!nulls.length) return { hairline: [], unreachable: [], widest: 0 };
  // One round trip: every offset either axis might need, for every null.
  const offsets = [];
  for (let d = 1; d <= HAIRLINE_WALK_PX; d++) offsets.push([-d, 0], [d, 0], [0, -d], [0, d]);
  const probes = nulls.flatMap((s) =>
    offsets.map(([dx, dy]) => ({
      ndcX: ((s.px + dx + 0.5) / w) * 2 - 1,
      ndcY: -(((s.py + dy + 0.5) / h) * 2 - 1),
    })),
  );
  const picks = await page.evaluate(pickPageFactory(), probes);
  const hairline = [];
  const unreachable = [];
  let widest = 0;
  nulls.forEach((s, i) => {
    const mine = picks.slice(i * offsets.length, (i + 1) * offsets.length);
    // Distance to the first pixel that picks, per direction; Infinity if the walk never found one.
    const reach = [0, 1, 2, 3].map((dir) => {
      for (let d = 1; d <= HAIRLINE_WALK_PX; d++) if (mine[(d - 1) * 4 + dir]) return d;
      return Infinity;
    });
    // Narrowest crossing of the run: the axis whose two sides both answer, soonest.
    const width = Math.min(reach[0] + reach[1] - 1, reach[2] + reach[3] - 1);
    if (width <= HAIRLINE_MAX_PX) {
      hairline.push({ ...s, width });
      widest = Math.max(widest, width);
    } else {
      unreachable.push({ ...s, width });
    }
  });
  return { hairline, unreachable, widest };
}

async function sampleAndPick(page) {
  const { w, h, samples } = await page.evaluate(samplePageFactory(), CLASSIFY);
  const picks = await page.evaluate(pickPageFactory(), samples);
  return { w, h, samples: samples.map((s, i) => ({ ...s, pick: picks[i] })) };
}

/* ------------------------------------------------------------------ main */

let browser;
const preview = await startPreview({ port: PORT });
const failures = [];
const report = [];
try {
  browser = await launchBrowser();
  const { page, errors } = await newPage(browser, { viewport: VIEWPORT });
  const renderer = await glRenderer(page);
  console.log(`renderer: ${renderer}${useGpu() ? '' : '   (MOSAIC_GPU not set)'}`);
  report.push(`renderer: ${renderer}`);

  await page.goto(`http://localhost:${PORT}/?kind=chair-body`);
  await page.waitForFunction(() => !!window.__mosaic);
  await page.waitForFunction(
    () => {
      const rows = [...document.querySelectorAll('#assembly-part-list .asm-sum-row')];
      return rows.length >= 13 && rows.every((r) => r.textContent.startsWith('✓'));
    },
    null,
    { timeout: 300_000 },
  );
  await page.evaluate(() => window.__mosaic.whenIdle());
  console.log('chair loaded.');

  const svgPath = path.join(OUT, 'ink.svg');
  writeFileSync(svgPath, INK_SVG);
  await page.setInputFiles('#svg-input', svgPath);
  await page.waitForSelector('#artwork-list .artwork-row', { timeout: 180_000 });
  await waitRebuild(page, 'artwork loaded');

  const zones = await page.$$eval('#artwork-list .artwork-row .artwork-zone option', (os) =>
    os.map((o) => ({ value: o.value, label: o.textContent })),
  );
  const realZones = zones.filter((z) => z.value !== '');
  console.log(`zones: ${realZones.map((z) => z.value).join(', ')}  (+ all-zones)`);

  const box = await page.locator('#canvas-host canvas').boundingBox();

  /* ---- pass 1: all zones inked, probed at every camera angle ---- */
  await page.selectOption('#artwork-list .artwork-row .artwork-zone', '');
  await waitRebuild(page, 'all zones inked');

  /* THE ORACLE'S OWN ASSUMPTION, CHECKED IN BOTH DIRECTIONS.
   *
   * Everything below rests on the design covering each zone completely, so that an un-inked body
   * pixel means "no zone here" rather than "the design didn't reach". If it does not, the ink map
   * is a map of the design instead of a map of the zones and every occlusion failure it reports is
   * fictional.
   *
   * Saturation alone is not enough to assert, because "the ink stopped growing" and "nothing I did
   * reached the app" look identical from here — the same shape as every entry under "The things
   * that check the code get audited less than the code they check". So three scales: the smallest
   * the control allows must ink visibly LESS (which is what proves the control and the rebuild are
   * live at all), and half-scale must ink exactly the same samples as full. */
  const inkAt = async (pct) => {
    await setScale(page, pct, `all zones at ${pct}%`);
    return (await sampleAndPick(page)).samples;
  };
  const small = await inkAt(SCALE_MIN_PCT);
  const sample = await inkAt(INK_SCALE_PCT);
  const higher = await inkAt(SCALE_HIGH_PCT);
  const nInk = (ss) => ss.filter((s) => s.cls === 'ink').length;
  const grew = higher.filter((s, i) => s.cls === 'ink' && sample[i].cls === 'body');
  console.log(
    `  coverage check: ink at ${SCALE_MIN_PCT}% = ${nInk(small)}, at ${INK_SCALE_PCT}% = ` +
      `${nInk(sample)}, at ${SCALE_HIGH_PCT}% = ${nInk(higher)}, newly inked ${grew.length}`,
  );
  report.push(
    `coverage: ink ${SCALE_MIN_PCT}%=${nInk(small)} ${INK_SCALE_PCT}%=${nInk(sample)} ` +
      `${SCALE_HIGH_PCT}%=${nInk(higher)} grew=${grew.length}`,
  );
  if (nInk(small) >= nInk(sample)) {
    failures.push(
      `scaling the design from ${SCALE_MIN_PCT}% to ${INK_SCALE_PCT}% did not increase the inked ` +
        `sample count (${nInk(small)} -> ${nInk(sample)}). Either the Scale control never reached ` +
        'the app or the sampler is not reading the live frame — the coverage check below is inert.',
    );
  }
  if (grew.length) {
    failures.push(
      `${grew.length} sample(s) went from bare body to inked when the design was scaled from ` +
        `${INK_SCALE_PCT}% to ${SCALE_HIGH_PCT}%, so at the sampling scale it does not yet cover ` +
        'every zone. The ink map is a map of the design, not of the zones, and no occlusion result ' +
        'below can be trusted.',
    );
  }
  await setScale(page, INK_SCALE_PCT, `sampling scale ${INK_SCALE_PCT}%`);

  /* A part that failed its boolean prints uncut, which here means a grey hole in the middle of a
   * zone — an un-inked pixel with a chart right behind it, indistinguishable from an occlusion
   * failure. Read the app's own warnings rather than inferring it from the picture. */
  const buildWarnings = await page.evaluate(() => window.__mosaic.warnings());
  const cutFailures = buildWarnings.filter((w) => /couldn't (cut|merge|read|trim)|inlay/i.test(w));
  if (cutFailures.length) {
    failures.push(
      `the ink pass warned about ${cutFailures.length} failed cut(s) — an uncut part leaves bare ` +
        `body over a zone, which reads here as an occlusion failure. First: "${cutFailures[0]}"`,
    );
  }
  report.push(
    `build warnings during ink pass: ${buildWarnings.length} (${cutFailures.length} cut)`,
  );

  let inkedTotal = 0;
  const perAngle = [];
  for (const angle of ANGLES) {
    await orbitAt(page, box, angle.drag, INK_SCALE_PCT);
    const { w, h, samples } = await sampleAndPick(page);
    await page.screenshot({ path: path.join(OUT, `allzones-${angle.id}.png`), clip: box });

    const counts = { ink: 0, body: 0, other: 0, mixed: 0 };
    const wrong = [];
    for (const s of samples) {
      counts[s.cls]++;
      if (s.cls === 'body' && s.pick !== null) wrong.push(s);
    }
    const inner = interiorInk(samples);
    const { hairline, unreachable, widest } = await splitHairlines(
      page,
      w,
      h,
      inner.filter((s) => s.pick === null),
    );
    const nulled = unreachable;
    counts.inkRim = counts.ink - inner.length;
    counts.hairline = hairline.length;
    counts.hairlineWidest = widest;
    inkedTotal += counts.ink;
    perAngle.push({ angle: angle.id, w, h, counts, wrong, nulled, samples });
    if (wrong.length || nulled.length) {
      await markShot(page, box, OUT, `allzones-${angle.id}-flagged.png`, [
        ...wrong.map((s) => ({ ...s, color: '#ff2d2d' })),
        ...nulled.map((s) => ({ ...s, color: '#00e5ff' })),
      ]);
      writeFileSync(
        path.join(OUT, `flagged-${angle.id}.json`),
        JSON.stringify(
          {
            throughPicks: wrong.map(({ px, py, pick }) => ({ px, py, pick })),
            missedPicks: nulled.map(({ px, py }) => ({ px, py })),
          },
          null,
          1,
        ),
      );
    }

    console.log(
      `  [${angle.id}] ${samples.length} samples: ink ${counts.ink} (${inner.length} interior), ` +
        `body ${counts.body}, other ${counts.other}, mixed ${counts.mixed} | ` +
        `through-picks ${wrong.length}, missed-picks ${nulled.length}` +
        (hairline.length ? `, seam hairlines ${hairline.length} (widest ${widest}px)` : ''),
    );
    // A hairline is excused, not ignored: past a few per thousand it has stopped being the seam
    // and become something the user would actually run into.
    if (hairline.length > inner.length * 0.05) {
      failures.push(
        `[${angle.id}] ${hairline.length} of ${inner.length} interior ink samples picked nothing ` +
          'and were excused as seam hairlines — too many for that explanation to hold',
      );
    }
    if (wrong.length) {
      failures.push(
        `[${angle.id}] ${wrong.length} sample(s) picked a zone on bare body, where no zone is ` +
          `visible (first: px ${wrong[0].px},${wrong[0].py} -> "${wrong[0].pick}")`,
      );
    }
    // Convention 12 has two halves and a null is a failure of the second, not a pass of the first.
    if (nulled.length) {
      failures.push(
        `[${angle.id}] ${nulled.length} sample(s) picked NOTHING on a pixel showing a zone's own ` +
          `design (first: px ${nulled[0].px},${nulled[0].py}, ${nulled[0].width}px of unpickable ` +
          'surface across) — the occlusion test is rejecting the surface it is standing on',
      );
    }
    /* GRID COVERAGE, the trap that makes a clean run meaningless. Only a sample on bare body can
     * expose the bug: it is a pixel where the user sees no zone, and the question is whether a
     * chart behind it is reachable anyway. A grid that lands on nothing but ink and background
     * passes without testing anything. */
    if (counts.body < 100) {
      failures.push(
        `[${angle.id}] only ${counts.body} sample(s) landed on bare body — too few for "no ` +
          'through-picks" to mean anything at this angle',
      );
    }
  }
  if (!inkedTotal) {
    failures.push(
      'no sample anywhere came back in the design colour — the ink map is empty, so every ' +
        'assertion above passed by default. Check the design actually cut.',
    );
  }
  report.push(
    'all-zones pass, per angle: ' +
      perAngle
        .map(
          (a) =>
            `${a.angle} ink=${a.counts.ink} body=${a.counts.body} through=${a.wrong.length} ` +
            `missed=${a.nulled.length} hairline=${a.counts.hairline}` +
            `@${a.counts.hairlineWidest}px`,
        )
        .join(', '),
  );

  /* ---- pass 2: one zone at a time, for identity ----
   * Swept round rather than done from one view: three of the five zones face away from the framed
   * default and would otherwise ink nothing and be reported as checked, and the two flanks are
   * edge-on from the front and back alike, so a narrow band of ink with no interior sample in it
   * is all either would contribute. Every zone has to land at least one interior sample somewhere
   * in the sweep or the run fails — "we never looked" must not read the same as "it was right". */
  // Back to the framed default first: pass 1 left the camera at its last angle, which is a poor
  // view for identity (it inked a third of the samples the default did).
  await page.reload();
  await page.waitForFunction(() => !!window.__mosaic);
  await page.waitForFunction(
    () => {
      const rows = [...document.querySelectorAll('#assembly-part-list .asm-sum-row')];
      return rows.length >= 13 && rows.every((r) => r.textContent.startsWith('✓'));
    },
    null,
    { timeout: 300_000 },
  );
  await page.setInputFiles('#svg-input', svgPath);
  await page.waitForSelector('#artwork-list .artwork-row', { timeout: 180_000 });
  await waitRebuild(page, 'artwork reloaded');
  await setScale(page, INK_SCALE_PCT, `sampling scale ${INK_SCALE_PCT}%`);

  const inkedPerZone = Object.fromEntries(realZones.map((z) => [z.value, 0]));
  for (const stage of IDENTITY_SWEEP) {
    await orbitAt(page, box, stage.drag, INK_SCALE_PCT);
    for (const z of realZones) {
      await page.selectOption('#artwork-list .artwork-row .artwork-zone', z.value);
      await waitRebuild(page, `zone "${z.value}" inked (${stage.id})`);
      const { samples } = await sampleAndPick(page);
      await page.screenshot({
        path: path.join(OUT, `zone-${z.value}-${stage.id}.png`),
        clip: box,
      });
      const inked = interiorInk(samples);
      const bad = inked.filter((s) => s.pick !== z.value);
      inkedPerZone[z.value] += inked.length;
      console.log(
        `  [${stage.id}/zone ${z.value}] ${inked.length} interior sample(s), ${bad.length} picked ` +
          `something else` +
          (bad.length ? ` (first -> ${bad[0].pick ?? 'null'})` : ''),
      );
      if (bad.length) {
        failures.push(
          `zone "${z.value}" (${stage.id}): ${bad.length} sample(s) showing its own design picked ` +
            `"${bad[0].pick ?? 'null'}" instead`,
        );
      }
      report.push(`zone ${z.value} (${stage.id}): interior=${inked.length} bad=${bad.length}`);
    }
  }
  for (const [zid, n] of Object.entries(inkedPerZone)) {
    if (!n) {
      failures.push(
        `zone "${zid}" produced no interior ink sample anywhere in the sweep — its identity was ` +
          'never checked, which is not the same as it being right',
      );
    }
  }

  /* ---- named cases ---- */
  for (const c of NAMED_CASES) {
    const a = perAngle.find((p) => p.angle === c.angle);
    if (!a) {
      failures.push(`named case "${c.name}": angle ${c.angle} was not sampled`);
      continue;
    }
    const px = Math.round(c.fx * a.w),
      py = Math.round(c.fy * a.h);
    const s = a.samples.reduce((best, cur) =>
      Math.hypot(cur.px - px, cur.py - py) < Math.hypot(best.px - px, best.py - py) ? cur : best,
    );
    const ok = s.pick === c.expect && s.cls === c.cls;
    console.log(
      `  [named] ${c.name}: px ${s.px},${s.py} cls=${s.cls} pick=${s.pick ?? 'null'} ` +
        `expected=${c.expect ?? 'null'} on ${c.cls} ${ok ? 'OK' : 'FAIL'}`,
    );
    report.push(
      `named ${c.name}: cls=${s.cls} pick=${s.pick ?? 'null'} expected=${c.expect ?? 'null'}`,
    );
    if (!ok) {
      failures.push(
        `named case "${c.name}": picked ${s.pick ?? 'null'} on a ${s.cls} pixel, expected ` +
          `${c.expect ?? 'null'} on ${c.cls}`,
      );
    }
  }

  // Console/page errors are a failure, not a footnote: an exception thrown mid-sweep leaves the
  // app in some other state and every assertion after it is about that state instead. Printing
  // them beside an "OK" is the same shape as the false greens in tech-debt's checker section.
  errors.forEach((e) => console.log(`  ERROR ${e}`));
  if (errors.length) {
    failures.push(`the app logged ${errors.length} error(s) during the run: ${errors[0]}`);
  }
  writeFileSync(path.join(OUT, 'report.txt'), report.join('\n') + '\n');
} catch (e) {
  failures.push(`threw: ${e.message}`);
} finally {
  if (browser) await browser.close();
  preview.stop();
}

if (failures.length) {
  console.log(`\nFAILED (${failures.length}):`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('\nOK — every sampled pixel picked the zone visible there, or nothing.');
process.exit(0);
