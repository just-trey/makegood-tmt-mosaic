/**
 * Zone bake pipeline: turns a kind's printed parts (in their assembled pose) plus a small
 * human-editable config into the assembly-level design-zones sidecar the conformal mapper
 * (src/geometry/conformal.ts) consumes, and true-size per-zone template SVGs. All of it runs
 * offline — the app never unwraps at runtime, matching the repo's bake-don't-derive rule.
 *
 * Stages:
 *   1. weld    — the parts are joined into one surface by matching coincident vertices across
 *                part seams, so one zone's chart can span printed parts (artwork flows over the
 *                seam; the runtime later splits cutters per part). Separately-printed parts are
 *                never *coincident* — they meet with real clearance — so a config that wants
 *                cross-seam zones sets `seamWeldTolMm` to stitch them (see stitchSeams).
 *   2. segment — each zone seeds from the largest flat patch matching its seedNormal (the same
 *                detectFlatPatches the app ranks faces with) and region-grows across triangle
 *                adjacency — including welded cross-part edges — while face normals stay within
 *                maxAngleDeg of the CONFIG seedNormal. Growing against the config direction, not
 *                the matched patch's, keeps the result independent of which same-area patch wins
 *                the seed tie.
 *   3. unwrap  — LSCM (least-squares conformal map, Lévy et al. 2002) flattens the zone into one
 *                UV island. Implemented here directly with a preconditioned CGNR solve rather
 *                than via xatlas, which insists on doing its own segmentation and atlas packing.
 *   4. true mm — the island is mirrored if needed so UV reads as the surface seen from OUTSIDE
 *                (the ConformalChart convention, normalSign +1), rotated so the config's `up`
 *                pulls back to +v, and uniformly scaled to millimetres by least squares on
 *                3D-vs-UV edge lengths. Distortion stats are recorded; a max over DISTORTION_WARN
 *                is surfaced for the author to shrink the zone or lower maxAngleDeg.
 *   5. emit    — simplified boundary/hole loops, per-part charts carrying part-local indices and
 *                that part's own share of the zone as outer/hole regions (`subRegions`, what the
 *                runtime clips its cutter to), cross-part seam polylines, the sidecar object, and
 *                template SVGs.
 */
import JSZip from 'jszip';
import { detectFlatPatches } from '../../src/geometry/meshparts.ts';
import { ACCENT, GRAY, LABEL_SIZE } from './svgstyle.mjs';

/** Boundary/hole/seam polyline simplification tolerance (mm) — CHART_SNAP_MM covers the slack. */
export const SIMPLIFY_TOL_MM = 0.2;
/** Interior loops smaller than this (mm²) are tessellation/fillet slivers, not real holes. */
export const MIN_HOLE_AREA_MM2 = 15;
/**
 * Islands smaller than this (mm²) are dropped from a part's clip region. Far below MIN_HOLE_AREA_MM2
 * on purpose: a hole that small is a fillet artifact worth closing up, but an *island* that small is
 * surface a cutter would otherwise be clipped away from, so only true tessellation dust (a sliver a
 * fraction of a millimetre across) may go — and the bake warns whenever any does.
 */
export const MIN_ISLAND_AREA_MM2 = 0.4;
/** Per-edge stretch (max of ratio and its inverse) above which a zone gets a distortion warning. */
export const DISTORTION_WARN = 1.1;
/** Max coincident-vertex gap (mm) welded across part seams. */
export const WELD_TOL_MM = 1e-3;
/**
 * Recommended `seamWeldTolMm` for the chair: the gap (mm) stitched between DIFFERENT parts, so a
 * zone can grow across a printed seam. Measured, not guessed — the chair's widest real contact gap
 * is 0.530mm (seat-center to seat-back-bottom), so 0.6 clears every seam with margin while leaving
 * the rear brace in the CAD assembly (1.008mm from anything, and not a part the app has at all)
 * unstitched, which keeps a zone from wandering onto surface that can never be cut.
 *
 * Opt-in per config rather than a default: turning it on makes every zone grow until `maxAngleDeg`
 * stops it rather than until the part runs out, so a zone set authored against single-part zones
 * has to be re-tuned in the same change that enables it.
 */
export const SEAM_WELD_TOL_MM = 0.6;
/** Minimum normal agreement for a seam stitch — rejects parts that face each other across a gap. */
const SEAM_NORMAL_DOT = 0.3;

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm3 = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]);
  if (!(l > 0)) throw new Error(`zero-length vector [${v}]`);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const round = (v, dp) => Number(v.toFixed(dp));

/**
 * Reads a packed single-object 3MF (the pack-part.mjs output format) keeping its index
 * structure: chart `verts` entries are indices into this exact file order, which is also the
 * order the runtime loader will see. Attribute-wise regexes, same reason as scripts/lib/mesh.mjs:
 * 3MF does not mandate an attribute order.
 */
export async function read3MFIndexed(buf) {
  const zip = await JSZip.loadAsync(buf);
  const model = zip.file('3D/3dmodel.model');
  if (!model) throw new Error('not a valid 3MF: missing 3D/3dmodel.model');
  const xml = await model.async('string');
  const XA = [/\bx="([^"]*)"/, /\by="([^"]*)"/, /\bz="([^"]*)"/];
  const TA = [/\bv1="([^"]*)"/, /\bv2="([^"]*)"/, /\bv3="([^"]*)"/];
  const attrs = (tag, res) => res.map((r) => +(tag.match(r)?.[1] ?? NaN));
  const verts = [];
  const tris = [];
  for (const om of xml.matchAll(/<object\b[^>]*(?:\/>|>([\s\S]*?)<\/object>)/g)) {
    const body = om[1];
    if (!body) continue;
    const base = verts.length;
    for (const v of body.matchAll(/<vertex\b[^>]*>/g)) verts.push(attrs(v[0], XA));
    for (const t of body.matchAll(/<triangle\b[^>]*>/g))
      tris.push(attrs(t[0], TA).map((i) => base + i));
  }
  for (const t of tris)
    for (const vi of t)
      if (!(vi >= 0 && vi < verts.length))
        throw new Error(`3MF triangle references vertex ${vi}, which does not exist`);
  return { verts, tris };
}

