/**
 * Live verification of mirror-design on the chair body: does ticking Mirror actually cut the
 * design on the twin zone, reflected, and does a self-mirrored zone keep one half and reflect it?
 *
 * Reads the exported 3MF rather than the viewport, because the inlay solids are the thing that
 * ships. Sub-object vertices are written in the part's own file frame (src/export/threemf.ts puts
 * plate placement in the <item> transform, never in the mesh), and every chair part is packed in
 * one shared CAD frame — the same frame scripts/measure-zone-mirror.mjs reflects across x = 0. So
 * the twin part's inlay bbox is directly comparable to the negation of the right one's.
 *
 * Every assertion names the pair it is about. "Some inlay exists on the left" is exactly the
 * observation a broken mirror and a working one share, since the left flank also carries the back
 * and front zones.
 *
 * The sample badge is left-right symmetric, so on the Front (offset 0) a mirror-symmetry check
 * alone cannot tell a mirrored design from an unmirrored one. Check 2b loads an asymmetric design
 * for that half of the claim; check 2 keeps the sample so the notice text is read off the flow the
 * plan names.
 *
 * Usage:
 *   npm run build && MOSAIC_GPU=1 node scripts/check-mirror-design.mjs [outDir]
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { startPreview, launchBrowser, newPage, afterRebuild, shot } from './lib/harness.mjs';
import { eachElement, meshVerts } from './lib/mesh.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] || 'stubs/mirror-check';
mkdirSync(OUT, { recursive: true });
const PORT = 4176;

/**
 * The slack a chart's claim already carries against its triangulation. Read out of the source
 * rather than repeated here — this script runs under plain `node`, which cannot import the .ts,
 * and a copied 3 is a second constant that drifts.
 */
const TOL = (() => {
  const src = readFileSync(path.join(REPO, 'src/geometry/conformal.ts'), 'utf8');
  const m = /export const CHART_SNAP_MM = ([\d.]+)/.exec(src);
  if (!m) throw new Error('CHART_SNAP_MM is no longer declared in src/geometry/conformal.ts');
  return Number(m[1]);
})();

/** Exported part names, by the flank they carry — src/assembly/kinds.ts role names. */
const FLANK_PAIRS = [
  ['Handle (right)', 'Handle (left)'],
  ['Storage (right)', 'Storage (left)'],
  ['Wheel mount (right)', 'Wheel mount (left)'],
  ['Wing (right)', 'Wing (left)'],
];

/**
 * Parts the Front zone's charts sit on, paired with the part their reflection lands on. A part
 * that straddles x = 0 is its own partner, so its own inlay must come back symmetric.
 */
const FRONT_PAIRS = [
  ['Handle (right)', 'Handle (left)'],
  ['Storage (right)', 'Storage (left)'],
  ['Seat back (bottom)', 'Seat back (bottom)'],
  ['Seat back (top)', 'Seat back (top)'],
];

/**
 * All the ink on one side of the design's own middle, and none on the other, stopping just short
 * of the middle so nothing is clipped and no centre-line notice is owed. Blocky and full-height so
 * it survives the warp onto the Front's live surface, which the cushion covers most of.
 */
const ASYM_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <rect x="104" y="0" width="96" height="200" fill="#1e5fa8"/>
  <rect x="150" y="10" width="40" height="40" fill="#c1272d"/>
