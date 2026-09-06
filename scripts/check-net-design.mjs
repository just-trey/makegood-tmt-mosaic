/**
 * Live verification of the whole-part sheet (the net) on the chair body: does a design bound to
 * "Whole chair" cut across the flank/back seam as one mark, cut exactly once inside the canvas
 * the two sheets share, leave a detached sheet alone, and go back to per-zone behaviour when the
 * binding changes?
 *
 * Reads the exported 3MF rather than the viewport, because the inlay solids are what ships. Every
 * assertion is against a 3D position predicted from the sidecar, never against "some inlay
 * exists": on this chair the flank and the back seam INSIDE one printed part (Handle (left) and
 * Storage (left) carry both zones), so "an inlay is on a flank part and on a back part" is a
 * claim a broken partition and a working one both satisfy. Where the two sheets disagree they
 * disagree by tens of mm, so the predicted point is what tells them apart.
 *
 * The prediction is the sidecar's own chart triangles resolved against the packed part meshes —
 * the same numbers src/geometry/zoneCharts.ts reconstructs a mapper from, read here through the
 * shared reader in lib/mesh.mjs. Sub-object vertices are written in the part's own file frame
 * (src/export/threemf.ts puts plate placement in the <item> transform, never in the mesh), which
 * is that same packed frame, so a predicted point and an exported vertex are directly comparable.
 *
 * Usage:
 *   npm run build && MOSAIC_GPU=1 node scripts/check-net-design.mjs [outDir]
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { startPreview, launchBrowser, newPage, afterRebuild, shot } from './lib/harness.mjs';
import { eachElement, meshVerts, modelXML } from './lib/mesh.mjs';
import {
  chartTriangles,
  netPoint,
  netToZoneUV,
  zoneUVToNet,
  seamContinuity,
  SURVEY_U_STEP_MM,
  surveyBoundary,
} from './lib/netseam.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] || 'stubs/net-check';
mkdirSync(OUT, { recursive: true });
const PORT = 4177;

/**
 * How far a predicted surface point may sit from the nearest exported inlay vertex and still count
 * as inked. Not a tolerance on the geometry: the inlay is a recessed solid whose top face is
 * triangulated coarsely, so a point on the surface is only ever near a vertex, and the mark's own
 * half-width (4mm on the bar below) puts its edge vertices that far from its centreline. Anything
 * this check is built to catch — a half of the mark cut on the wrong sheet — misses by 28mm or
 * more (measured along the whole left/back boundary; see the report from this script).
 */
const INK_NEAR_MM = 6;

/** And how far a point must be from every inlay vertex to count as NOT inked. */
const INK_CLEAR_MM = 12;

/** Step along a mark's centreline when sampling it. Small, so a jump is the seam, not the walk. */
const WALK_MM = 0.25;

const failures = [];
const fail = (msg) => {
  failures.push(msg);
  console.log(`  FAIL ${msg}`);
};
const pass = (msg) => console.log(`  ok   ${msg}`);

/* ------------------------------------------------------- the net, as the sidecar records it */

const sidecar = JSON.parse(
  readFileSync(path.join(REPO, 'public/stl/chair-body-zones.json'), 'utf8'),
);
if (sidecar.schema !== 5)
  throw new Error(`this check reads schema 5; the shipped sidecar is schema ${sidecar.schema}`);
const NET = sidecar.net;
if (!NET) throw new Error('the shipped chair sidecar has no net — nothing to check');
const NET_CENTRE = [
  (NET.bounds.minU + NET.bounds.maxU) / 2,
  (NET.bounds.minV + NET.bounds.maxV) / 2,
];

const partVertCache = new Map();
async function partVertices(libraryPartId) {
  if (partVertCache.has(libraryPartId)) return partVertCache.get(libraryPartId);
  const xml = await modelXML(readFileSync(path.join(REPO, `public/stl/${libraryPartId}.3mf`)));
  const out = [];
  // Packed-file order across every <object>, which is the order load3MF builds its vertex list in
  // and therefore the order the sidecar's `verts` indices are against.
  for (const { body } of eachElement(xml, 'object')) {
    if (!body) continue;
    for (const v of meshVerts(body)) out.push(v);
  }
  partVertCache.set(libraryPartId, out);
  return out;
}

/**
 * The net's sheets, in the form scripts/lib/netseam.mjs measures: chart triangles carrying both
 * spaces, the sheet's place on the canvas, and the canvas it yields to its neighbours.
 */
async function buildSheets() {
  const sheets = new Map();
  for (const zoneId of Object.keys(NET.zones)) {
    const zone = sidecar.zones.find((z) => z.id === zoneId);
    if (!zone) throw new Error(`the sidecar has no zone "${zoneId}"`);
    const verts = new Map();
    for (const c of zone.charts)
      if (!verts.has(c.libraryPartId))
        verts.set(c.libraryPartId, await partVertices(c.libraryPartId));
    sheets.set(zoneId, {
      tris: chartTriangles(zone.charts, (c) => verts.get(c.libraryPartId)),
      place: NET.zones[zoneId],
      excluded: NET.zones[zoneId].excluded,
    });
  }
  return sheets;
}

/* ------------------------------------------------------------------- 3MF reading */

/**
 * Per exported part: the inlay vertices, flat, by extruder. Extruder is the colour's identity
 * across parts (matIndexByColor in exportPanel.ts is global to the export) and extruder 1 is the
 * body by construction, so it is dropped.
 */
