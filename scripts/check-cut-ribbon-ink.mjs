// Does an off-surface `cutRegions` ribbon actually cut a mark on the printed part?
//
// scripts/measure-cut-offsurface.mjs says 14 of the chair's 87 cut pieces lie at least half
// outside their chart's own triangles. That is a fact about the sidecar. Whether it reaches the
// print is a fact about the app, because `lookup` answers the nearest triangle AT ANY DISTANCE:
// UV with no surface under it does not fall out of the cut, it snaps to the patch edge — the
// mechanism behind the #296 phantom mark.
//
// The oracle is the exported 3MF, not the viewport, because the inlay solids are what ships.
//
// A/B rather than a placed dot. The ribbon is 0.19mm wide, so a mark aimed at it by hand would be
// measuring the placement rather than the ribbon. Instead the same full-bleed design is exported
// twice against the same build, once from the shipped sidecar and once from one with the
// off-surface pieces deleted from `cutRegions`. Everything else is held fixed, so any inlay
// geometry present in A and absent in B came from those pieces and nothing else.
//
// Usage:
//   npm run build && npx vite-node scripts/check-cut-ribbon-ink.mjs [outDir]
//   npm run build && MOSAIC_GPU=1 npx vite-node scripts/check-cut-ribbon-ink.mjs stubs/ribbon-ink
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { startPreview, launchBrowser, newPage, afterRebuild, shot } from './lib/harness.mjs';
import { eachElement, meshVerts, modelXML } from './lib/mesh.mjs';
import { getManifold } from '../src/geometry/manifold';
import { regionNetArea } from './lib/zonebake.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] || 'stubs/ribbon-ink';
mkdirSync(path.join(REPO, OUT), { recursive: true });
const PORT = 4178;

/** The zone this run drives. Its chart carries the largest isolated off-surface ribbon. */
const ZONE = 'left';
/** How far from a predicted point an inlay vertex counts as the mark being there. */
const NEAR_MM = 6;
/** Neighbourhood in zone UV that has to hold no OTHER cut region for a ribbon to be readable. */
const ISOLATION_MM = 6;

const SIDECAR_REL = 'stl/chair-body-zones.json';
const DIST = path.join(REPO, 'dist', SIDECAR_REL);
const SHIPPED = path.join(REPO, 'public', SIDECAR_REL);

const failures = [];
const fail = (m) => {
  failures.push(m);
  console.log(`  FAIL ${m}`);
};
const pass = (m) => console.log(`  ok   ${m}`);

/* --------------------------------------------------- which pieces, and where they would land */

const sidecar = JSON.parse(readFileSync(SHIPPED, 'utf8'));
const wasm = await getManifold();
const ringsOf = (r) => [r.outer, ...(r.holes ?? [])];
const triRingsOf = (c) => c.chartTris.map((t) => t.map((i) => [c.uv[2 * i], c.uv[2 * i + 1]]));

/** Every cut piece at least half outside its chart's triangles, as measure-cut-offsurface counts. */
function offSurfacePieces() {
  const out = [];
  for (const zone of sidecar.zones)
    for (const chart of zone.charts) {
      const cs = new wasm.CrossSection(triRingsOf(chart), 'NonZero');
      (chart.cutRegions ?? []).forEach((piece, i) => {
        const pcs = new wasm.CrossSection(ringsOf(piece), 'EvenOdd');
        const off = pcs.subtract(cs);
        if (off.area() / pcs.area() >= 0.5)
          out.push({
            zone: zone.id,
            part: chart.libraryPartId,
            i,
            net: regionNetArea(piece),
            offFrac: off.area() / pcs.area(),
            piece,
          });
        off.delete();
        pcs.delete();
      });
      cs.delete();
    }
  return out;
}