</svg>`;

const failures = [];
const fail = (msg) => {
  failures.push(msg);
  console.log(`  FAIL ${msg}`);
};
const pass = (msg) => console.log(`  ok   ${msg}`);

/* ------------------------------------------------------------------- 3MF reading */

const emptyBox = () => ({
  mn: [Infinity, Infinity, Infinity],
  mx: [-Infinity, -Infinity, -Infinity],
  n: 0,
});
function grow(b, v) {
  b.n++;
  for (let k = 0; k < 3; k++) {
    if (v[k] < b.mn[k]) b.mn[k] = v[k];
    if (v[k] > b.mx[k]) b.mx[k] = v[k];
  }
}

/**
 * Per exported part: one bbox per inlay, keyed by extruder. Extruder is the colour's identity
 * across parts (matIndexByColor in exportPanel.ts is global to the export), and extruder 1 is the
 * body by construction, so it is dropped here.
 */
async function inlayBoxes(file) {
  const zip = await JSZip.loadAsync(readFileSync(file));
  const model = await zip.file('3D/3dmodel.model').async('string');
  const cfg = await zip.file('Metadata/model_settings.config').async('string');

  const extruderOf = new Map();
  for (const [, id, body] of cfg.matchAll(/<part id="(\d+)"[^>]*>([\s\S]*?)<\/part>/g)) {
    const m = /<metadata key="extruder" value="(\d+)"\/>/.exec(body);
    if (m) extruderOf.set(id, +m[1]);
  }

  const box = new Map(); // sub-object id -> bbox
  const name = new Map(); // sub-object id -> its own name (the filament name, for reporting)
  const parts = new Map(); // part name -> [sub-object ids]
  for (const { attrs, body } of eachElement(model, 'object')) {
    if (!body) continue;
    const id = /\bid="(\d+)"/.exec(attrs)?.[1];
    const nm = /\bname="([^"]*)"/.exec(attrs)?.[1] ?? '';
    if (!id) throw new Error('3MF has an <object> with no id');
    if (body.includes('<components>')) {
      parts.set(
        nm,
        [...body.matchAll(/objectid="(\d+)"/g)].map(([, sid]) => sid),
      );
      continue;
    }
    name.set(id, nm);
    // Three boxes: the whole inlay, and its halves either side of x = 0. A part that straddles
    // the centre carries both of its design's halves in ONE sub-object, so its whole-inlay bbox
    // says nothing about whether both halves were cut — only the two half-boxes do.
    const all = emptyBox(),
      pos = emptyBox(),
      neg = emptyBox();
    for (const v of meshVerts(body)) {
      grow(all, v);
      if (v[0] > 0) grow(pos, v);
      else if (v[0] < 0) grow(neg, v);
    }
    box.set(id, { ...all, pos: pos.n ? pos : null, neg: neg.n ? neg : null });
  }

  const out = new Map();
  for (const [partName, ids] of parts) {
    const inlays = new Map();
    for (const id of ids) {
      const e = extruderOf.get(id);
      // The two files disagreeing is the bug itself; scoring it as "no inlay" would let a
      // regression that drops config entries pass every assertion below.
      if (e === undefined)
        throw new Error(`sub-object ${id} of "${partName}" has no model_settings.config entry`);
      if (e === 1) continue;
      if (inlays.has(e))
        throw new Error(
          `"${partName}" ships two inlays on extruder ${e} — one per colour expected`,
        );
      inlays.set(e, { ...box.get(id), filament: name.get(id) });
    }
    out.set(partName, inlays);
  }
  return out;
}

const fmt = (b) =>
  `x[${b.mn[0].toFixed(1)}, ${b.mx[0].toFixed(1)}] ` +
  `y[${b.mn[1].toFixed(1)}, ${b.mx[1].toFixed(1)}] ` +
  `z[${b.mn[2].toFixed(1)}, ${b.mx[2].toFixed(1)}]`;

/** Reflect a bbox across x = 0: min and max swap on x, the other two axes are untouched. */
const reflectX = (b) => ({
  mn: [-b.mx[0], b.mn[1], b.mn[2]],
  mx: [-b.mn[0], b.mx[1], b.mx[2]],
});

/** Per-corner, per-axis gap between two bboxes, in mm — the number every assertion reports. */
function gaps(a, b) {
  const g = [];
  for (let k = 0; k < 3; k++) g.push(Math.abs(a.mn[k] - b.mn[k]), Math.abs(a.mx[k] - b.mx[k]));
  return g;
}

/**
 * Assert one inlay is the reflection of another, and say by how much when it is not. `label`
 * names the pair, so a failure line is readable without the surrounding code.
 */
function assertReflected(label, right, left) {
  const want = reflectX(right);
  const g = gaps(want, left);
  const worst = Math.max(...g);
  if (worst > TOL) {
    fail(
      `${label}: worst per-axis gap ${worst.toFixed(2)}mm > ${TOL}mm\n` +
        `         right           ${fmt(right)}\n` +
        `         right reflected ${fmt(want)}\n` +
        `         left            ${fmt(left)}`,
    );
    return false;
  }
  pass(`${label}: reflected within ${worst.toFixed(2)}mm (${fmt(left)})`);
  return true;
}

/* ------------------------------------------------------------------- driving */

const warnings = (page) => page.evaluate(() => window.__mosaic.warnings());
const coverageLine = async (page) =>
  (await warnings(page)).find((w) => /zones? still blank/.test(w)) ?? null;

async function exportTo(page, file) {
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 600_000 }),
    page.click('#btn-export'),
  ]);
  await dl.saveAs(file);
  console.log(`   exported ${file}`);
  return inlayBoxes(file);
}

const inlayCount = (boxes, part) => boxes.get(part)?.size ?? 0;

/** Every part that shipped an inlay, with its per-colour boxes — the log line behind a failure. */
function describeInlays(boxes) {
  const lines = [];
  for (const [part, inlays] of boxes)
    for (const [ext, b] of inlays)
      lines.push(
        `      ${part} e${ext} ${b.filament}: ${fmt(b)}` +
          `  [+x ${b.pos ? fmt(b.pos) : 'none'}] [-x ${b.neg ? fmt(b.neg) : 'none'}]`,
      );
  return lines.length ? lines.join('\n') : '      (no inlay on any part)';
}

/**
 * Which sides of x = 0 a part took ink on at all, measured off a run with the whole design cut
 * and Mirror off. A side that carried nothing THEN cannot be held against the mirror now: that is
 * the zone's own coverage of the part, and it is the same with the feature switched off.
 */
function inkableSides(control) {
  const sides = new Map();
  for (const [part, inlays] of control) {
    const s = new Set();
    for (const b of inlays.values()) {
      if (b.pos) s.add('+x');
      if (b.neg) s.add('-x');
    }
    sides.set(part, s);
  }
  return sides;
}

/**
 * Both halves of a mirrored design, compared part by part. A pair of twin parts must carry each
 * other's reflection; a part that straddles x = 0 must carry the reflection of its own ink within
 * one inlay, which is why the halves are split by sign rather than compared as one box.
 *
 * `inkable` (optional) is the control run's answer to "which side of this part can take ink at
 * all" — see inkableSides.
 */
function compareMirrorPairs(boxes, pairs, tag, inkable) {
  let compared = 0;
  for (const [a, b] of pairs) {
    const aIn = boxes.get(a) ?? new Map();
    const bIn = boxes.get(b) ?? new Map();
    if (a === b) {
      if (aIn.size === 0) {
        pass(`${tag}: "${a}" is not reached by the design`);
        continue;
      }
      for (const [ext, bx] of aIn) {
        if (!bx.pos || !bx.neg) {
          const missing = bx.pos ? '-x' : '+x';
          if (inkable && !inkable.get(a)?.has(missing)) {
            pass(
              `${tag}: "${a}" carries ink only on the ${bx.pos ? '+x' : '-x'} side (${fmt(bx)}), ` +
                `and the Mirror-off control cut nothing on its ${missing} side either — the zone, ` +
                'not the mirror',
            );
            continue;
          }
          fail(
            `${tag}: "${a}" straddles x=0 but its extruder ${ext} (${bx.filament}) inlay has ink ` +
              `only on the ${bx.pos ? '+x' : '-x'} side: ${fmt(bx)}`,
          );
          continue;
        }
        compared++;
        assertReflected(
          `${tag}: ${a} across x=0, extruder ${ext} (${bx.filament})`,
          bx.pos,
          bx.neg,
        );
      }
      continue;
    }
    if (aIn.size === 0 && bIn.size === 0) {
      pass(`${tag}: neither "${a}" nor "${b}" is reached by the design`);
      continue;
    }
    if (aIn.size !== bIn.size)
      fail(`${tag}: "${a}" has ${aIn.size} inlay(s) but "${b}" has ${bIn.size}`);
    for (const [ext, aBox] of aIn) {
      const bBox = bIn.get(ext);
      if (!bBox) {
        fail(`${tag}: "${b}" has no inlay on extruder ${ext} (${aBox.filament})`);
        continue;
      }
      compared++;
      assertReflected(`${tag}: ${a} -> ${b}, extruder ${ext} (${aBox.filament})`, aBox, bBox);
    }
  }
  return compared;
}

/** What each artwork row is bound to right now — the state a failed placement check needs. */
const rowStates = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#artwork-list .artwork-row')].map((r) => ({
      name: r.querySelector('.artwork-name')?.textContent,
      badge: r.querySelector('.artwork-zone-badge')?.textContent,
      zone: r.querySelector('.artwork-zone')?.value,
      mirror: r.querySelector('.artwork-mirror-check')?.checked ?? null,
    })),
  );

/**
 * Tick or untick one row's Mirror box, and refuse to pretend a no-op was a toggle. Playwright's
 * check()/uncheck() are no-ops when the box already reads that way, and a no-op schedules no
 * rebuild — so afterRebuild would fail with "no rebuild ran" and hide which of the two it was.
 */
async function setMirror(page, row, on) {
  const check = row.locator('.artwork-mirror-check');
  const n = await check.count();
  if (n !== 1) throw new Error(`expected exactly one Mirror checkbox on the row, found ${n}`);
  if ((await check.isChecked()) === on) {
    console.log(`   Mirror was already ${on ? 'on' : 'off'} — nothing toggled`);
    return false;
  }
  await afterRebuild(page, () => (on ? check.check() : check.uncheck()));
  return true;
}

/**
 * The fit values a gizmo drag would move. Read either side of an orbit: a drag the gizmo took
 * changes the picture, so "the screen moved" alone reads as a successful orbit either way
 * (scripts/check-zone-occlusion.mjs found all four of these failure modes the hard way).
 */
const fitValues = (page) =>
  page.evaluate(() =>
    ['p-offset-x', 'p-offset-y', 'p-scale-num', 'p-rot']
      .map((id) => document.getElementById(id)?.value)
      .join('|'),
  );

const frameHash = () => {
  const canvas = document.querySelector('#canvas-host canvas');
  const c2 = document.createElement('canvas');
  c2.width = 64;
  c2.height = 64;
  const ctx = c2.getContext('2d');
  ctx.drawImage(canvas, 0, 0, 64, 64);
  const d = ctx.getImageData(0, 0, 64, 64).data;
  let h = 2166136261;
  for (let i = 0; i < d.length; i += 4) h = Math.imul(h ^ d[i], 16777619) >>> 0;
  return h;
};

/**
 * Make the warning pills inert for the duration of an orbit, and put them back.
 *
 * `#warnings` is `pointer-events: none` but each `.warn-pill` re-enables them, and the box spans
 * the bottom of the viewport — exactly where a drag has to start to miss the design frame. A pill
 * over the start point eats the pointerdown and OrbitControls never sees it, which shows up as the
 * "changed nothing on screen" guard firing. The pills stay visible, so the screenshots still show
 * what the app was saying.
 */