async function inlayPoints(file) {
  const zip = await JSZip.loadAsync(readFileSync(file));
  const model = await zip.file('3D/3dmodel.model').async('string');
  const cfg = await zip.file('Metadata/model_settings.config').async('string');

  const extruderOf = new Map();
  for (const [, id, body] of cfg.matchAll(/<part id="(\d+)"[^>]*>([\s\S]*?)<\/part>/g)) {
    const m = /<metadata key="extruder" value="(\d+)"\/>/.exec(body);
    if (m) extruderOf.set(id, +m[1]);
  }

  const verts = new Map(); // sub-object id -> [[x,y,z], …]
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
    verts.set(id, [...meshVerts(body)]);
  }

  const out = [];
  for (const [partName, ids] of parts)
    for (const id of ids) {
      const e = extruderOf.get(id);
      // The two files disagreeing is the bug itself; scoring it as "no inlay" would let a
      // regression that drops config entries pass every assertion below.
      if (e === undefined)
        throw new Error(`sub-object ${id} of "${partName}" has no model_settings.config entry`);
      if (e === 1) continue;
      out.push({ part: partName, extruder: e, points: verts.get(id) ?? [] });
    }
  return out;
}

/** Nearest inlay vertex to a point, over every part — with the part it belongs to. */
function nearestInk(inlays, P) {
  let best = Infinity,
    where = null;
  for (const inlay of inlays)
    for (const q of inlay.points) {
      const d = Math.hypot(q[0] - P[0], q[1] - P[1], q[2] - P[2]);
      if (d < best) {
        best = d;
        where = inlay;
      }
    }
  return { d: best, part: where?.part ?? null, extruder: where?.extruder ?? null };
}

const fmtP = (P) => `(${P.map((n) => n.toFixed(1)).join(', ')})`;

/* ------------------------------------------------------------------- the designs */

/**
 * Marks with a declared physical size, so `designMmPerUnit`'s rect branch converts one user unit
 * to one mm and the footprints below are the mm they say. A single flat colour: the partition is
 * about where ink lands, not about how many slots it costs.
 */
const svg = (w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">${body}</svg>`;

/** 44 x 8mm bar, long enough to straddle the flank/back seam with room either side of it. */
const BAR_W = 44,
  BAR_H = 8;
const BAR_SVG = svg(
  BAR_W,
  BAR_H,
  `<rect x="0" y="0" width="${BAR_W}" height="${BAR_H}" fill="#1e5fa8"/>`,
);
/** 10mm square, small enough to sit wholly inside one patch of shared canvas. */
const DOT_SVG = svg(10, 10, '<rect x="0" y="0" width="10" height="10" fill="#c1272d"/>');
/** 20mm square for a detached sheet — the fender's own sheet is only 44.5mm wide. */
const PAD_SVG = svg(20, 20, '<rect x="0" y="0" width="20" height="20" fill="#1e8a3f"/>');

/* ------------------------------------------------------------------- driving */

const warnings = (page) => page.evaluate(() => window.__mosaic.warnings());
const netNotices = async (page) => (await warnings(page)).filter((w) => /whole-part sheet/.test(w));
/** The straddle warning, which names the sheets rather than the sheet, so it reads differently. */
const tornWarnings = async (page) => (await warnings(page)).filter((w) => /do not join/.test(w));

async function exportTo(page, file) {
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 600_000 }),
    page.click('#btn-export'),
  ]);
  await dl.saveAs(file);
  console.log(`   exported ${file}`);
  return inlayPoints(file);
}

const rowStates = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#artwork-list .artwork-row')].map((r) => ({
      name: r.querySelector('.artwork-name')?.textContent,
      badge: r.querySelector('.artwork-zone-badge')?.textContent,
      zone: r.querySelector('.artwork-zone')?.value,
    })),
  );

/** Load one SVG and leave it as the only artwork, bound and placed as asked. */
async function useDesign(page, file, contents, { zone, offX, offY }) {
  writeFileSync(file, contents);
  await afterRebuild(page, async () => {
    await page.setInputFiles('#svg-input', file);
    await page.waitForSelector('#artwork-list .artwork-row', { timeout: 120_000 });
  });
  const rows = page.locator('#artwork-list .artwork-row');
  const want = path.basename(file);
  // Drop every other row, so the export carries this mark alone. Matched by the name the panel
  // shows rather than by index — an index would quietly drive the wrong design.
  for (;;) {
    const states = await rowStates(page);
    const i = states.findIndex((r) => r.name !== want);
    if (i < 0) break;
    await afterRebuild(page, () => rows.nth(i).locator('.artwork-remove').click());
  }
  await setZone(page, zone);
  await afterRebuild(page, () => page.fill('#p-offset-x', offX.toFixed(3)));
  await afterRebuild(page, () => page.fill('#p-offset-y', offY.toFixed(3)));
  console.log(`   rows: ${JSON.stringify(await rowStates(page))}`);
}

async function setZone(page, zone) {
  const sel = page.locator('#artwork-list .artwork-row .artwork-zone');
  if ((await sel.inputValue()) === zone) return;
  await afterRebuild(page, () => sel.selectOption(zone));
}

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