/**
 * Merge the parts into one indexed surface. Coincident vertices (within tolMm, across or within
 * parts) share one global index so triangle adjacency crosses printed-part seams. Buckets are
 * tol-sized cells with a 27-neighbour search, so two matching vertices can never be split by
 * landing on opposite sides of a cell wall.
 *
 * `seamTolMm` additionally stitches vertices that belong to DIFFERENT parts and are within that
 * (much looser) distance — see stitchSeams. The chair's parts are printed separately and meet with
 * real clearance, so nothing across a seam is ever coincident at tolMm and without this a zone can
 * never grow past the part it seeds on. It is deliberately not the same knob as tolMm: raising
 * tolMm far enough to bridge a 0.53mm seam would also collapse 63% of the vertices *inside* each
 * part, destroying the surface the unwrap runs on.
 */
export function weldParts(parts, tolMm = WELD_TOL_MM, seamTolMm = 0) {
  const buckets = new Map();
  const verts = [];
  const key = (c) => c.map((x) => Math.floor(x / tolMm)).join(',');
  const globalOf = (p) => {
    const base = p.map((x) => Math.floor(x / tolMm));
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const list = buckets.get([base[0] + dx, base[1] + dy, base[2] + dz].join(','));
          if (!list) continue;
          for (const g of list) {
            const q = verts[g];
            if (Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) <= tolMm) return g;
          }
        }
    const g = verts.length;
    verts.push(p);
    const k = key(p);
    let list = buckets.get(k);
    if (!list) buckets.set(k, (list = []));
    list.push(g);
    return g;
  };
  const partVertToGlobal = parts.map((part) => part.verts.map(globalOf));
  const tris = [];
  parts.forEach((part, pi) => {
    part.tris.forEach((t, ti) => {
      tris.push({ part: pi, localTri: ti, lv: t, v: t.map((li) => partVertToGlobal[pi][li]) });
    });
  });
  const weld = { verts, tris };
  return seamTolMm > tolMm ? stitchSeams(weld, seamTolMm) : weld;
}

/**
 * Join the parts across their printed seams: merge pairs of welded vertices that belong to
 * different parts, sit within `tolMm`, and whose surfaces face the same way. Returns a new
 * {verts, tris, seamStitches} — part-local `lv`/`localTri` on every triangle are untouched, which
 * is the whole point: zone growth and the unwrap see one continuous surface while the emitted
 * charts still index each part's own packed mesh.
 *
 * Two guards keep this from damaging the surface:
 *  - **facing** — a vertex pair is only merged when its parts' surface normals there agree
 *    (dot > SEAM_NORMAL_DOT). Parts that overlap face-to-face (a tab in a slot) have opposed
 *    normals across a gap this size, and fusing those would weld a part's outer skin to its
 *    neighbour's inner one. It does NOT catch two parts stacked parallel and same-facing a
 *    clearance apart — those look exactly like one surface from here. Keep `seamWeldTolMm` at the
 *    measured contact gap and check the per-seam stitch counts the bake logs.
 *  - **one vertex per part per group** — a merge is rejected when both groups already touch a
 *    common part, so no two vertices of one part are ever pulled together through a shared
 *    neighbour on the other side. Checking this pairwise on the candidate is not enough: two
 *    vertices of a part that share no triangle can each merge with the *same* vertex opposite and
 *    meet transitively, which folds the pair of faces between them onto each other. Cheapest
 *    merges are taken first, so the closest pairing wins the competition for a given vertex.
 */
function stitchSeams({ verts, tris }, tolMm) {
  const normals = verts.map(() => [0, 0, 0]);
  const owners = verts.map(() => new Set());
  for (const t of tris) {
    const g = triNormalArea(verts, t);
    for (const v of t.v) {
      owners[v].add(t.part);
      if (g) for (let k = 0; k < 3; k++) normals[v][k] += g.normal[k] * g.area;
    }
  }
  const unit = normals.map((n) => {
    const l = Math.hypot(n[0], n[1], n[2]);
    return l > 1e-12 ? [n[0] / l, n[1] / l, n[2] / l] : null;
  });

  const grid = new Map();
  const cell = (p) =>
    `${Math.floor(p[0] / tolMm)},${Math.floor(p[1] / tolMm)},${Math.floor(p[2] / tolMm)}`;
  verts.forEach((p, g) => {
    const k = cell(p);
    let l = grid.get(k);
    if (!l) grid.set(k, (l = []));
    l.push(g);
  });
  const candidates = [];
  verts.forEach((p, g) => {
    const b = [0, 1, 2].map((k) => Math.floor(p[k] / tolMm));
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          for (const h of grid.get(`${b[0] + dx},${b[1] + dy},${b[2] + dz}`) ?? []) {
            if (h <= g) continue;
            // already one vertex of both parts, or the same part on both sides — nothing to stitch
            if ([...owners[g]].some((o) => owners[h].has(o))) continue;
            const q = verts[h];
            const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
            if (d > tolMm) continue;
            if (!unit[g] || !unit[h] || dot3(unit[g], unit[h]) <= SEAM_NORMAL_DOT) continue;
            candidates.push([d, g, h]);
          }
        }
  });
  candidates.sort((a, b) => a[0] - b[0]);

  const parent = verts.map((_, i) => i);
  const find = (a) => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  // parts touched by a whole group, seeded lazily from the per-vertex sets — only roots that
  // actually take part in a merge ever get an entry
  const groupOwners = new Map();
  const ownersOf = (r) => {
    let s = groupOwners.get(r);
    if (!s) groupOwners.set(r, (s = new Set(owners[r])));
    return s;
  };
  const seamStitches = new Map();
  for (const [, g, h] of candidates) {
    const a = find(g),
      b = find(h);
    if (a === b) continue;
    const oa = ownersOf(a),
      ob = ownersOf(b);
    const [small, large] = oa.size <= ob.size ? [oa, ob] : [ob, oa];
    let clash = false;
    for (const p of small)
      if (large.has(p)) {
        clash = true;
        break;
      }
    if (clash) continue;
    parent[a] = b;
    for (const p of oa) ob.add(p);
    groupOwners.set(b, ob);
    const pk = [...owners[g]][0] + '-' + [...owners[h]][0];
    seamStitches.set(pk, (seamStitches.get(pk) ?? 0) + 1);
  }

  // compact: one vertex per group, at the mean of its members (the two parts' surfaces are meant
  // to be the same place, so averaging is the honest representative)
  const remap = new Int32Array(verts.length).fill(-1);
  const outVerts = [];
  const acc = new Map();
  for (let i = 0; i < verts.length; i++) {
    const r = find(i);
    let slot = remap[r];
    if (slot === -1) {
      slot = remap[r] = outVerts.length;
      outVerts.push([0, 0, 0]);
      acc.set(slot, 0);
    }
    for (let k = 0; k < 3; k++) outVerts[slot][k] += verts[i][k];
    acc.set(slot, acc.get(slot) + 1);
    remap[i] = slot;
  }
  outVerts.forEach((p, i) => {
    const n = acc.get(i);
    for (let k = 0; k < 3; k++) p[k] /= n;
  });
  return {
    verts: outVerts,
    tris: tris.map((t) => ({ ...t, v: t.v.map((g) => remap[g]) })),
    seamStitches,
  };
}

