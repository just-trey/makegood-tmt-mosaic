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
/** How far from the snap point an A-only vertex still counts as part of THIS mark, in 3D. */
const CLUSTER_MM = 25;

const SIDECAR_REL = 'stl/chair-body-zones.json';
const DIST = path.join(REPO, 'dist', SIDECAR_REL);
const SHIPPED = path.join(REPO, 'public', SIDECAR_REL);

const failures = [];
// `cuts` are the pieces shown to reach the print; the rest are the run failing to be able to say.
// Reporting both as one number would let a broken isolation gate read as a defect count.
const cuts = [];
const fail = (m, isCut = false) => {
  failures.push(m);
  if (isCut) cuts.push(m);
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
  // zi/ci are how the B variant finds these again in its own parse of the file. (zone.id,
  // libraryPartId) is unique in today's sidecar and nothing promises it stays so — a zone carrying
  // two charts of one part would delete the wrong pieces, silently, in the variant that is meant
  // to be the control.
  sidecar.zones.forEach((zone, zi) =>
    zone.charts.forEach((chart, ci) => {
      const cs = new wasm.CrossSection(triRingsOf(chart), 'NonZero');
      (chart.cutRegions ?? []).forEach((piece, i) => {
        const pcs = new wasm.CrossSection(ringsOf(piece), 'EvenOdd');
        const off = pcs.subtract(cs);
        if (off.area() / pcs.area() >= 0.5)
          out.push({
            zone: zone.id,
            part: chart.libraryPartId,
            zi,
            ci,
            i,
            chart,
            net: regionNetArea(piece),
            offFrac: off.area() / pcs.area(),
            piece,
          });
        off.delete();
        pcs.delete();
      });
      cs.delete();
    }),
  );
  return out;
}

const ringArea = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
};

/**
 * A point genuinely inside a piece: a vertex of the largest ring left after insetting it as far as
 * it will go. An inset boundary lies strictly inside the original, so this cannot fall outside.
 *
 * NOT the bbox centre, which was the first version and is wrong here: these pieces are curved
 * ribbons, and 6 of the 14 have a bbox centre outside their own outer ring — by up to ~14mm on the
 * longest. Both the isolation gate and the snap-point prediction hang off this point, so a centre
 * in free space would gate on the wrong neighbourhood and then look for ink in the wrong place,
 * which reads as "cuts nothing" for a piece that cuts.
 */
function interiorPoint(piece) {
  const cs = new wasm.CrossSection(ringsOf(piece), 'EvenOdd');
  try {
    for (let d = 0.05; d > 1e-5; d /= 2) {
      const inset = cs.offset(-d, 'Miter', 2, 16);
      try {
        if (inset.isEmpty()) continue;
        const rings = inset
          .toPolygons()
          .map((r) => r.map(([x, y]) => [x, y]))
          .filter((r) => ringArea(r) > 0)
          .sort((a, b) => ringArea(b) - ringArea(a));
        if (rings.length) return rings[0][0];
      } finally {
        inset.delete();
      }
    }
    throw new Error('a cut piece survives no inset at all, so it has no interior to sample');
  } finally {
    cs.delete();
  }
}

/** Other cut-region area of the whole zone within `ISOLATION_MM` of a point inside the piece. */
function neighbourArea(rib) {
  const c = interiorPoint(rib.piece);
  const zone = sidecar.zones.find((z) => z.id === rib.zone);
  // Unioned per piece, not pooled into one EvenOdd section. EvenOdd is right for ONE piece's
  // outer-with-holes and wrong across pieces: charts of a zone do overlap (four pairs on `left`),
  // and a pooled section reads each overlap as a hole. That cancels neighbourhood area, which is
  // the one direction an isolation gate must never err in.
  const sections = [];
  for (const ch of zone.charts)
    (ch.cutRegions ?? []).forEach((p, j) => {
      // By chart identity, not by (libraryPartId, index): a zone carrying two charts of one part
      // would otherwise drop the wrong piece here and UNDER-count the neighbourhood, the one
      // direction this gate must not err in.
      if (ch === rib.chart && j === rib.i) return;
      sections.push(new wasm.CrossSection(ringsOf(p), 'EvenOdd'));
    });
  const oc = wasm.CrossSection.union(sections);
  for (const cs of sections) cs.delete();
  const circle = wasm.CrossSection.circle(ISOLATION_MM, 64);
  const disc = circle.translate(c);
  const hit = oc.intersect(disc);
  const a = hit.area();
  hit.delete();
  disc.delete();
  circle.delete();
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
      const e = extruderOf.get(id);
      // Defaulting a missing entry to the body would score a config/model id mismatch as "no inlay
      // anywhere", in BOTH variants, and this script would print that everything is fine. It is the
      // one that can conclude "no defect", so it needs the throw more than check-net-design does.
      if (e === undefined)
        throw new Error(`sub-object ${id} of "${partName}" has no model_settings.config entry`);
      if (e === 1) continue;
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
  const pts = await exportOnce(page, label);
  // AFTER the export, not before. The export itself raises warnings as it runs — a dropped part, a
  // coverage gap, a placement problem — and a B run that quietly lost a whole part would otherwise
  // print "0 warning(s)" while its vertex delta got blamed on the ribbon.
  const warn = await page.evaluate(() => window.__mosaic.warnings());
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
  const snap = await snapPoint(r.chart, n.centre);
  targets.push({ ...r, ...n, snap });
  console.log(
    `  ${r.zone}/${r.part}#${r.i}: ${r.net.toFixed(3)}mm², ${(r.offFrac * 100).toFixed(1)}% off, ` +
      `centre (${n.centre[0].toFixed(2)}, ${n.centre[1].toFixed(2)}), ` +
      `${n.area.toFixed(4)}mm² of other cut region within ${ISOLATION_MM}mm, ` +
      `snaps ${snap.dist.toFixed(3)}mm to (${snap.p.map((x) => x.toFixed(1)).join(', ')})`,
  );
}
const readable = targets.filter((t) => t.area === 0);