/** Other cut-region area of the whole zone within `ISOLATION_MM` of a piece's centre. */
function neighbourArea(rib) {
  const us = rib.piece.outer.map((p) => p[0]);
  const vs = rib.piece.outer.map((p) => p[1]);
  const c = [(Math.min(...us) + Math.max(...us)) / 2, (Math.min(...vs) + Math.max(...vs)) / 2];
  const zone = sidecar.zones.find((z) => z.id === rib.zone);
  const others = [];
  for (const ch of zone.charts)
    (ch.cutRegions ?? []).forEach((p, j) => {
      if (ch.libraryPartId === rib.part && j === rib.i) return;
      others.push(...ringsOf(p));
    });
  const oc = new wasm.CrossSection(others, 'EvenOdd');
  const disc = wasm.CrossSection.circle(ISOLATION_MM, 64).translate(c);
  const hit = oc.intersect(disc);
  const a = hit.area();
  hit.delete();
  disc.delete();
  oc.delete();
  return { centre: c, area: a };
}

const partVertCache = new Map();
async function partVertices(id) {
  if (partVertCache.has(id)) return partVertCache.get(id);
  const xml = await modelXML(readFileSync(path.join(REPO, `public/stl/${id}.3mf`)));
  const out = [];
  // Packed-file order across every <object> — the order load3MF builds its vertex list in, and so
  // the order the sidecar's `verts` indices are against.
  for (const { body } of eachElement(xml, 'object'))
    if (body) for (const v of meshVerts(body)) out.push(v);
  partVertCache.set(id, out);
  return out;
}

/**
 * Where the app would put ink that lands on a UV point with no triangle under it: the closest
 * point of the closest chart triangle, in 3D. This is `lookup`'s answer restated, not a guess —
 * it snaps to the nearest triangle at any distance, which is why off-surface UV still cuts.
 */
async function snapPoint(chart, uvPt) {
  const verts = await partVertices(chart.libraryPartId);
  let best = null;
  for (const t of chart.chartTris) {
    const a = [chart.uv[2 * t[0]], chart.uv[2 * t[0] + 1]];
    const b = [chart.uv[2 * t[1]], chart.uv[2 * t[1] + 1]];
    const c = [chart.uv[2 * t[2]], chart.uv[2 * t[2] + 1]];
    const cand = closestOnTri(uvPt, a, b, c);
    if (!best || cand.d < best.d) best = { ...cand, t };
  }
  const p3 = best.t.map((i) => verts[chart.verts[i]]);
  const [w0, w1, w2] = best.bary;
  return {
    dist: best.d,
    p: [0, 1, 2].map((k) => p3[0][k] * w0 + p3[1][k] * w1 + p3[2][k] * w2),
  };
}

/** Closest point of triangle abc to p, with its barycentric weights. Plain, no library. */
function closestOnTri(p, a, b, c) {
  const sub = (u, v) => [u[0] - v[0], u[1] - v[1]];
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1];
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  let bary;
  if (d1 <= 0 && d2 <= 0) bary = [1, 0, 0];
  else {
    const bp = sub(p, b);
    const d3 = dot(ab, bp);
    const d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) bary = [0, 1, 0];
    else {
      const cp = sub(p, c);
      const d5 = dot(ab, cp);
      const d6 = dot(ac, cp);
      if (d6 >= 0 && d5 <= d6) bary = [0, 0, 1];
      else {
        const vc = d1 * d4 - d3 * d2;
        const vb = d5 * d2 - d1 * d6;
        const va = d3 * d6 - d5 * d4;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) {
          const w = d1 / (d1 - d3);
          bary = [1 - w, w, 0];
        } else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
          const w = d2 / (d2 - d6);
          bary = [1 - w, 0, w];
        } else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
          const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
          bary = [0, 1 - w, w];
        } else {
          const den = 1 / (va + vb + vc);
          bary = [va * den, vb * den, vc * den];
        }
      }
    }
  }
  const q = [0, 1].map((k) => a[k] * bary[0] + b[k] * bary[1] + c[k] * bary[2]);
  return { d: Math.hypot(p[0] - q[0], p[1] - q[1]), bary, q };
}

/* ------------------------------------------------------------------- 3MF reading */