const fitValues = (page) =>
  page.evaluate(() =>
    ['p-offset-x', 'p-offset-y', 'p-scale-num', 'p-rot']
      .map((id) => document.getElementById(id)?.value)
      .join('|'),
  );

/**
 * Make the warning pills inert for the duration of an orbit, and put them back. `#warnings` is
 * `pointer-events: none` but each `.warn-pill` re-enables them, and the box spans the bottom of
 * the viewport — exactly where a drag has to start to miss the design frame.
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

/** How much of the middle of the viewport each zone occupies, by the path a click takes. */
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
 * Orbit right round, shooting every step, and keep the frame where every named zone is at once
 * most of the middle of the view — two of them is the storage-box corner, where the flank and the
 * back sheets meet; one is just the best look at that sheet. Named for what the app itself picked
 * there, never for the drag that was asked for.
 */
async function cornerShot(page, box, tag, wanted, steps = 14) {
  const sweepDir = path.join(OUT, `sweep-${tag}`);
  mkdirSync(sweepDir, { recursive: true });
  // Dolly in first. At the fit-to-model distance the mark is a dozen pixels, which is not a
  // picture anyone can judge a CSG failure from — the whole point of shooting it.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(800);
  let best = { score: -1, file: null, counts: null };
  for (let i = 0; i <= steps; i++) {
    const counts = await zoneCounts(page);
    const file = `${tag}-${String(i).padStart(2, '0')}.png`;
    await shot(page, sweepDir, file);
    const score = Math.min(...wanted.map((z) => counts[z] ?? 0));
    if (score > best.score) best = { score, file, counts };
    if (i < steps) await withInertPills(page, () => orbit(page, box, 90, 0));
  }
  if (!best.file || best.score === 0) {
    fail(
      `no view in the ${steps}-step sweep "${tag}" showed ${wanted.map((z) => `"${z}"`).join(' and ')}`,
    );
    return null;
  }
  const dest = path.join(OUT, `${tag}-corner.png`);
  copyFileSync(path.join(sweepDir, best.file), dest);
  console.log(
    `   ${dest}: ${best.score}/81 of the middle picks ${wanted.map((z) => `"${z}"`).join(' and ')} ` +
      `(${JSON.stringify(best.counts)}, ${best.file})`,
  );
  return dest;
}

/* ------------------------------------------------------------------- run */

const sheets = await buildSheets();
const zoneName = (id) => sidecar.zones.find((z) => z.id === id)?.name ?? id;

/**
 * Where each mark goes, in net mm. Chosen off the sidecar, not off the app: `seam` sits on the
 * stretch of the left/back boundary where the two sheets really do meet in 3D (the script prints
 * the walk, so a rebake that moves the seam shows up as a failure here rather than as a quietly
 * weaker check), `share` sits inside canvas the flank yields to the back, and `fender` sits on a
 * detached sheet.
 */
const SPOT = {
  seam: [11, 300],
  share: [40, 100],
  fender: [-520, -14],
};
const offsetFor = (spot) => ({
  offX: spot[0] - NET_CENTRE[0],
  offY: spot[1] - NET_CENTRE[1],
});

/**
 * The counterpart to `SPOT.seam`, read off the survey below rather than written down: the torn row
 * of the same boundary nearest this net v, so the bar crosses where the two sheets abut without
 * joining. Not a constant, because the one thing it must be is torn — a spot fixed by hand goes
 * quietly continuous on a rebake that moves the join, and the check then proves nothing.
 */
const TORN_TARGET_V = 100;
let tornRow = null;

console.log(`net centre ${NET_CENTRE.map((n) => n.toFixed(2)).join(', ')}`);