// The A-only cluster is counted per PART, and B deletes every off-surface piece at once, so a
// second such piece landing near this one in 3D would put both marks in one cluster and the
// attribution would name the wrong piece. Asked across every off-surface piece of every zone,
// because a part carries charts in more than one zone — `chair-wheel-mount-left` is in `left` and
// in `seat-left`. Distances are between snapped 3D points, which is where the marks actually land.
for (const t of readable) {
  const others = [];
  for (const r of ribbons) {
    if (r.part !== t.part) continue;
    if (r.chart === t.chart && r.i === t.i) continue;
    const snap = await snapPoint(r.chart, interiorPoint(r.piece));
    others.push({
      id: `${r.zone}/${r.part}#${r.i}`,
      mm: Math.hypot(...[0, 1, 2].map((k) => snap.p[k] - t.snap.p[k])),
    });
  }
  others.sort((a, b) => a.mm - b.mm);
  t.rival = others[0] ?? null;
  const where = `${t.zone}/${t.part}#${t.i}`;
  if (!t.rival)
    pass(`${where} is the only off-surface piece on "${t.part}" — nothing to confuse it with`);
  else if (t.rival.mm > CLUSTER_MM)
    pass(
      `${where}: nearest other off-surface piece on the same part is ${t.rival.id} at ` +
        `${t.rival.mm.toFixed(1)}mm, outside the ${CLUSTER_MM}mm the mark's own cluster is read over`,
    );
  else
    fail(
      `${where}: ${t.rival.id} snaps ${t.rival.mm.toFixed(1)}mm away on the same part, inside ` +
        `the ${CLUSTER_MM}mm cluster radius — B deletes both, so a cluster here names neither alone`,
    );
}
if (!readable.length) throw new Error(`no isolated off-surface ribbon in zone "${ZONE}"`);