function triNormalArea(verts, tri) {
  const [a, b, c] = tri.v.map((g) => verts[g]);
  const n = cross3(sub3(b, a), sub3(c, a));
  const l = Math.hypot(n[0], n[1], n[2]);
  if (l < 1e-9) return null;
  return { normal: [n[0] / l, n[1] / l, n[2] / l], area: l / 2 };
}

const edgeKey = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
const dirKey = (a, b) => `${a},${b}`;

function buildEdgeTris(tris) {
  const edgeTris = new Map();
  tris.forEach((t, ti) => {
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(t.v[k], t.v[(k + 1) % 3]);
      let list = edgeTris.get(key);
      if (!list) edgeTris.set(key, (list = []));
      list.push(ti);
    }
  });
  return edgeTris;
}

/**
 * BFS from the seeded patch across shared edges, accepting triangles whose face normal stays
 * within maxAngleDeg of the config's seed direction. Returns global triangle indices, sorted.
 */
export function segmentZone(weld, zoneCfg, patches, edgeTris, triGeom) {
  let seedTris;
  let growNormal;
  if (zoneCfg.seedNormal) {
    const sn = norm3(zoneCfg.seedNormal);
    // Same "is this the face I mean" threshold the template generator uses against the app's
    // defaultPatchIdx selection: first area-ranked patch whose normal dots > 0.9.
    const patch = patches.find((p) => dot3(p.normal, sn) > 0.9);
    if (!patch)
      throw new Error(
        `zone "${zoneCfg.id}": no flat patch points along seedNormal [${zoneCfg.seedNormal}]`,
      );
    seedTris = patch.triIndices;
    growNormal = sn;
  } else if (zoneCfg.seedPoint) {
    let best = -1;
    let bestD = Infinity;
    weld.tris.forEach((t, ti) => {
      if (!triGeom[ti]) return;
      const c = [0, 1, 2].map(
        (k) => (weld.verts[t.v[0]][k] + weld.verts[t.v[1]][k] + weld.verts[t.v[2]][k]) / 3,
      );
      const d = Math.hypot(...sub3(c, zoneCfg.seedPoint));
      if (d < bestD) {
        bestD = d;
        best = ti;
      }
    });
    if (best < 0) throw new Error(`zone "${zoneCfg.id}": mesh has no usable triangles`);
    seedTris = [best];
    growNormal = triGeom[best].normal;
  } else {
    throw new Error(`zone "${zoneCfg.id}" needs a seedNormal or seedPoint`);
  }
  const cosMax = Math.cos((zoneCfg.maxAngleDeg * Math.PI) / 180);
  const inZone = new Set();
  const queue = [];
  for (const ti of seedTris)
    if (triGeom[ti] && dot3(triGeom[ti].normal, growNormal) >= cosMax) {
      inZone.add(ti);
      queue.push(ti);
    }
  if (!inZone.size)
    throw new Error(`zone "${zoneCfg.id}": seed patch has no triangles within maxAngleDeg`);
  while (queue.length) {
    const ti = queue.pop();
    const t = weld.tris[ti];
    for (let k = 0; k < 3; k++) {
      for (const nb of edgeTris.get(edgeKey(t.v[k], t.v[(k + 1) % 3]))) {
        if (inZone.has(nb) || !triGeom[nb]) continue;
        if (dot3(triGeom[nb].normal, growNormal) < cosMax) continue;
        inZone.add(nb);
        queue.push(nb);
      }
    }
  }
  return [...inZone].sort((a, b) => a - b);
}

function assertSingleIsland(zoneId, zoneTris, weld, edgeTris) {
  const inZone = new Set(zoneTris);
  const seen = new Set([zoneTris[0]]);
  const queue = [zoneTris[0]];
  while (queue.length) {
    const ti = queue.pop();
    const t = weld.tris[ti];
    for (let k = 0; k < 3; k++)
      for (const nb of edgeTris.get(edgeKey(t.v[k], t.v[(k + 1) % 3])))
        if (inZone.has(nb) && !seen.has(nb)) {
          seen.add(nb);
          queue.push(nb);
        }
  }
  if (seen.size !== zoneTris.length)
    throw new Error(
      `zone "${zoneId}" is not a single connected island (${seen.size} of ${zoneTris.length} ` +
        `triangles reachable from the seed) — tighten maxAngleDeg or move the seed`,
    );
}

/** Local orthonormal 2D frame of a triangle: P1=(0,0), P2=(a,0), P3=(x3,y3), y3 > 0. */
function localFrame(p1, p2, p3) {
  const e1 = sub3(p2, p1);
  const e2 = sub3(p3, p1);
  const a = Math.hypot(...e1);
  if (!(a > 1e-9)) return null;
  const xhat = [e1[0] / a, e1[1] / a, e1[2] / a];
  const n = cross3(e1, e2);
  const twoA = Math.hypot(...n);
  if (!(twoA > 1e-12)) return null;
  const nhat = [n[0] / twoA, n[1] / twoA, n[2] / twoA];
  const yhat = cross3(nhat, xhat);
  return { a, x3: dot3(e2, xhat), y3: dot3(e2, yhat), xhat, yhat, twoA };
}

/**
 * Least-squares conformal map of a triangulated disk (holes allowed). Two boundary vertices are
 * pinned at their 3D separation to remove the similarity ambiguity; everything else is solved by
 * conjugate gradient on the normal equations with a Jacobi preconditioner. Returns UVs in an
 * arbitrary similarity frame — orientChart makes them true-mm and convention-correct.
 */