async function withInertPills(page, fn) {
  await page.addStyleTag({ content: '.warn-pill{pointer-events:none !important}' });
  try {
    return await fn();
  } finally {
    await page.evaluate(() => {
      for (const s of document.querySelectorAll('style'))
        if (s.textContent.includes('.warn-pill{pointer-events:none')) s.remove();
    });
  }
}

/** One orbit step, started from the bottom-left corner the design frame does not reach. */
async function orbit(page, box, dx, dy) {
  const before = await page.evaluate(frameHash);
  const fitBefore = await fitValues(page);
  const sx = box.x + box.width * 0.06;
  const sy = box.y + box.height * 0.94;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(sx + (dx * i) / 12, sy + (dy * i) / 12);
  await page.mouse.up();
  await page.waitForTimeout(1500); // OrbitControls damping keeps easing after release
  if ((await fitValues(page)) !== fitBefore)
    throw new Error('the orbit drag moved the DESIGN, not the camera — the gizmo took it');
  if ((await page.evaluate(frameHash)) === before)
    throw new Error('the orbit drag changed nothing on screen — a gizmo handle swallowed it');
}

/**
 * How much of the middle of the viewport each zone occupies, by the path a click takes
 * (window.__mosaic.zoneIdAtNdc). A 9x9 grid rather than the single centre pixel: one pixel lands
 * on a seam or a hole often enough that "this view faces the left flank" would come back false
 * from a view that plainly does.
 */