/** Every inlay vertex in an export, flat. Extruder 1 is the body by construction, so it is out. */
async function inlayPoints(file) {
  const zip = await JSZip.loadAsync(readFileSync(file));
  const model = await zip.file('3D/3dmodel.model').async('string');
  const cfg = await zip.file('Metadata/model_settings.config').async('string');
  const extruderOf = new Map();
  for (const [, id, body] of cfg.matchAll(/<part id="(\d+)"[^>]*>([\s\S]*?)<\/part>/g)) {
    const m = /<metadata key="extruder" value="(\d+)"\/>/.exec(body);
    if (m) extruderOf.set(id, +m[1]);
  }
  const verts = new Map();
  const parts = new Map();
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
      if ((extruderOf.get(id) ?? 1) === 1) continue;
      for (const v of verts.get(id) ?? []) out.push({ partName, v });
    }
  return out;
}

/* ------------------------------------------------------------------- driving */

const FULL_BLEED = `<svg xmlns="http://www.w3.org/2000/svg" width="400mm" height="400mm" viewBox="0 0 400 400"><rect x="0" y="0" width="400" height="400" fill="#1e5fa8"/></svg>`;

async function exportOnce(page, label) {
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 900_000 }),
    page.click('#btn-export'),
  ]);
  const file = path.join(REPO, OUT, `${label}.3mf`);
  await dl.saveAs(file);
  return inlayPoints(file);
}

async function runVariant(browser, label) {
  const { page, errors } = await newPage(browser, { viewport: { width: 1280, height: 900 } });
  await page.goto(`http://localhost:${PORT}/?kind=chair-body`);
  const svgFile = path.join(REPO, OUT, 'bleed.svg');
  writeFileSync(svgFile, FULL_BLEED);
  await afterRebuild(page, async () => {
    await page.setInputFiles('#svg-input', svgFile);
    await page.waitForSelector('#artwork-list .artwork-row', { timeout: 180_000 });
  });
  const sel = page.locator('#artwork-list .artwork-row .artwork-zone').first();
  if ((await sel.inputValue()) !== ZONE) await afterRebuild(page, () => sel.selectOption(ZONE));
  await afterRebuild(page, () => page.fill('#p-scale-num', '400'));
  await shot(page, path.join(REPO, OUT), `${label}.png`);
  const warn = await page.evaluate(() => window.__mosaic.warnings());
  const pts = await exportOnce(page, label);
  console.log(`   ${label}: ${pts.length} inlay vertices, ${warn.length} warning(s)`);
  for (const w of warn) console.log(`     warn: ${w}`);
  for (const e of errors) console.log(`     console: ${e}`);
  await page.close();
  return pts;
}

/* ------------------------------------------------------------------- the run */

const ribbons = offSurfacePieces();
console.log(`${ribbons.length} cut pieces at least half off-surface.`);
const inZone = ribbons.filter((r) => r.zone === ZONE);
const targets = [];
for (const r of inZone) {
  const n = neighbourArea(r);
  const chart = sidecar.zones
    .find((z) => z.id === r.zone)
    .charts.find((c) => c.libraryPartId === r.part);
  const snap = await snapPoint(chart, n.centre);
  targets.push({ ...r, ...n, snap });
  console.log(
    `  ${r.zone}/${r.part}#${r.i}: ${r.net.toFixed(3)}mm², ${(r.offFrac * 100).toFixed(1)}% off, ` +
      `centre (${n.centre[0].toFixed(2)}, ${n.centre[1].toFixed(2)}), ` +
      `${n.area.toFixed(4)}mm² of other cut region within ${ISOLATION_MM}mm, ` +
      `snaps ${snap.dist.toFixed(3)}mm to (${snap.p.map((x) => x.toFixed(1)).join(', ')})`,
  );
}
const readable = targets.filter((t) => t.area === 0);
if (!readable.length) throw new Error(`no isolated off-surface ribbon in zone "${ZONE}"`);