export function lscm(verts3, tris) {
  const nV = verts3.length;
  const edgeCount = new Map();
  for (const t of tris)
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(t[k], t[(k + 1) % 3]);
      edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
    }
  const boundary = new Set();
  edgeCount.forEach((cnt, key) => {
    if (cnt === 1) key.split(',').forEach((v) => boundary.add(+v));
  });
  if (!boundary.size)
    throw new Error('zone surface is closed (no boundary) — it cannot be unwrapped into a chart');
  const bVerts = [...boundary];
  const farthestFrom = (i) => {
    let best = i;
    let bestD = -1;
    for (const j of bVerts) {
      const d = Math.hypot(...sub3(verts3[j], verts3[i]));
      if (d > bestD) {
        bestD = d;
        best = j;
      }
    }
    return [best, bestD];
  };
  const [pinA] = farthestFrom(bVerts[0]);
  const [pinB, pinDist] = farthestFrom(pinA);
  const pinUV = new Map([
    [pinA, [0, 0]],
    [pinB, [pinDist, 0]],
  ]);

  const unk = new Int32Array(nV).fill(-1);
  let nUnk = 0;
  for (let i = 0; i < nV; i++) if (!pinUV.has(i)) unk[i] = 2 * nUnk++;
  nUnk *= 2;

  const rows = [];
  for (const t of tris) {
    const f = localFrame(verts3[t[0]], verts3[t[1]], verts3[t[2]]);
    if (!f) continue;
    const w = 1 / Math.sqrt(f.twoA);
    // Complex LSCM coefficients per corner, from the local coords (0,0), (a,0), (x3,y3).
    const W = [
      [f.x3 - f.a, f.y3],
      [-f.x3, -f.y3],
      [f.a, 0],
    ];
    const re = { idx: [], a: [], b: 0 };
    const im = { idx: [], a: [], b: 0 };
    for (let k = 0; k < 3; k++) {
      const [wr, wi] = [w * W[k][0], w * W[k][1]];
      const pin = pinUV.get(t[k]);
      if (pin) {
        re.b -= wr * pin[0] - wi * pin[1];
        im.b -= wi * pin[0] + wr * pin[1];
      } else {
        const j = unk[t[k]];
        re.idx.push(j, j + 1);
        re.a.push(wr, -wi);
        im.idx.push(j, j + 1);
        im.a.push(wi, wr);
      }
    }
    rows.push(re, im);
  }

  const x = solveNormalCG(rows, nUnk);
  const uv = new Float64Array(2 * nV);
  for (let i = 0; i < nV; i++) {
    const pin = pinUV.get(i);
    if (pin) {
      uv[2 * i] = pin[0];
      uv[2 * i + 1] = pin[1];
    } else {
      uv[2 * i] = x[unk[i]];
      uv[2 * i + 1] = x[unk[i] + 1];
    }
  }
  return uv;
}

function solveNormalCG(rows, nUnk) {
  const x = new Float64Array(nUnk);
  const diag = new Float64Array(nUnk);
  for (const r of rows) for (let k = 0; k < r.idx.length; k++) diag[r.idx[k]] += r.a[k] * r.a[k];
  // A vertex whose every incident triangle was degenerate has an all-zero column; pin it at 0
  // instead of dividing by zero in the preconditioner.
  for (let i = 0; i < nUnk; i++) if (!(diag[i] > 0)) diag[i] = 1;
  const m = rows.length;
  const Av = (v, out) => {
    for (let i = 0; i < m; i++) {
      const r = rows[i];
      let s = 0;
      for (let k = 0; k < r.idx.length; k++) s += r.a[k] * v[r.idx[k]];
      out[i] = s;
    }
  };
  const ATv = (y, out) => {
    out.fill(0);
    for (let i = 0; i < m; i++) {
      const r = rows[i];
      for (let k = 0; k < r.idx.length; k++) out[r.idx[k]] += r.a[k] * y[i];
    }
  };
  const dotV = (a, b) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  };
  const tmp = new Float64Array(m);
  for (let i = 0; i < m; i++) tmp[i] = rows[i].b;
  const res = new Float64Array(nUnk);
  ATv(tmp, res); // residual of the normal equations at x = 0
  const z = new Float64Array(nUnk);
  const q = new Float64Array(nUnk);
  for (let i = 0; i < nUnk; i++) z[i] = res[i] / diag[i];
  const p = Float64Array.from(z);
  let rz = dotV(res, z);
  const rz0 = rz;
  if (!(rz0 > 0)) return x;
  const maxIter = Math.max(2000, nUnk * 4);
  let iter = 0;
  for (; iter < maxIter; iter++) {
    Av(p, tmp);
    ATv(tmp, q);
    const pq = dotV(p, q);
    if (!(pq > 0)) break;
    const alpha = rz / pq;
    for (let i = 0; i < nUnk; i++) {
      x[i] += alpha * p[i];
      res[i] -= alpha * q[i];
    }
    for (let i = 0; i < nUnk; i++) z[i] = res[i] / diag[i];
    const rzNew = dotV(res, z);
    if (Math.sqrt(rzNew / rz0) < 1e-10) break;
    const beta = rzNew / rz;
    rz = rzNew;
    for (let i = 0; i < nUnk; i++) p[i] = z[i] + beta * p[i];
  }
  if (iter >= maxIter)
    throw new Error(
      `LSCM solve did not converge in ${maxIter} iterations (relative residual ` +
        `${Math.sqrt(rz / rz0).toExponential(2)}) — the zone mesh is likely degenerate`,
    );
  return x;
}

/**
 * Normalize a raw LSCM island to the ConformalChart convention, in place:
 *   1. mirror (negate u) if triangles wound CCW-from-outside read CW in UV, so UV is the surface
 *      seen from outside and normalSign is always +1;
 *   2. rotate so the config's 3D `up` direction, pulled back through each triangle's tangent
 *      map (area-weighted), points along +v;
 *   3. uniformly scale to true mm by least squares on 3D-vs-UV edge lengths;
 *   4. translate the bbox min corner to (0,0).
 * Returns { scale, distortion: { max, mean }, flipped } — flipped counts triangles whose UV image
 * is inverted (a fold), which makes the chart unusable and the caller must reject.
 */