// One preview for both variants. The page fetches the sidecar on load, so patching what `dist/`
// serves between page loads is enough — and it keeps the build, the port and the browser fixed
// across A and B, which is the whole point of running them as a pair.
// No allowStaleDist. The freshness check runs here, before the first variant patches `dist/`, so
// the opt-out would buy nothing and cost the exact failure harness.mjs exists to stop: an A/B whose
// numbers describe the previous build.
const preview = await startPreview({ port: PORT });
let A, B;
let browser;
try {
  // Inside the try: a launchBrowser that throws used to leave the preview serving, and the next run
  // then died on startPreview's own port guard rather than on the real cause.
  browser = await launchBrowser();
  console.log(`\nA: the shipped sidecar.`);
  copyFileSync(SHIPPED, DIST);
  A = await runVariant(browser, 'A-shipped');

  console.log(`\nB: the same build with ${ribbons.length} off-surface pieces deleted.`);
  const patched = JSON.parse(readFileSync(SHIPPED, 'utf8'));
  let removed = 0;
  patched.zones.forEach((zone, zi) =>
    zone.charts.forEach((chart, ci) => {
      const drop = new Set(ribbons.filter((r) => r.zi === zi && r.ci === ci).map((r) => r.i));
      if (!drop.size) return;
      const before = chart.cutRegions.length;
      chart.cutRegions = chart.cutRegions.filter((_, i) => !drop.has(i));
      removed += before - chart.cutRegions.length;
    }),
  );
  // A patch that removed nothing would make B a copy of A, and every verdict below would then read
  // "cuts nothing" — this script's own no-defect answer, produced by the control being broken
  // rather than by the pieces being harmless. That is the one failure it must not report quietly.
  if (removed !== ribbons.length)
    throw new Error(
      `the B sidecar should have lost ${ribbons.length} cut pieces and lost ${removed}`,
    );
  writeFileSync(DIST, JSON.stringify(patched));
  B = await runVariant(browser, 'B-cleaned');
  if (A.length === B.length)
    throw new Error(
      `B has the same inlay vertex count as A (${A.length}) after ${removed} cut pieces were ` +
        `removed from its sidecar. Either the variant did not reach the browser or it read the ` +
        `unpatched file — and every verdict below would then read "cuts nothing" for that reason ` +
        `rather than because the pieces are harmless.`,
    );
} finally {
  copyFileSync(SHIPPED, DIST);
  await browser?.close();
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
  // Counted PER PART and ranked by what each part GAINED, not pooled across the export and then
  // attributed to whichever part happens to have ink nearby. Parts abut: at a snap point on a seam
  // two of them can both carry vertices inside NEAR_MM, and a pooled count lets one part's ink
  // stand in for another's — which reads as a mark on the wrong part, or as no mark at all when the
  // neighbour's unchanged vertices cancel the gain.
  const ranked = [...perPart.keys()]
    .map((n) => {
      const p = perPart.get(n);
      return {
        n,
        aN: near(p.a, t.snap.p, NEAR_MM).length,
        bN: near(p.b, t.snap.p, NEAR_MM).length,
      };
    })
    .map((r) => ({ ...r, gain: r.aN - r.bN }))
    .sort((x, y) => y.gain - x.gain);
  const best = ranked[0];
  if (!best || best.gain <= 0) {
    const tot = ranked.reduce((s2, r) => s2 + r.aN, 0);
    pass(
      `${where} cuts nothing the pair can tell apart: no part gains an inlay vertex within ` +
        `${NEAR_MM}mm of the snap point (${tot} there in A across all parts)`,
    );
    continue;
  }
  const partName = best.n;
  const a = best.aN;
  const b = best.bN;
  const { only, b: bp } = perPart.get(partName);
  // A > B near the point with no A-only vertex on that part means the mark moved rather than
  // appeared, and the bbox below would come out Infinity. Say that instead of printing NaN.
  if (!only.length) {
    fail(
      `${where}: ${a} inlay vertices within ${NEAR_MM}mm in A against ${b} in B on "${partName}", ` +
        `but every A vertex there matches one of B's — the difference is a count, not new geometry.`,
    );
    continue;
  }
  // Bounded to the mark's own neighbourhood. Taken over every A-only vertex on the part, the bbox
  // would absorb a second deleted piece — the rival guard only reaches 12mm — and the dimensions
  // quoted in the report would describe two marks as one. Anything outside is counted and named
  // rather than dropped.
  const cluster = near(only, t.snap.p, CLUSTER_MM);
  const strays = only.length - cluster.length;
  const ax = [0, 1, 2].map((k) => [
    Math.min(...cluster.map((q) => q.v[k])),
    Math.max(...cluster.map((q) => q.v[k])),
  ]);
  const c = [0, 1, 2].map((k) => (ax[k][0] + ax[k][1]) / 2);
  if (!cluster.length) {
    fail(`${where}: ${only.length} A-only vertices on "${partName}", none within ${CLUSTER_MM}mm`);
    continue;
  }
  // B having no inlay left on the part at all is a real outcome, not an error: it means the piece
  // was the only thing inking it. `Math.min()` of nothing is Infinity, which would print as a
  // distance.
  const survivorMm = bp.length
    ? Math.min(...bp.map((q) => Math.hypot(q.v[0] - c[0], q.v[1] - c[1], q.v[2] - c[2])))
    : null;
  fail(
    `${where} cuts a mark on "${partName}": ${a} inlay vertices within ${NEAR_MM}mm of the snap ` +
      `point in A, ${b} in B. The A-only cluster within ${CLUSTER_MM}mm is ${cluster.length} ` +
      `vertices (${strays} more A-only on that part lie outside it), ` +
      `${ax.map(([lo, hi]) => (hi - lo).toFixed(3)).join(' x ')}mm, and the nearest inlay vertex ` +
      `B still has on that part is ${survivorMm === null ? 'nowhere — B leaves that part uninked' : `${survivorMm.toFixed(2)}mm away`} — so it vanished rather than moved.`,
    true,
  );
}

console.log(
  cuts.length
    ? `\n${cuts.length} off-surface piece(s) reach the print. UV with no triangle under it ` +
        `does not fall out of the cut: it snaps to the patch edge and extrudes there.`
    : `\nNo off-surface piece was shown to reach the print in this run.`,
);
if (failures.length > cuts.length)
  console.log(
    `${failures.length - cuts.length} other failure(s) above are the run being unable to attribute ` +
      `a piece, not a piece reaching the print.`,
  );
// 2. Every other check-*.mjs sets this. Without it a run where a ribbon DOES cut exits 0, so CI or
// an `&&` chain reads the defect as a pass.
process.exitCode = failures.length ? 1 : 0;