// One preview for both variants. The page fetches the sidecar on load, so patching what `dist/`
// serves between page loads is enough — and it keeps the build, the port and the browser fixed
// across A and B, which is the whole point of running them as a pair.
const preview = await startPreview({ port: PORT, allowStaleDist: true });
const browser = await launchBrowser();
let A, B;
try {
  console.log(`\nA: the shipped sidecar.`);
  copyFileSync(SHIPPED, DIST);
  A = await runVariant(browser, 'A-shipped');

  console.log(`\nB: the same build with ${ribbons.length} off-surface pieces deleted.`);
  const patched = JSON.parse(readFileSync(SHIPPED, 'utf8'));
  for (const zone of patched.zones)
    for (const chart of zone.charts) {
      const drop = ribbons
        .filter((r) => r.zone === zone.id && r.part === chart.libraryPartId)
        .map((r) => r.i);
      if (drop.length) chart.cutRegions = chart.cutRegions.filter((_, i) => !drop.includes(i));
    }
  writeFileSync(DIST, JSON.stringify(patched));
  B = await runVariant(browser, 'B-cleaned');
} finally {
  copyFileSync(SHIPPED, DIST);
  await browser.close();
  await preview.stop();
}

/* ------------------------------------------------------------------- the answer */

console.log(`\nInlay vertices: A ${A.length}, B ${B.length}, difference ${A.length - B.length}.`);

// Exact vertex identity, not a radius. A radius answers "is there ink near here", which a mark
// that MOVED would also satisfy; matching coordinates says which vertices A has that B does not,
// and the nearest-surviving-vertex distance below then says whether anything legitimate is near
// enough to have been the thing that moved.
const key = (q) => q.v.map((x) => x.toFixed(4)).join(',');
const perPart = new Map();
for (const partName of new Set(A.map((q) => q.partName))) {
  const a = A.filter((q) => q.partName === partName);
  const b = B.filter((q) => q.partName === partName);
  const bset = new Set(b.map(key));
  perPart.set(partName, { a, b, only: a.filter((q) => !bset.has(key(q))) });
}
console.log('\nPer part, inlay vertices in A with no exact match in B:');
for (const [partName, { a, b, only }] of perPart)
  if (only.length) console.log(`  ${partName}: ${only.length} (A ${a.length}, B ${b.length})`);

const near = (pts, p, r) =>
  pts.filter((q) => Math.hypot(q.v[0] - p[0], q.v[1] - p[1], q.v[2] - p[2]) <= r);
for (const t of readable) {
  const where = `${t.zone}/${t.part}#${t.i} (${t.net.toFixed(3)}mm², ${(t.offFrac * 100).toFixed(1)}% off)`;
  const a = near(A, t.snap.p, NEAR_MM).length;
  const b = near(B, t.snap.p, NEAR_MM).length;
  if (a <= b) {
    pass(
      `${where} cuts nothing the pair can tell apart: ${a} inlay vertices within ${NEAR_MM}mm in A, ${b} in B`,
    );
    continue;
  }
  // Which part it landed on, and how big the mark is. The cluster is every A-only vertex on that
  // part, which is worth stating as such: if it were bigger than the neighbourhood of this piece
  // the attribution would be the thing to doubt.
  const partName = [...perPart.keys()].find(
    (n) =>
      near(
        A.filter((q) => q.partName === n),
        t.snap.p,
        NEAR_MM,
      ).length,
  );
  const { only, b: bp } = perPart.get(partName);
  const ax = [0, 1, 2].map((k) => [
    Math.min(...only.map((q) => q.v[k])),
    Math.max(...only.map((q) => q.v[k])),
  ]);
  const c = [0, 1, 2].map((k) => (ax[k][0] + ax[k][1]) / 2);
  const survivorMm = Math.min(
    ...bp.map((q) => Math.hypot(q.v[0] - c[0], q.v[1] - c[1], q.v[2] - c[2])),
  );
  fail(
    `${where} cuts a mark on "${partName}": ${a} inlay vertices within ${NEAR_MM}mm of the snap ` +
      `point in A, ${b} in B. The whole A-only cluster on that part is ${only.length} vertices, ` +
      `${ax.map(([lo, hi]) => (hi - lo).toFixed(3)).join(' x ')}mm, and the nearest inlay vertex ` +
      `B still has on that part is ${survivorMm.toFixed(2)}mm away — so it vanished rather than moved.`,
  );
}

console.log(
  failures.length
    ? `\n${failures.length} off-surface piece(s) reach the print. UV with no triangle under it ` +
        `does not fall out of the cut: it snaps to the patch edge and extrudes there.`
    : `\nNo off-surface piece reached the print in this run.`,
);