export function orientChart(verts3, tris, uv, up) {
  const upN = norm3(up);
  let signedArea2 = 0;
  for (const t of tris)
    signedArea2 +=
      (uv[2 * t[1]] - uv[2 * t[0]]) * (uv[2 * t[2] + 1] - uv[2 * t[0] + 1]) -
      (uv[2 * t[2]] - uv[2 * t[0]]) * (uv[2 * t[1] + 1] - uv[2 * t[0] + 1]);
  if (signedArea2 < 0) for (let i = 0; i < uv.length; i += 2) uv[i] = -uv[i];

  let du = 0;
  let dv = 0;
  let totalArea = 0;
  for (const t of tris) {
    const f = localFrame(verts3[t[0]], verts3[t[1]], verts3[t[2]]);
    if (!f) continue;
    // J maps the triangle's local 2D frame to UV: col1 from edge (a,0), col2 solved from (x3,y3).
    const j11 = (uv[2 * t[1]] - uv[2 * t[0]]) / f.a;
    const j21 = (uv[2 * t[1] + 1] - uv[2 * t[0] + 1]) / f.a;
    const j12 = (uv[2 * t[2]] - uv[2 * t[0]] - j11 * f.x3) / f.y3;
    const j22 = (uv[2 * t[2] + 1] - uv[2 * t[0] + 1] - j21 * f.x3) / f.y3;
    const ux = dot3(upN, f.xhat);
    const uy = dot3(upN, f.yhat);
    const area = f.twoA / 2;
    du += (j11 * ux + j12 * uy) * area;
    dv += (j21 * ux + j22 * uy) * area;
    totalArea += area;
  }
  const mag = Math.hypot(du, dv);
  if (!(mag > 1e-3 * totalArea))
    throw new Error(
      `zone "up" direction [${up}] is nearly perpendicular to the surface everywhere — ` +
        `pick an up that lies along the zone`,
    );
  const cos = dv / mag;
  const sin = du / mag;
  for (let i = 0; i < uv.length; i += 2) {
    const u = uv[i];
    const v = uv[i + 1];
    uv[i] = cos * u - sin * v;
    uv[i + 1] = sin * u + cos * v;
  }

  const edges = new Set();
  for (const t of tris) for (let k = 0; k < 3; k++) edges.add(edgeKey(t[k], t[(k + 1) % 3]));
  let num = 0;
  let den = 0;
  for (const key of edges) {
    const [a, b] = key.split(',').map(Number);
    const l3 = Math.hypot(...sub3(verts3[a], verts3[b]));
    const luv = Math.hypot(uv[2 * a] - uv[2 * b], uv[2 * a + 1] - uv[2 * b + 1]);
    num += l3 * luv;
    den += luv * luv;
  }
  // NaN here would sail through every later comparison (flipped-triangle checks included) and
  // poison the sidecar silently, so a collapsed solve must stop the bake.
  if (!(den > 0))
    throw new Error('LSCM solution collapsed to a point — the zone mesh is degenerate');
  const scale = num / den;
  for (let i = 0; i < uv.length; i++) uv[i] *= scale;

  let dMax = 1;
  let dSum = 0;
  let dCount = 0;
  for (const key of edges) {
    const [a, b] = key.split(',').map(Number);
    const l3 = Math.hypot(...sub3(verts3[a], verts3[b]));
    if (!(l3 > 1e-9)) continue;
    const luv = Math.hypot(uv[2 * a] - uv[2 * b], uv[2 * a + 1] - uv[2 * b + 1]);
    const r = luv / l3;
    const d = Math.max(r, 1 / r);
    if (d > dMax) dMax = d;
    dSum += d;
    dCount++;
  }

  let minU = Infinity;
  let minV = Infinity;
  for (let i = 0; i < uv.length; i += 2) {
    if (uv[i] < minU) minU = uv[i];
    if (uv[i + 1] < minV) minV = uv[i + 1];
  }
  for (let i = 0; i < uv.length; i += 2) {
    uv[i] -= minU;
    uv[i + 1] -= minV;
  }

  let flipped = 0;
  for (const t of tris) {
    const s =
      (uv[2 * t[1]] - uv[2 * t[0]]) * (uv[2 * t[2] + 1] - uv[2 * t[0] + 1]) -
      (uv[2 * t[2]] - uv[2 * t[0]]) * (uv[2 * t[1] + 1] - uv[2 * t[0] + 1]);
    if (s <= 0) flipped++;
  }
  return { scale, distortion: { max: dMax, mean: dCount ? dSum / dCount : 1 }, flipped };
}

/**
 * Split a loop that touches itself at a vertex into simple sub-loops, so every ring handed to
 * turf is a plain polygon. A figure-eight ring has a well-defined area but no reliable inside.
 */
function splitAtRepeats(loop) {
  const out = [];
  const stack = [];
  const at = new Map();
  for (const v of loop) {
    const prev = at.get(v);
    if (prev !== undefined) {
      const sub = stack.splice(prev);
      for (const w of sub) at.delete(w);
      if (sub.length >= 3) out.push(sub);
    }
    at.set(v, stack.length);
    stack.push(v);
  }
  if (stack.length >= 3) out.push(stack);
  return out;
}

/**
 * Chain the once-used (boundary) directed edges of a triangle subset into closed vertex loops.
 * With outward-consistent winding the outer loop comes out CCW in UV and holes CW.
 *
 * Successors are keyed by the directed edge, not by its tail vertex, and resolved by rotating
 * through the triangle fan around that vertex. A *pinch* vertex -- one the boundary passes
 * through more than once, where two wedges of the zone meet at a single point -- has several
 * outgoing boundary edges; a Map keyed by tail vertex keeps only the last, so every loop through
 * the others breaks open and gets emitted as a fragment. That is what left the chair's `right`
 * zone with no loop spanning the chart and holes enclosing more area than the outer ring.
 * Rotating the fan instead walks each boundary edge exactly once.
 */
export function boundaryVertexLoops(tris) {
  const count = new Map();
  const third = new Map();
  for (const t of tris)
    for (let k = 0; k < 3; k++) {
      const a = t[k];
      const b = t[(k + 1) % 3];
      const key = edgeKey(a, b);
      count.set(key, (count.get(key) || 0) + 1);
      third.set(dirKey(a, b), t[(k + 2) % 3]);
    }
  const isBoundary = (a, b) => count.get(edgeKey(a, b)) === 1;

  // The boundary edge following a→b: start at the triangle carrying a→b and pivot around b
  // through its fan until an outgoing edge of b is itself boundary.
  const nextVert = (a, b) => {
    let x = a;
    for (let guard = 0; guard < 1e6; guard++) {
      const c = third.get(dirKey(x, b));
      if (c === undefined) return null;
      if (isBoundary(b, c)) return c;
      x = c;
    }
    return null;
  };

  const loops = [];
  const walked = new Set();
  for (const t of tris)
    for (let k = 0; k < 3; k++) {
      let a = t[k];
      let b = t[(k + 1) % 3];
      if (!isBoundary(a, b) || walked.has(dirKey(a, b))) continue;
      const loop = [];
      for (let guard = 0; guard < 1e6; guard++) {
        loop.push(a);
        walked.add(dirKey(a, b));
        const c = nextVert(a, b);
        if (c === null) break;
        a = b;
        b = c;
        if (walked.has(dirKey(a, b))) break;
      }
      if (loop.length >= 3) loops.push(...splitAtRepeats(loop));
    }
  return loops;
}