const zoneCounts = (page) =>
  page.evaluate(() => {
    const counts = {};
    for (let i = 0; i < 9; i++)
      for (let j = 0; j < 9; j++) {
        const id = window.__mosaic.zoneIdAtNdc(-0.6 + (1.2 * i) / 8, -0.6 + (1.2 * j) / 8);
        if (id) counts[id] = (counts[id] ?? 0) + 1;
      }
    return counts;
  });

/**
 * Orbit right round, shooting every step, then keep the frame where each wanted zone fills most of
 * the middle of the view. The file is named for what the app itself picked there, never for the
 * drag that was asked for — an orbit that lands somewhere else would otherwise ship a picture
 * named for a flank it never reached.
 */
async function sweepShots(page, box, tag, wanted, steps = 14) {
  const sweepDir = path.join(OUT, `sweep-${tag}`);
  mkdirSync(sweepDir, { recursive: true });
  const best = new Map(wanted.map((z) => [z, { count: 0, file: null }]));
  for (let i = 0; i <= steps; i++) {
    const counts = await zoneCounts(page);
    const file = `${tag}-${String(i).padStart(2, '0')}.png`;
    await shot(page, sweepDir, file);
    for (const z of wanted) {
      const c = counts[z] ?? 0;
      if (c > best.get(z).count) best.set(z, { count: c, file });
    }
    if (i < steps) await withInertPills(page, () => orbit(page, box, 90, 0));
  }
  const out = [];
  for (const [z, { count, file }] of best) {
    if (!file) {
      fail(`no view in the ${steps}-step sweep "${tag}" showed zone "${z}" at all`);
      continue;
    }
    const dest = path.join(OUT, `${tag}-${z}.png`);
    copyFileSync(path.join(sweepDir, file), dest);
    console.log(`   ${dest}: ${count}/81 of the middle of the view picks "${z}" (${file})`);
    out.push(dest);
  }
  return out;
}