console.log('\n--- survey: the whole "Left side"/"Back" boundary, row by row');
{
  // The same measurement the bake writes into the sidecar, re-derived here against the shipped
  // file: check 1 places one bar at one spot, and a spot chosen off a passing measurement proves
  // only that the spot passes. This says how much of the boundary would have passed.
  // The same window the bake surveys — the whole canvas — or the two would be measuring different
  // boundaries and the comparison below would mean nothing.
  const rows = surveyBoundary(sheets, 'left', 'back', {
    uFrom: NET.bounds.minU,
    uTo: NET.bounds.maxU,
    vFrom: NET.bounds.minV,
    vTo: NET.bounds.maxV,
  });
  const got = seamContinuity(rows, NET.zones.left.seamResidualMm.p95 + SURVEY_U_STEP_MM);
  const gaps = rows.map((r) => r.canvasGap).sort((x, y) => x - y);
  console.log(
    `   ${rows.length} rows 2mm apart; canvas gap median ${gaps[rows.length >> 1].toFixed(2)}mm; ` +
      `3D jump median ${got.jumpMm.median.toFixed(2)}mm p95 ${got.jumpMm.p95.toFixed(2)}mm ` +
      `max ${got.jumpMm.max.toFixed(2)}mm`,
  );
  if (!got.met)
    fail('the two sheets do not meet in 3D anywhere along their boundary — check 1 has no seam');
  else
    console.log(
      `   ${got.met}/${got.rows} rows cross within the registration bar, over net v ` +
        `${got.vFrom.toFixed(1)}..${got.vTo.toFixed(1)}`,
    );

  // And the same numbers as the sidecar's own record of them, so a rebake that moves the seam
  // fails here rather than leaving the template drawing a stretch that is no longer continuous.
  const baked = NET.zones.left.seamContinuity;
  // The sidecar rounds to 3 decimals, so that is the bar: anything looser would let a real drift
  // through, and anything tighter fails on the rounding itself.
  const SIDECAR_ROUNDING_MM = 5e-4;
  const off = (a, b) => Math.abs(a - b) > SIDECAR_ROUNDING_MM;
  if (!baked) fail('the sidecar records no seamContinuity for the "left" sheet');
  else if (
    baked.met !== got.met ||
    baked.rows !== got.rows ||
    off(baked.vFrom, got.vFrom) ||
    off(baked.vTo, got.vTo) ||
    off(baked.jumpMm.median, got.jumpMm.median) ||
    off(baked.jumpMm.p95, got.jumpMm.p95) ||
    off(baked.jumpMm.max, got.jumpMm.max)
  )
    fail(
      `the sidecar's seamContinuity (${baked.met}/${baked.rows} rows, v ` +
        `${baked.vFrom}..${baked.vTo}, tear ${baked.jumpMm.median}/${baked.jumpMm.max}mm) is not ` +
        `what this survey measures (${got.met}/${got.rows} rows, v ` +
        `${got.vFrom.toFixed(3)}..${got.vTo.toFixed(3)}, tear ` +
        `${got.jumpMm.median.toFixed(3)}/${got.jumpMm.max.toFixed(3)}mm)`,
    );
  else
    pass(
      `the sidecar's continuous span matches this survey: ${baked.met}/${baked.rows} rows, ` +
        `net v ${baked.vFrom}..${baked.vTo}, torn by ${baked.jumpMm.median}mm at the median ` +
        `elsewhere`,
    );

  const tol = NET.zones.left.seamResidualMm.p95 + SURVEY_U_STEP_MM;
  tornRow = rows
    .filter((r) => r.jump > tol)
    .sort((a, b) => Math.abs(a.v - TORN_TARGET_V) - Math.abs(b.v - TORN_TARGET_V))[0];
  if (!tornRow) fail('every row of this boundary joins — check 6 has nothing to straddle');
  else
    console.log(
      `   torn spot for check 6: net (${tornRow.u.toFixed(2)}, ${tornRow.v.toFixed(2)}), ` +
        `where the two sheets are ${tornRow.jump.toFixed(1)}mm apart in 3D`,
    );
}

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

  /* ------------------------------------------------------ 1: across the flank/back seam */
  console.log('\n=== 1. Whole chair, a bar across the flank/back seam ===');
  const seamP95 = NET.zones.left.seamResidualMm.p95;
  const bar = SPOT.seam;
  // The bar's centreline, walked in net mm, with the sheet that owns each step resolved.
  const walk = [];
  for (let t = -BAR_W / 2; t <= BAR_W / 2 + 1e-9; t += WALK_MM)
    walk.push({ t, ...netPoint(sheets, bar[0] + t, bar[1]) });
  const unowned = walk.filter((w) => !w.owner);
  if (unowned.length)
    fail(
      `${unowned.length} of ${walk.length} steps along the bar are owned by no sheet ` +
        `(first at u=${(bar[0] + unowned[0].t).toFixed(2)}, covered by ` +
        `${JSON.stringify(unowned[0].covering.map((c) => c.zoneId))}) — the bar is not a fair test`,
    );
  const owned = walk.filter((w) => w.owner);
  const byZone = new Map();
  for (const w of owned) byZone.set(w.owner.zoneId, (byZone.get(w.owner.zoneId) ?? 0) + 1);
  console.log(
    `   bar centred at net (${bar.join(', ')}), ${walk.length} steps of ${WALK_MM}mm, owned by ` +
      `${[...byZone].map(([z, n]) => `${z}:${n}`).join(' ')}`,
  );
  if (byZone.size < 2)
    fail(`the bar never crosses a sheet boundary — every step is owned by ${[...byZone.keys()]}`);

  // The measurement the plan asks for: consecutive steps of one straight edge, in 3D. A continuous
  // mark walks WALK_MM per step. The crossing steps are the seam itself; the within-sheet worst is
  // printed beside them so a big crossing number can be read against how fast the mark is moving
  // anyway (a stretched chart walks further per net mm than a flat one).
  let worstCross = { d: -1 },
    worstSame = { d: -1 };
  for (let i = 1; i < owned.length; i++) {
    const a = owned[i - 1],
      b = owned[i];
    const d = Math.hypot(...[0, 1, 2].map((k) => a.owner.P[k] - b.owner.P[k]));
    const slot = a.owner.zoneId === b.owner.zoneId ? 'same' : 'cross';
    if (slot === 'cross' && d > worstCross.d) worstCross = { d, a, b };
    if (slot === 'same' && d > worstSame.d) worstSame = { d, a, b };
  }
  const stepBar = seamP95 + WALK_MM;
  console.log(`   worst step within one sheet: ${worstSame.d.toFixed(3)}mm`);
  if (worstCross.d < 0)
    fail('the bar never steps from one sheet to another — nothing was measured');
  else if (worstCross.d > stepBar)
    fail(
      `the bar is not continuous in 3D: its worst sheet-to-sheet step is ` +
        `${worstCross.d.toFixed(3)}mm > ${stepBar.toFixed(3)}mm (seamResidualMm.p95 ${seamP95} + ` +
        `one ${WALK_MM}mm walk), from ${worstCross.a.owner.zoneId} at net ` +
        `u=${(bar[0] + worstCross.a.t).toFixed(2)} ${fmtP(worstCross.a.owner.P)} to ` +
        `${worstCross.b.owner.zoneId} ${fmtP(worstCross.b.owner.P)}`,
    );
  else
    pass(
      `the bar is continuous in 3D across the seam: worst sheet-to-sheet step ` +
        `${worstCross.d.toFixed(3)}mm <= ${stepBar.toFixed(3)}mm, at the ` +
        `${worstCross.a.owner.zoneId}/${worstCross.b.owner.zoneId} boundary ` +
        `${fmtP(worstCross.a.owner.P)}`,
    );

  const barSvg = path.join(OUT, 'seam-bar.svg');
  await useDesign(page, barSvg, BAR_SVG, { zone: '*whole', ...offsetFor(bar) });
  const badge = await page.textContent('#artwork-list .artwork-row .artwork-zone-badge');
  console.log(`   badge: ${badge}`);
  const seamNotices = await netNotices(page);
  console.log(`   net notices: ${JSON.stringify(seamNotices, null, 1)}`);
  // This bar is on the stretch that really joins, so the straddle warning must stay quiet. It is
  // the no-fire half of check 6, and it is here because this is where a bar already sits on a join.
  //
  // What it proves is that a mark on a join comes out silent, which is the user-visible claim. It
  // does NOT exercise a joining EXCLUSION patch: the two sheets abut here rather than overlap (the
  // notice list above is empty), so no clip ran to be silent about. That case is a flag flip on
  // identical geometry, which is a unit test — tests/net-design.test.ts.
  const seamTorn = await tornWarnings(page);
  if (seamTorn.length)
    fail(`the straddle warning fired on the joining stretch: ${JSON.stringify(seamTorn)}`);
  else pass('no straddle warning where the two sheets really join');
  const seamExport = await exportTo(page, path.join(OUT, '1-seam-whole.3mf'));
  console.log(
    `   inlays: ${seamExport.map((i) => `${i.part} e${i.extruder} (${i.points.length}v)`).join(', ')}`,
  );
  if (!seamExport.length) fail('the whole-part bar cut no inlay on any part');

  // Every step of the bar must be inked where the sheet that owns it puts it. Reported per sheet:
  // a partition that dropped one half leaves that half's steps bare while the other half passes.
  const inkReport = new Map();
  for (const w of owned) {
    const hit = nearestInk(seamExport, w.owner.P);
    const r = inkReport.get(w.owner.zoneId) ?? { n: 0, worst: -1, at: null, parts: new Set() };
    r.n++;
    if (hit.d > r.worst) {
      r.worst = hit.d;
      r.at = w;
    }
    if (hit.part) r.parts.add(hit.part);
    inkReport.set(w.owner.zoneId, r);
  }
  for (const [zoneId, r] of inkReport) {
    const label = `"${zoneName(zoneId)}" (${r.n} steps, ink on ${[...r.parts].join(' + ')})`;
    if (r.worst > INK_NEAR_MM)
      fail(
        `${label}: a step of the bar at net u=${(bar[0] + r.at.t).toFixed(2)} ${fmtP(r.at.owner.P)} ` +
          `is ${r.worst.toFixed(2)}mm from the nearest inlay vertex (> ${INK_NEAR_MM}mm) — that ` +
          'part of the mark was not cut where the net says it goes',
      );
    else pass(`${label}: every step inked, worst gap ${r.worst.toFixed(2)}mm`);
  }
  // And the sheets that did NOT win a step must not have cut it: on this chair their answer for
  // the same net point is tens of mm away, so ink there is a doubled cut.
  let worstGhost = { d: Infinity };
  for (const w of owned)
    for (const other of w.others) {
      const away = Math.hypot(...[0, 1, 2].map((k) => other.P[k] - w.owner.P[k]));
      if (away < INK_CLEAR_MM) continue; // too close to the real mark to tell the two apart
      const hit = nearestInk(seamExport, other.P);
      if (hit.d < worstGhost.d) worstGhost = { d: hit.d, other, w, hit, away };
    }
  if (worstGhost.d === Infinity)
    console.log('   (no yielded sheet sits far enough from the bar to test for a doubled cut)');
  else if (worstGhost.d < INK_CLEAR_MM)
    fail(
      `the bar is also cut where "${zoneName(worstGhost.other.zoneId)}" would have put it ` +
        `(${fmtP(worstGhost.other.P)}, ${worstGhost.away.toFixed(1)}mm from the mark): ink ` +
        `${worstGhost.d.toFixed(2)}mm away on "${worstGhost.hit.part}" — cut twice`,
    );
  else
    pass(
      `no ink at the yielded sheets' answers for the same net points ` +
        `(nearest ${worstGhost.d.toFixed(1)}mm, needs > ${INK_CLEAR_MM}mm)`,
    );

  /* ------------------------------------------------------ 5: the storage-box corner, looked at */
  console.log('\n=== 5. Screenshots of the storage-box corner with the bar across it ===');
  const box = await page.locator('#canvas-host canvas').boundingBox();
  await cornerShot(page, box, 'seam-bar', ['left', 'back']);

  /* ------------------------------------------------------ gizmo, with a whole-part binding */
  console.log('\n--- observation: gizmo with a whole-part binding');
  const gizmoWhole = await gizmoLatency(page);
  console.log(`   whole-chair binding: ${JSON.stringify(gizmoWhole)}`);

  /* ------------------------------------------------------ 6: across a stretch that only abuts */
  //
  // The same bar, moved down the same boundary to a row the survey says is torn. Nothing about the
  // cut changes — both zones place it in bounds and cut cleanly — so the only thing that can tell
  // a volunteer their mark came out in two pieces is this warning.
  console.log('\n=== 6. Whole chair, a bar across a stretch of that boundary that only abuts ===');
  if (tornRow) {
    const torn = [tornRow.u, tornRow.v];
    // Read the way the runtime reads it, not off the first torn entry that turns up: `tearMm` is
    // per yielded patch, one boundary can ship several to one neighbour, and both zones yield to
    // each other across the ragged divider. clipToNetShare pools per neighbour and
    // raiseTornWarning pools across directions, both at the worst tear, so this pools the same way.
    // Off `find()` alone, a rebake that split one patch in two, or that gave the back a worse
    // sliver, would fail here for the wrong reason or check the wrong boundary's number.
    const tornTears = (from, to) =>
      (NET.zones[from].excluded ?? [])
        .filter((e) => e.to === to && e.joins === false)
        .map((e) => e.tearMm);
    const candidates = [...tornTears('left', 'back'), ...tornTears('back', 'left')];
    const tearMm = candidates.length ? Math.max(...candidates) : undefined;
    // The two samples the survey itself compared: the last canvas the flank owns and the first the
    // back does, half a canvas gap either side of the row's midpoint. Their 3D answers are what
    // `tornRow.jump` measures, so this is the same crossing the sidecar calls torn.
    const sides = [-1, 1].map(
      (s) => netPoint(sheets, torn[0] + (s * tornRow.canvasGap) / 2, torn[1]).owner,
    );
    console.log(
      `   net (${torn.map((n) => n.toFixed(2)).join(', ')}): ` +
        sides.map((o) => `"${o?.zoneId}" ${o ? fmtP(o.P) : '(unowned)'}`).join(' | ') +
        `; the survey puts them ${tornRow.jump.toFixed(1)}mm apart`,
    );
    if (sides.some((o) => !o) || sides[0].zoneId === sides[1].zoneId)
      fail(`the torn spot does not straddle a sheet boundary: ${JSON.stringify(sides)}`);
    const tornSvg = path.join(OUT, 'torn-bar.svg');
    await useDesign(page, tornSvg, BAR_SVG, { zone: '*whole', ...offsetFor(torn) });
    const got = await tornWarnings(page);
    console.log(`   straddle warnings: ${JSON.stringify(got, null, 1)}`);
    if (tearMm === undefined)
      fail('the sidecar records no torn patch on the "left"/"back" boundary');
    const [n1, n2] = [zoneName('left'), zoneName('back')].sort();
    const want =
      `"${path.basename(tornSvg)}" crosses between "${n1}" and "${n2}", where the two sheets do ` +
      `not join. It prints in two pieces, about ${Math.round(tearMm)}mm apart. Bind it to one ` +
      `zone instead.`;
    if (got.length !== 1)
      fail(`one crossing of one boundary raised ${got.length} pill(s): ${JSON.stringify(got)}`);
    else if (got[0] === want) pass(`the straddle warning fired: ${want}`);
    else
      fail(
        `no warning said the mark crosses where the sheets do not join. Wanted:\n         ` +
          `${want}\n         got: ${JSON.stringify(got)}\n         ` +
          `(the boundary's torn patches measure ${JSON.stringify(candidates)}mm)`,
      );
    // And the export really does come out in two pieces, which is the thing the warning claims.
    const tornExport = await exportTo(page, path.join(OUT, '6-torn-whole.3mf'));
    const halves = sides.map((o) => ({ o, hit: nearestInk(tornExport, o.P) }));
    console.log(
      `   inlays: ${tornExport.map((i) => `${i.part} e${i.extruder}`).join(', ')}; ` +
        halves.map((h) => `"${h.o.zoneId}" ${h.hit.d.toFixed(2)}mm on ${h.hit.part}`).join(', '),
    );
    const inked = halves.filter((h) => h.hit.d <= INK_NEAR_MM);
    if (inked.length < 2)
      fail(
        `the bar did not come out in two pieces: only ${inked.length} of the two sheets' answers ` +
          `carries ink (${halves.map((h) => `"${h.o.zoneId}" ${h.hit.d.toFixed(2)}mm`).join(', ')})`,
      );
    else
      pass(
        `both halves really are cut, on surfaces ${tornRow.jump.toFixed(1)}mm apart — which is ` +
          `what the warning says`,
      );
  }

  /* ------------------------------------------------------ 2: inside the shared canvas */
  console.log('\n=== 2. Whole chair, a mark inside canvas the flank yields to the back ===');
  const share = SPOT.share;
  const sharePoint = netPoint(sheets, share[0], share[1]);
  console.log(
    `   net (${share.join(', ')}): owned by ` +
      `${sharePoint.owner ? `"${sharePoint.owner.zoneId}" ${fmtP(sharePoint.owner.P)} on ${sharePoint.owner.part}` : 'nobody'}` +
      `; yielded by ${sharePoint.others.map((o) => `"${o.zoneId}" ${fmtP(o.P)} on ${o.part}`).join(', ') || 'nobody'}`,
  );
  if (!sharePoint.owner) fail('the shared-canvas spot is owned by no sheet — pick another');
  if (!sharePoint.others.length)
    fail('the shared-canvas spot is covered by one sheet only — it is not shared canvas');

  const dotSvg = path.join(OUT, 'share-dot.svg');
  await useDesign(page, dotSvg, DOT_SVG, { zone: '*whole', ...offsetFor(share) });
  const shareNotices = await netNotices(page);
  console.log(`   net notices: ${JSON.stringify(shareNotices, null, 1)}`);
  const owner = sharePoint.owner;
  const yielder = sharePoint.others[0];
  const wantNotice =
    `"${path.basename(dotSvg)}" reaches part of the whole-part sheet that "${zoneName(owner.zoneId)}" ` +
    `owns. It is cut there, not on "${zoneName(yielder.zoneId)}".`;
  if (shareNotices.includes(wantNotice)) pass(`the share notice fired: ${wantNotice}`);
  else
    fail(
      `no notice said the ink moved to "${zoneName(owner.zoneId)}". Wanted:\n         ${wantNotice}\n` +
        `         got: ${JSON.stringify(shareNotices)}`,
    );
  const failedWarn = (await warnings(page)).filter((w) => /Couldn't trim/.test(w));
  if (failedWarn.length) fail(`the net clip failed: ${JSON.stringify(failedWarn)}`);
  else pass('no "Couldn\'t trim" warning — the clip applied');

  const shareExport = await exportTo(page, path.join(OUT, '2-share-whole.3mf'));
  console.log(
    `   inlays: ${shareExport.map((i) => `${i.part} e${i.extruder} (${i.points.length}v)`).join(', ')}`,
  );
  const atOwner = nearestInk(shareExport, owner.P);
  const atYielder = nearestInk(shareExport, yielder.P);
  const apart = Math.hypot(...[0, 1, 2].map((k) => owner.P[k] - yielder.P[k]));
  console.log(`   the two candidate spots are ${apart.toFixed(1)}mm apart`);
  if (atOwner.d > INK_NEAR_MM)
    fail(
      `nothing is cut where "${zoneName(owner.zoneId)}" owns the canvas: nearest ink ` +
        `${atOwner.d.toFixed(2)}mm from ${fmtP(owner.P)}`,
    );
  else pass(`cut on "${zoneName(owner.zoneId)}" (${atOwner.part}, ${atOwner.d.toFixed(2)}mm)`);
  if (atYielder.d < INK_CLEAR_MM)
    fail(
      `it is ALSO cut where "${zoneName(yielder.zoneId)}" would have put it: ink ` +
        `${atYielder.d.toFixed(2)}mm from ${fmtP(yielder.P)} on "${atYielder.part}" — cut twice`,
    );
  else
    pass(
      `nothing cut on "${zoneName(yielder.zoneId)}" (nearest ink ${atYielder.d.toFixed(1)}mm ` +
        `from ${fmtP(yielder.P)}) — the mark cut once`,
    );

  // The mark itself, on the sheet that won it. The flank it was placed over is 44mm away and out
  // of this view by construction; the viewport draws no hatching over a yielded patch, so this
  // picture and the notice pill in it are all a volunteer gets about where the ink went.
  await cornerShot(page, box, 'share-dot', ['back']);

  /* ------------------------------------------------------ 3: a detached sheet */
  console.log('\n=== 3. Whole chair, a mark centred on the detached fender sheet ===');
  const fender = SPOT.fender;
  const fenderPoint = netPoint(sheets, fender[0], fender[1]);
  console.log(
    `   net (${fender.join(', ')}): covered by ` +
      `${fenderPoint.covering.map((c) => `"${c.zoneId}" ${fmtP(c.P)} on ${c.part}`).join(', ') || 'nobody'}`,
  );
  if (fenderPoint.covering.length !== 1 || fenderPoint.covering[0].zoneId !== 'wing-left')
    fail(
      `the fender spot is not the fender's alone: ${JSON.stringify(fenderPoint.covering.map((c) => c.zoneId))}`,
    );
  console.log(
    `   canvas gap to the nearest other sheet: ${gapToOtherSheets('wing-left').toFixed(2)}mm`,
  );

  const padSvg = path.join(OUT, 'fender-pad.svg');
  await useDesign(page, padSvg, PAD_SVG, { zone: '*whole', ...offsetFor(fender) });
  console.log(`   net notices: ${JSON.stringify(await netNotices(page))}`);
  const fenderExport = await exportTo(page, path.join(OUT, '3-fender-whole.3mf'));
  console.log(
    `   inlays: ${fenderExport.map((i) => `${i.part} e${i.extruder} (${i.points.length}v)`).join(', ')}`,
  );
  const inked = [...new Set(fenderExport.map((i) => i.part))];
  if (inked.length !== 1)
    fail(`a mark on one detached sheet cut ${inked.length} parts: ${JSON.stringify(inked)}`);
  else pass(`only "${inked[0]}" carries ink`);
  const atFender = nearestInk(fenderExport, fenderPoint.covering[0].P);
  if (atFender.d > INK_NEAR_MM)
    fail(
      `nothing cut at the fender sheet's own answer ${fmtP(fenderPoint.covering[0].P)}: nearest ` +
        `ink ${atFender.d.toFixed(2)}mm`,
    );
  else pass(`cut on the fender at ${fmtP(fenderPoint.covering[0].P)} (${atFender.d.toFixed(2)}mm)`);

  /* ------------------------------------------------------ 4: rebind to one zone */
  //
  // The shared-canvas mark, not the seam bar: at the seam the two sheets abut rather than overlap,
  // so nothing there is being withheld from the flank and a rebind would have nothing to give
  // back. This mark sits on canvas the flank yields, so "per-zone behaviour returns" is a claim
  // with a 3D address — the flank's own answer, 44mm from the back's.
  console.log('\n=== 4. Rebind the shared-canvas mark from "Whole chair" to "Left side" ===');
  await useDesign(page, dotSvg, DOT_SVG, { zone: '*whole', ...offsetFor(share) });
  // The same spot expressed in the flank's own placement space: its UV, less its bbox centre.
  const leftZone = sidecar.zones.find((z) => z.id === 'left');
  const leftCentre = [
    (leftZone.uvBounds.minU + leftZone.uvBounds.maxU) / 2,
    (leftZone.uvBounds.minV + leftZone.uvBounds.maxV) / 2,
  ];
  const shareLeftUV = netToZoneUV(NET.zones.left, share);
  await setZone(page, 'left');
  await afterRebuild(page, () =>
    page.fill('#p-offset-x', (shareLeftUV[0] - leftCentre[0]).toFixed(3)),
  );
  await afterRebuild(page, () =>
    page.fill('#p-offset-y', (shareLeftUV[1] - leftCentre[1]).toFixed(3)),
  );
  console.log(`   rows: ${JSON.stringify(await rowStates(page))}`);
  const rebindNotices = await netNotices(page);
  if (rebindNotices.length)
    fail(
      `a single-zone binding still says something about the whole-part sheet: ` +
        JSON.stringify(rebindNotices),
    );
  else pass('no whole-part notice on a single-zone binding');

  const rebindExport = await exportTo(page, path.join(OUT, '4-share-left-only.3mf'));
  console.log(
    `   inlays: ${rebindExport.map((i) => `${i.part} e${i.extruder} (${i.points.length}v)`).join(', ')}`,
  );
  const backAtRebind = nearestInk(rebindExport, owner.P);
  const leftAtRebind = nearestInk(rebindExport, yielder.P);
  if (leftAtRebind.d > INK_NEAR_MM)
    fail(
      `bound to "${zoneName(yielder.zoneId)}" alone, the mark is not cut on the flank at ` +
        `${fmtP(yielder.P)}: nearest ink ${leftAtRebind.d.toFixed(2)}mm — the partition is still ` +
        'being applied to a per-zone binding',
    );
  else
    pass(
      `bound to "${zoneName(yielder.zoneId)}" alone, the mark is cut on the flank at ` +
        `${fmtP(yielder.P)} (${leftAtRebind.d.toFixed(2)}mm, on ${leftAtRebind.part})`,
    );
  if (backAtRebind.d < INK_CLEAR_MM)
    fail(
      `bound to one zone, it is still cut where "${zoneName(owner.zoneId)}" put it ` +
        `(${fmtP(owner.P)}): ink ${backAtRebind.d.toFixed(2)}mm away on "${backAtRebind.part}"`,
    );
  else
    pass(
      `nothing left on "${zoneName(owner.zoneId)}" (nearest ink ` +
        `${backAtRebind.d.toFixed(1)}mm from ${fmtP(owner.P)})`,
    );
  const gizmoZone = await gizmoLatency(page);
  console.log(
    `\n--- observation: gizmo with a single-zone binding\n   ${JSON.stringify(gizmoZone)}`,
  );

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

/**
 * How long the on-face gizmo takes to answer, with whatever binding is current. Two numbers, not
 * one: the frame it draws is refreshed synchronously off the mapper set (a whole-part binding
 * resolves one per zone per part), while the rebuild a nudge schedules is the cut itself.
 */
async function gizmoLatency(page) {
  const nudge = async (dx) => {
    const t0 = Date.now();
    const cur = Number(await page.inputValue('#p-offset-x'));
    await afterRebuild(page, () => page.fill('#p-offset-x', (cur + dx).toFixed(3)));
    return Date.now() - t0;
  };
  const out = await nudge(1);
  const back = await nudge(-1);
  return { rebuildAfterNudgeMs: [out, back] };
}

/** Smallest net-mm distance from one sheet's charted surface to any other sheet's. */
function gapToOtherSheets(zoneId) {
  const netUV = (id, tris) => tris.flatMap((t) => t.uv.map((p) => zoneUVToNet(NET.zones[id], p)));
  // Deduped to 0.1mm: a chart's triangles share almost every corner, and the pairwise walk below
  // is the one place in this script where that multiplies out.
  const thin = (pts) => [
    ...new Map(pts.map((p) => [`${p[0].toFixed(1)},${p[1].toFixed(1)}`, p])).values(),
  ];
  const mine = thin(netUV(zoneId, sheets.get(zoneId).tris));
  let best = Infinity;
  for (const otherId of Object.keys(NET.zones)) {
    if (otherId === zoneId) continue;
    for (const q of thin(netUV(otherId, sheets.get(otherId).tris)))
      for (const p of mine) {
        const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
        if (d < best) best = d;
      }
  }
  return best;
}