function perpDist(p, a, b) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const l2 = abx * abx + aby * aby;
  if (!(l2 > 0)) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs((p[0] - a[0]) * aby - (p[1] - a[1]) * abx) / Math.sqrt(l2);
}

function dpSimplify(pts, first, last, tol, keep) {
  let worst = -1;
  let worstD = tol;
  for (let i = first + 1; i < last; i++) {
    const d = perpDist(pts[i], pts[first], pts[last]);
    if (d > worstD) {
      worstD = d;
      worst = i;
    }
  }
  if (worst < 0) return;
  keep.add(worst);
  dpSimplify(pts, first, worst, tol, keep);
  dpSimplify(pts, worst, last, tol, keep);
}

/** Douglas–Peucker on a closed loop: anchor at the two farthest-apart points, simplify each arc. */
export function simplifyLoop(pts, tol) {
  if (pts.length <= 4) return pts;
  let far = 1;
  let farD = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const keep = new Set([0, far]);
  dpSimplify(pts, 0, far, tol, keep);
  dpSimplify([...pts, pts[0]], far, pts.length, tol, keep);
  keep.delete(pts.length);
  return [...keep].sort((a, b) => a - b).map((i) => pts[i]);
}

/** Simplify an open polyline (a seam) with the same DP tolerance. */
function simplifyPolyline(pts, tol) {
  if (pts.length <= 2) return pts;
  const keep = new Set([0, pts.length - 1]);
  dpSimplify(pts, 0, pts.length - 1, tol, keep);
  return [...keep].sort((a, b) => a - b).map((i) => pts[i]);
}

const loopArea = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
};

const pointInLoop = ([px, py], loop) => {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i];
    const [xj, yj] = loop[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

/**
 * Group boundary loops into {outer, holes} regions by containment depth — even depth is a solid
 * island of its own, odd depth is a hole in its immediate parent. A part's slice of a zone can be
 * several disjoint islands (a stripe of surface interrupted by a bolt boss, say), so "largest loop
 * is the outline, everything else is a hole" isn't good enough here; depth is the same rule
 * shapeToFeature applies to SVG subpaths at runtime.
 */
function classifyRegions(loops) {
  const n = loops.length;
  const areas = loops.map((l) => Math.abs(loopArea(l)));
  const parent = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let best = Infinity;
    for (let j = 0; j < n; j++) {
      if (i === j || areas[j] <= areas[i] || areas[j] >= best) continue;
      if (!pointInLoop(loops[i][0], loops[j])) continue;
      best = areas[j];
      parent[i] = j;
    }
  }
  const depth = (i) => {
    let d = 0;
    for (let p = parent[i]; p !== -1; p = parent[p]) d++;
    return d;
  };
  const regions = [];
  const regionOf = new Map();
  for (let i = 0; i < n; i++)
    if (depth(i) % 2 === 0) {
      regionOf.set(i, regions.length);
      regions.push({ outer: loops[i], holes: [] });
    }
  for (let i = 0; i < n; i++)
    if (depth(i) % 2 === 1) regions[regionOf.get(parent[i])].holes.push(loops[i]);
  return regions;
}

/** Chain undirected [a,b] vertex-pair edges into open paths and cycles. */
function chainEdges(edges) {
  const adj = new Map();
  const add = (a, b) => {
    let l = adj.get(a);
    if (!l) adj.set(a, (l = []));
    l.push(b);
  };
  for (const [a, b] of edges) {
    add(a, b);
    add(b, a);
  }
  const usedEdge = new Set();
  const takeStep = (a) => {
    for (const b of adj.get(a) || []) {
      const key = edgeKey(a, b);
      if (!usedEdge.has(key)) {
        usedEdge.add(key);
        return b;
      }
    }
    return null;
  };
  const paths = [];
  const walk = (start) => {
    const path = [start];
    let cur = start;
    for (;;) {
      const nxt = takeStep(cur);
      if (nxt === null) break;
      path.push(nxt);
      cur = nxt;
    }
    if (path.length > 1) paths.push(path);
  };
  // open paths first (from odd-degree endpoints), then whatever remains is a cycle
  for (const [v, nbs] of adj) if (nbs.length % 2 === 1) walk(v);
  for (const v of adj.keys()) walk(v);
  return paths;
}

const xmlEscape = (s) =>
  s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

/**
 * True-size template SVG for one zone: the grey silhouette is the zone's UV outline with holes
 * punched (evenodd), dashed accent polylines mark printed-part seams. SVG y runs down while v
 * runs up, so v is flipped — the app's placer maps SVG y-down to −v the same way, which keeps a
 * template loaded at Scale 100% / Offset 0/0 landing exactly on the zone.
 */