/* ------------------------------------------------------------------- run */

let browser;
const preview = await startPreview({ port: PORT });
try {
  browser = await launchBrowser();
  const { page, errors } = await newPage(browser, { viewport: { width: 1280, height: 900 } });
  await page.goto(`http://localhost:${PORT}/?kind=chair-body`);
  await page.waitForFunction(
    () => {
      const t = document.querySelector('#stat-tris')?.textContent || '';
      return t !== '' && t !== '0 tris';
    },
    null,
    { timeout: 90_000 },
  );
  console.log('waiting for every chair part…');
  await page.waitForFunction(
    () => {
      const rows = [...document.querySelectorAll('#assembly-part-list .asm-sum-row')];
      return rows.length >= 13 && rows.every((r) => r.textContent.startsWith('✓'));
    },
    null,
    { timeout: 180_000 },
  );

  /* ---------------------------------------------------------- 1: Right side + Mirror */
  console.log('\n=== 1. Right side + Mirror, offset X 60 ===');
  await afterRebuild(page, async () => {
    await page.click('#btn-sample');
    await page.waitForSelector('#artwork-list .artwork-row', { timeout: 120_000 });
  });
  await afterRebuild(page, () =>
    page.selectOption('#artwork-list .artwork-row .artwork-zone', 'right'),
  );
  await afterRebuild(page, () => page.fill('#p-offset-x', '60'));

  const mirrorBefore = await page.$$('#artwork-list .artwork-row .artwork-mirror-check');
  if (mirrorBefore.length !== 1)
    throw new Error(
      `expected exactly one Mirror checkbox on the row bound to "Right side", found ${mirrorBefore.length}`,
    );
  if (await mirrorBefore[0].isChecked())
    throw new Error('Mirror was already ticked before check 1');

  const coverageUnmirrored = await coverageLine(page);
  console.log(`   coverage notice, Mirror off: ${JSON.stringify(coverageUnmirrored)}`);

  const before = await exportTo(page, path.join(OUT, 'right-before-mirror.3mf'));
  let inkedRight = 0;
  for (const [right, left] of FLANK_PAIRS) {
    const nr = inlayCount(before, right);
    const nl = inlayCount(before, left);
    inkedRight += nr;
    if (nl !== 0) fail(`before Mirror: "${left}" already carries ${nl} inlay(s)`);
    else pass(`before Mirror: "${left}" carries no inlay — ${right} has ${nr}`);
  }
  // Which right-flank parts the badge actually reaches is a placement fact, not the claim under
  // test: at 100% on offset 60 it lands on the wheel mount and the fender and misses the handle
  // and the storage box. What must hold is that the LEFT flank is bare until Mirror is ticked,
  // and that each pair matches part-for-part afterwards, empty ones included.
  if (!inkedRight) fail('before Mirror: no right-flank part carries any inlay — nothing to mirror');

  if (!(await setMirror(page, page.locator('#artwork-list .artwork-row'), true)))
    throw new Error('Mirror was already on before check 1 ticked it');
  const badge = await page.textContent('#artwork-list .artwork-row .artwork-zone-badge');
  console.log(`   badge: ${badge}`);
  const after = await exportTo(page, path.join(OUT, 'right-after-mirror.3mf'));

  let comparedFlank = 0;
  for (const [right, left] of FLANK_PAIRS) {
    const rIn = after.get(right) ?? new Map();
    const lIn = after.get(left) ?? new Map();
    if (rIn.size === 0 && lIn.size === 0) {
      pass(`after Mirror: neither "${right}" nor "${left}" is reached by the design`);
      continue;
    }
    if (lIn.size !== rIn.size)
      fail(
        `after Mirror: "${right}" has ${rIn.size} inlay(s) but its twin "${left}" has ${lIn.size}`,
      );
    for (const [ext, rBox] of rIn) {
      const lBox = lIn.get(ext);
      if (!lBox) {
        fail(`after Mirror: "${left}" has no inlay on extruder ${ext} (${rBox.filament})`);
        continue;
      }
      comparedFlank++;
      assertReflected(`${right} -> ${left}, extruder ${ext} (${rBox.filament})`, rBox, lBox);
    }
  }
  if (!comparedFlank) fail('check 1 compared no inlay pair at all');
  else console.log(`   compared ${comparedFlank} inlay pair(s)`);

  console.log('   screenshots of both flanks…');
  const box = await page.locator('#canvas-host canvas').boundingBox();
  await sweepShots(page, box, 'flanks-mirror-on', ['right', 'left']);

  /* ---------------------------------------------------------- 4: untick (before rebinding) */
  console.log('\n=== 4. Untick Mirror on the Right side case ===');
  if (!(await setMirror(page, page.locator('#artwork-list .artwork-row'), false)))
    throw new Error('Mirror was already off before check 4 unticked it');
  const unticked = await exportTo(page, path.join(OUT, 'right-mirror-unticked.3mf'));
  for (const [, left] of FLANK_PAIRS) {
    const n = inlayCount(unticked, left);
    if (n !== 0) fail(`after untick: "${left}" still carries ${n} inlay(s)`);
    else pass(`after untick: "${left}" carries no inlay`);
  }
  const coverageBack = await coverageLine(page);
  if (coverageBack !== coverageUnmirrored)
    fail(
      `after untick the coverage notice is ${JSON.stringify(coverageBack)}, ` +
        `not ${JSON.stringify(coverageUnmirrored)}`,
    );
  else pass(`coverage notice returned to ${JSON.stringify(coverageBack)}`);

  /* ---------------------------------------------------------- 2: Front + Mirror at offset 0 */
  console.log('\n=== 2. Front + Mirror, offset X 0 (sample badge) ===');
  await afterRebuild(page, () =>
    page.selectOption('#artwork-list .artwork-row .artwork-zone', 'front'),
  );
  await afterRebuild(page, () => page.fill('#p-offset-x', '0'));

  // Control, Mirror still off: what the Front cuts with the whole design, so a missing half after
  // ticking Mirror can be told apart from surface that never carried ink in the first place.
  const frontControl = await exportTo(page, path.join(OUT, 'front-mirror-off-control.3mf'));
  console.log(`   Front, Mirror OFF:\n${describeInlays(frontControl)}`);
  const frontInkable = inkableSides(frontControl);

  if (!(await setMirror(page, page.locator('#artwork-list .artwork-row'), true)))
    throw new Error('Mirror was already on when check 2 reached the Front');

  const frontWarnings = await warnings(page);
  const crossing = frontWarnings.filter(
    (w) => w.startsWith('"') && w.includes('crosses the centre line of "Front"'),
  );
  if (crossing.length !== 1)
    fail(
      `expected exactly one centre-line notice on "Front", got ${crossing.length}: ` +
        JSON.stringify(crossing),
    );
  else pass(`one centre-line notice: ${crossing[0]}`);
  const overlaps = frontWarnings.filter((w) => /overlap|cover each other/i.test(w));
  if (overlaps.length) fail(`overlap warning(s) present: ${JSON.stringify(overlaps)}`);
  else pass('no overlap warning');
  const pills = await page.$$eval('#warnings .warn-pill', (ns) => ns.map((n) => n.textContent));
  console.log(`   pills on screen: ${JSON.stringify(pills)}`);

  const front = await exportTo(page, path.join(OUT, 'front-mirror-on.3mf'));
  console.log(`   Front, Mirror ON:\n${describeInlays(front)}`);
  if (!compareMirrorPairs(front, FRONT_PAIRS, 'Front', frontInkable))
    fail('check 2 compared no inlay pair');
  await sweepShots(page, box, 'front-mirror-on', ['front']);

  /* ------------------------------------------- 2b: Front, asymmetric design, offset 0 */
  //
  // The sample badge is symmetric about its own middle, so check 2's symmetry holds whether or not
  // the design was mirrored at all. This one is not: its ink is all on one side of the design's
  // middle, so an unmirrored cut would put nothing on the other half of the Front.
  console.log('\n=== 2b. Front + Mirror, asymmetric design (the falsifying half of check 2) ===');
  const asymPath = path.join(OUT, 'asymmetric.svg');
  writeFileSync(asymPath, ASYM_SVG);
  await afterRebuild(page, async () => {
    await page.setInputFiles('#svg-input', asymPath);
    await page.waitForFunction(
      () => document.querySelectorAll('#artwork-list .artwork-row').length >= 2,
      null,
      { timeout: 120_000 },
    );
  });
  // Drop the sample, so the Front carries this design alone. Rows are matched by the name the
  // panel shows, not by position — an index would quietly drive the wrong design.
  const rowIndexNamed = async (want) => {
    const states = await rowStates(page);
    const i = states.findIndex((r) => r.name === want);
    if (i < 0) throw new Error(`no artwork row named "${want}" — rows: ${JSON.stringify(states)}`);
    return i;
  };
  const rows = page.locator('#artwork-list .artwork-row');
  await afterRebuild(page, async () =>
    rows
      .nth(await rowIndexNamed('sample-badge.svg'))
      .locator('.artwork-remove')
      .click(),
  );
  const asymRow = rows.nth(await rowIndexNamed('asymmetric.svg'));
  await afterRebuild(page, () => asymRow.locator('.artwork-zone').selectOption('front'));
  const offX = await page.inputValue('#p-offset-x');
  if (offX !== '0') fail(`check 2b expected offset X 0 on the new design, panel reads ${offX}`);
  console.log(`   rows: ${JSON.stringify(await rowStates(page))}`);

  // Mirror off first: this design inks one half of the Front and nothing on the other. If that is
  // not what the export shows, the mirrored run below proves nothing, so it is asserted here.
  const asymOff = await exportTo(page, path.join(OUT, 'front-asym-mirror-off.3mf'));
  console.log(`   Front, asymmetric, Mirror OFF:\n${describeInlays(asymOff)}`);
  const oneSided = [...asymOff].filter(([part, inlays]) =>
    [...inlays.values()].some(
      (b) => FRONT_PAIRS.some(([a, c]) => a === c && a === part) && (!b.pos || !b.neg),
    ),
  );
  const bareTwin = FRONT_PAIRS.filter(
    ([a, b]) => a !== b && (asymOff.get(a)?.size ?? 0) !== (asymOff.get(b)?.size ?? 0),
  );
  if (!oneSided.length && !bareTwin.length)
    fail(
      'check 2b: with Mirror off the asymmetric design already cut both halves of the Front, so ' +
        'the mirrored run below cannot tell a mirror from a plain cut',
    );
  else
    pass(
      `check 2b: Mirror off leaves one half bare — one-sided parts ` +
        `${JSON.stringify(oneSided.map(([p]) => p))}, unmatched twins ` +
        `${JSON.stringify(bareTwin.map(([a, b]) => `${a}/${b}`))}`,
    );

  if (!(await setMirror(page, asymRow, true)))
    throw new Error('Mirror was already on for the asymmetric design');
  const asymCross = (await warnings(page)).filter((w) =>
    w.includes('crosses the centre line of "Front"'),
  );
  // The design's ink stops at its own middle, so nothing is clipped and nothing should be said.
  if (asymCross.length)
    fail(`check 2b: unexpected centre-line notice ${JSON.stringify(asymCross)}`);
  else pass('check 2b: no centre-line notice for a design that does not cross it');

  const asymOn = await exportTo(page, path.join(OUT, 'front-asym-mirror-on.3mf'));
  console.log(`   Front, asymmetric, Mirror ON:\n${describeInlays(asymOn)}`);
  if (!compareMirrorPairs(asymOn, FRONT_PAIRS, 'Front (asymmetric)', frontInkable))
    fail('check 2b compared no inlay pair');
  await sweepShots(page, box, 'front-asym-mirror-on', ['front']);

  errors.forEach((e) => fail(`console: ${e}`));

  console.log(
    failures.length
      ? `\nFAILED: ${failures.length} check(s)\n - ${failures.join('\n - ')}`
      : '\nall checks passed.',
  );
  if (failures.length) process.exitCode = 1;
} catch (e) {
  console.error('FAILED:', e.stack || e.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  preview.stop();
  process.exit(process.exitCode ?? 0);
}