export function zoneTemplateSVG(zone, kindId, chartBBox) {
  // Canvas = the FULL chart UV bbox, not the simplified boundary's — the runtime centers artwork
  // on the chart bbox, and simplification can shave up to SIMPLIFY_TOL_MM off an extreme point,
  // which would quietly de-center every template by half that.
  // ceil to 0.1mm with an epsilon so float dust (100.000000000001) doesn't inflate the canvas
  const up01 = (v) => Math.ceil(v * 10 - 1e-6) / 10;
  const W = up01(chartBBox.maxU);
  const H = up01(chartBBox.maxV);
  const pt = ([u, v]) => [round(u, 2), round(H - v, 2)];
  const toD = (pts) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ') + ' Z';
  const d = [zone.boundary, ...(zone.holes || [])].map((loop) => toD(loop.map(pt))).join(' ');
  const seams = (zone.seams || [])
    .map(
      (line) =>
        `  <polyline points="${line.map((p) => pt(p).join(',')).join(' ')}" fill="none" ` +
        `stroke="${ACCENT}" stroke-width="0.6" stroke-dasharray="2 3"/>`,
    )
    .join('\n');
  const seamNote = zone.seams?.length
    ? `\n  <text x="${W / 2}" y="${Math.min(H - 4, 24)}" text-anchor="middle" ` +
      `font-family="sans-serif" font-size="${LABEL_SIZE}" fill="${ACCENT}">dashed = printed-part seam</text>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!--
  ${xmlEscape(zone.name)} design zone template (${kindId}) — true-to-size at 1:1 mm (${W} x ${H}mm).
  The grey shape is the zone's unwrapped printable surface; the app clips artwork to exactly this
  outline and wraps it back onto the 3D part. Load it at Scale 100%, Offset 0/0 and it lands
  centered on the zone without adjustment. Gaps punched in the grey are real holes.

  GENERATED by scripts/bake-zones.mjs - do not hand-edit; re-run the bake to regenerate.
-->
<svg width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}" version="1.1"
     xmlns="http://www.w3.org/2000/svg">
  <path d="${d}" fill="${GRAY}" fill-rule="evenodd" />
${seams}
  <text x="${W / 2}" y="${Math.min(H - 4, 12)}" text-anchor="middle" font-family="sans-serif"
        font-size="${LABEL_SIZE}" fill="${ACCENT}">${xmlEscape(zone.name)}</text>${seamNote}
</svg>
`;
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Guard fingerprint: refuses at load time to pair zones with a mesh they weren't baked for. */
export function meshFingerprint(part) {
  const bb = [
    [Infinity, Infinity, Infinity],
    [-Infinity, -Infinity, -Infinity],
  ];
  for (const v of part.verts)
    for (let k = 0; k < 3; k++) {
      if (v[k] < bb[0][k]) bb[0][k] = v[k];
      if (v[k] > bb[1][k]) bb[1][k] = v[k];
    }
  const sig = `${part.tris.length}|${bb
    .flat()
    .map((v) => v.toFixed(3))
    .join(',')}`;
  return { triangleCount: part.tris.length, bboxHash: fnv1a(sig) };
}

function validateConfig(config) {
  if (config.schema !== 1) throw new Error(`unsupported zone config schema ${config.schema}`);
  if (!config.kindId) throw new Error('zone config needs a kindId');
  if (!Array.isArray(config.parts) || !config.parts.length)
    throw new Error('zone config needs a non-empty parts list');
  if (!Array.isArray(config.zones) || !config.zones.length)
    throw new Error('zone config needs a non-empty zones list');
  if (
    config.seamWeldTolMm !== undefined &&
    !(config.seamWeldTolMm > (config.weldTolMm ?? WELD_TOL_MM))
  )
    throw new Error('seamWeldTolMm must be larger than weldTolMm to stitch anything');
  const ids = new Set();
  for (const z of config.zones) {
    if (!z.id || !z.name) throw new Error('every zone needs an id and a name');
    if (ids.has(z.id)) throw new Error(`duplicate zone id "${z.id}"`);
    ids.add(z.id);
    if (!(z.maxAngleDeg > 0 && z.maxAngleDeg <= 180))
      throw new Error(`zone "${z.id}": maxAngleDeg must be in (0, 180]`);
    if (!Array.isArray(z.up) || z.up.length !== 3)
      throw new Error(`zone "${z.id}": up must be a 3D direction`);
  }
}

/**
 * The whole bake, in memory: parts is [{ libraryPartId, verts: [x,y,z][], tris: [i,j,k][] }] in
 * packed-file index order and the assembled pose. Returns { sidecar, templates, warnings }.
 */
export function bakeZones(config, parts, log = () => {}) {
  validateConfig(config);
  if (
    parts.length !== config.parts.length ||
    parts.some((p, i) => p.libraryPartId !== config.parts[i].libraryPartId)
  )
    throw new Error('parts array does not match config.parts (same ids, same order, required)');
  const warnings = [];
  const weld = weldParts(parts, config.weldTolMm ?? WELD_TOL_MM, config.seamWeldTolMm ?? 0);
  const triGeom = weld.tris.map((t) => triNormalArea(weld.verts, t));
  const soup = new Float32Array(weld.tris.length * 9);
  weld.tris.forEach((t, ti) => {
    for (let k = 0; k < 3; k++) soup.set(weld.verts[t.v[k]], ti * 9 + k * 3);
  });
  const patches = detectFlatPatches(soup);
  const edgeTris = buildEdgeTris(weld.tris);
  log(
    `welded ${parts.length} part(s): ${weld.verts.length} vertices, ${weld.tris.length} triangles`,
  );
  // Per-seam stitch counts: a pair with only a handful is a hinge, not a bridge — the unwrap will
  // pivot around it and a zone crossing there will distort. Worth seeing rather than guessing.
  for (const [pk, n] of [...(weld.seamStitches ?? new Map())].sort((a, b) => a[1] - b[1])) {
    const [a, b] = pk.split('-').map((i) => parts[+i].libraryPartId);
    log(`  seam ${a} <-> ${b}: ${n} stitch(es)`);
  }

  const simplifyTol = config.simplifyTolMm ?? SIMPLIFY_TOL_MM;
  const minHoleArea = config.minHoleAreaMm2 ?? MIN_HOLE_AREA_MM2;
  const minIslandArea = config.minIslandAreaMm2 ?? MIN_ISLAND_AREA_MM2;
  const zones = [];
  const templates = [];
  for (const zoneCfg of config.zones) {
    const zoneTris = segmentZone(weld, zoneCfg, patches, edgeTris, triGeom);
    assertSingleIsland(zoneCfg.id, zoneTris, weld, edgeTris);

    const globalToZone = new Map();
    const zoneVerts3 = [];
    const zTris = zoneTris.map((ti) =>
      weld.tris[ti].v.map((g) => {
        let z = globalToZone.get(g);
        if (z === undefined) {
          z = zoneVerts3.length;
          zoneVerts3.push(weld.verts[g]);
          globalToZone.set(g, z);
        }
        return z;
      }),
    );

    const uv = lscm(zoneVerts3, zTris);
    const stats = orientChart(zoneVerts3, zTris, uv, zoneCfg.up);
    if (stats.flipped)
      throw new Error(
        `zone "${zoneCfg.id}": ${stats.flipped} triangle(s) fold over in UV — the zone is too ` +
          `curved to unwrap as one chart; lower maxAngleDeg or split it`,
      );
    if (stats.distortion.max > DISTORTION_WARN)
      warnings.push(
        `zone "${zoneCfg.id}": max stretch ${stats.distortion.max.toFixed(3)} exceeds ` +
          `${DISTORTION_WARN} — artwork will visibly distort there; consider a smaller zone`,
      );

    const uvOf = (z) => [uv[2 * z], uv[2 * z + 1]];
    const loops = boundaryVertexLoops(zTris)
      .map((loop) => simplifyLoop(loop.map(uvOf), simplifyTol))
      .filter((pts) => pts.length >= 3)
      .map((pts) => ({ pts, area: loopArea(pts) }));
    if (!loops.length) throw new Error(`zone "${zoneCfg.id}": no boundary loop found`);
    loops.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
    const outer = loops[0];
    const holes = loops.slice(1).filter((l) => Math.abs(l.area) >= minHoleArea);
    const roundLoop = (pts) => pts.map((p) => [round(p[0], 3), round(p[1], 3)]);

    // per-part charts: everything indexed part-locally so the runtime can pair a chart with its
    // packed mesh without re-welding
    const byPart = new Map();
    zoneTris.forEach((ti, k) => {
      const pi = weld.tris[ti].part;
      let list = byPart.get(pi);
      if (!list) byPart.set(pi, (list = []));
      list.push({ ti, zTri: zTris[k] });
    });
    const charts = [];
    for (const [pi, list] of [...byPart.entries()].sort((a, b) => a[0] - b[0])) {
      const lvToChart = new Map();
      const cVerts = [];
      const cUV = [];
      const chartTris = [];
      const tris = [];
      for (const { ti, zTri } of list) {
        const t = weld.tris[ti];
        tris.push(t.localTri);
        chartTris.push(
          t.lv.map((lv, k) => {
            let c = lvToChart.get(lv);
            if (c === undefined) {
              c = cVerts.length;
              cVerts.push(lv);
              cUV.push(round(uv[2 * zTri[k]], 4), round(uv[2 * zTri[k] + 1], 4));
              lvToChart.set(lv, c);
            }
            return c;
          }),
        );
      }
      // This part's own slice of the zone in UV, as proper outer/hole regions. Once a zone spans a
      // printed seam this is what each part's cutter must be clipped to — clipping to the whole
      // zone outline instead pushes artwork past the part's own chart, where the warp reports it
      // off-chart and the color silently vanishes from both parts.
      const subLoops = boundaryVertexLoops(list.map((e) => e.zTri))
        .map((loop) => simplifyLoop(loop.map(uvOf), simplifyTol))
        .filter((pts) => pts.length >= 3);
      const allRegions = classifyRegions(subLoops)
        .map((r) => ({
          outer: roundLoop(r.outer),
          holes: r.holes.filter((h) => Math.abs(loopArea(h)) >= minHoleArea).map(roundLoop),
          area: Math.abs(loopArea(r.outer)),
        }))
        .sort((a, b) => b.area - a.area);
      // Islands get their own (much smaller) threshold — dropping one deletes design surface, so
      // only tessellation dust may go, and never the largest island. Anything dropped is reported:
      // artwork over it would be silently intersected away at runtime with no other signal.
      const dropped = allRegions.filter((r, i) => i > 0 && r.area < minIslandArea);
      if (dropped.length)
        warnings.push(
          `zone "${zoneCfg.id}" part "${parts[pi].libraryPartId}": dropped ${dropped.length} ` +
            `sliver island(s) under ${minIslandArea}mm² (largest ${dropped[0].area.toFixed(3)}mm²) ` +
            `from the clip region — artwork placed there will not cut`,
        );
      const subRegions = allRegions
        .filter((r, i) => i === 0 || r.area >= minIslandArea)
        .map(({ outer, holes }) => ({ outer, holes }));
      // An empty list would read at runtime as "no per-part clipping" and silently fall back to the
      // whole zone outline — the exact failure subRegions exists to prevent. Fail the bake instead.
      if (!subRegions.length)
        throw new Error(
          `zone "${zoneCfg.id}": part "${parts[pi].libraryPartId}" contributes triangles but no ` +
            `usable boundary loop — cannot build its clip region`,
        );
      charts.push({
        libraryPartId: parts[pi].libraryPartId,
        tris,
        verts: cVerts,
        uv: cUV,
        chartTris,
        subRegions,
      });
    }

    // seams: zone-interior edges whose two triangles belong to different printed parts
    const zoneSet = new Set(zoneTris);
    const seamEdges = [];
    const seen = new Set();
    for (const ti of zoneTris) {
      const t = weld.tris[ti];
      for (let k = 0; k < 3; k++) {
        const a = t.v[k];
        const b = t.v[(k + 1) % 3];
        const key = edgeKey(a, b);
        if (seen.has(key)) continue;
        seen.add(key);
        const owners = edgeTris.get(key).filter((o) => zoneSet.has(o));
        if (owners.length === 2 && weld.tris[owners[0]].part !== weld.tris[owners[1]].part)
          seamEdges.push([a, b]);
      }
    }
    const seams = chainEdges(seamEdges).map((path) =>
      roundLoop(
        simplifyPolyline(
          path.map((g) => uvOf(globalToZone.get(g))),
          simplifyTol,
        ),
      ),
    );

    // The whole zone's UV bbox — min is exactly (0,0), orientChart translates it there. This is the
    // template's coordinate space, and the runtime anchors placement and fill tiling on it, so it
    // must be measured across ALL of the zone's charts: per-part bboxes differ once a zone spans a
    // seam, and anchoring on those would place the design once per part, each on its own half.
    let maxU = 0;
    let maxV = 0;
    for (let i = 0; i < uv.length; i += 2) {
      if (uv[i] > maxU) maxU = uv[i];
      if (uv[i + 1] > maxV) maxV = uv[i + 1];
    }

    const zone = {
      id: zoneCfg.id,
      name: zoneCfg.name,
      templateFile: `${zoneCfg.id}-template.svg`,
      charts,
      boundary: roundLoop(outer.pts),
      holes: holes.map((l) => roundLoop(l.pts)),
      seams,
      uvBounds: { minU: 0, minV: 0, maxU: round(maxU, 4), maxV: round(maxV, 4) },
      up: [0, 1],
      normalSign: 1,
      distortion: {
        max: round(stats.distortion.max, 4),
        mean: round(stats.distortion.mean, 4),
      },
    };
    zones.push(zone);
    templates.push({
      file: zone.templateFile,
      svg: zoneTemplateSVG(zone, config.kindId, { maxU, maxV }),
    });
    log(
      `zone "${zone.id}": ${zoneTris.length} tris across ${charts.length} part(s), ` +
        `${zone.holes.length} hole(s), ${seams.length} seam(s), stretch max ` +
        `${zone.distortion.max} mean ${zone.distortion.mean}, scale ${stats.scale.toFixed(5)}`,
    );
  }

  const meshes = {};
  config.parts.forEach((p, pi) => {
    meshes[p.libraryPartId] = meshFingerprint(parts[pi]);
  });
  // Sidecar schema 2 (charts carry `subRegions`); independent of the zone *config* schema checked
  // in validateConfig, which is still 1. Must match SIDECAR_SCHEMA in src/geometry/zoneCharts.ts.
  return { sidecar: { schema: 2, kindId: config.kindId, meshes, zones }, templates, warnings };
}
