/**
 * Shared mesh reading, flat-patch analysis, and rigid-transform matching for the part tooling.
 *
 * Used by both .claude/skills/add-part/compare-meshes.mjs (which decides *which* source mesh to
 * ship) and scripts/pack-part.mjs (which writes it). One implementation on purpose — the matcher
 * has a subtle symmetry rule in it that must not exist in two places and drift.
 *
 * Deliberately free of TypeScript imports so compare-meshes.mjs still runs under plain `node`.
 */
import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';

/** Max acceptable per-axis bbox disagreement between two meshes of the same part, in mm. */
export const BBOX_TOL = 0.05;

/**
 * Above this per-axis bbox gap, "same part, coarser tessellation" stops being a plausible story
 * and the tools should stop offering --bbox-tol as a way out. Re-tessellating a curved part moves
 * its extremes by hundredths of a mm (the shipped wheel half: 0.03mm), never by a whole one.
 */
export const TESSELLATION_GAP = 1.0;

export function readBinarySTL(b) {
  if (b.length < 84) return null;
  const triCount = b.readUInt32LE(80);
  if (b.length !== 84 + triCount * 50) return null;
  const positions = new Float32Array(triCount * 9);
  for (let i = 0; i < triCount; i++) {
    const base = 84 + i * 50 + 12;
    for (let k = 0; k < 9; k++) positions[i * 9 + k] = b.readFloatLE(base + k * 4);
  }
  return positions;
}

export function readAsciiSTL(text) {
  const lines = text.match(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g);
  if (!lines) return null;
  if (lines.length % 3)
    throw new Error(`ASCII STL has ${lines.length} vertices, not a whole number of triangles`);
  const positions = new Float32Array(lines.length * 3);
  lines.forEach((line, i) => positions.set(line.trim().split(/\s+/).slice(1).map(Number), i * 3));
  return positions;
}

// Attribute-wise rather than one fixed-order regex: 3MF does not mandate an attribute order, and
// a writer that emits y before x would otherwise read as zero triangles with no error.
const XA = [/\bx="([^"]*)"/, /\by="([^"]*)"/, /\bz="([^"]*)"/];
const TA = [/\bv1="([^"]*)"/, /\bv2="([^"]*)"/, /\bv3="([^"]*)"/];
const attrs = (tag, res) => res.map((r) => +(tag.match(r)?.[1] ?? NaN));

/**
 * Reads only meshes inlined in 3D/3dmodel.model, exactly like load3MF. A Bambu multi-part file
 * that references its mesh via <component p:path> therefore reports zero triangles here too —
 * same failure as the app's, caught before it ships.
 */
export async function read3MF(buf) {
  const zip = await JSZip.loadAsync(buf);
  const model = zip.file('3D/3dmodel.model');
  if (!model) throw new Error('not a valid 3MF: missing 3D/3dmodel.model');
  const xml = await model.async('string');
  if (/p:path=/.test(xml))
    console.warn(
      '  ! uses <component p:path> — load3MF cannot resolve this; not usable as geometry',
    );
  const verts = [];
  const tris = [];
  // Walk one <object> at a time and offset by a per-object base, exactly as load3MF does. Triangle
  // indices are local to their own <mesh>, so reading every <vertex> in the file into one flat
  // list and trusting the raw indices silently returns the first object's geometry N times.
  for (const om of xml.matchAll(/<object\b[^>]*(?:\/>|>([\s\S]*?)<\/object>)/g)) {
    const body = om[1];
    if (!body) continue;
    const base = verts.length;
    for (const v of body.matchAll(/<vertex\b[^>]*>/g)) verts.push(attrs(v[0], XA));
    for (const t of body.matchAll(/<triangle\b[^>]*>/g))
      tris.push(attrs(t[0], TA).map((i) => base + i));
  }
  const positions = new Float32Array(tris.length * 9);
  tris.forEach((t, i) =>
    t.forEach((vi, k) => {
      const v = verts[vi];
      // No silent [0,0,0] fallback: an unresolvable index means the file was parsed wrong, and a
      // vertex quietly pinned to the origin is a spike through the mesh that nothing downstream
      // would flag.
      if (!v) throw new Error(`3MF triangle references vertex ${vi}, which does not exist`);
      positions.set(v, i * 9 + k * 3);
    }),
  );
  return positions;
}

export async function readMesh(file) {
  const buf = fs.readFileSync(file);
  const positions =
    path.extname(file).toLowerCase() === '.3mf'
      ? await read3MF(buf)
      : (readBinarySTL(buf) ?? readAsciiSTL(buf.toString('utf8')));
  if (!positions) throw new Error(`${file}: not a readable STL`);
  if (positions.length % 9)
    throw new Error(`${file}: ${positions.length / 3} vertices is not a whole number of triangles`);
  return positions;
}

export function bbox(positions) {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      if (positions[i + k] < mn[k]) mn[k] = positions[i + k];
      if (positions[i + k] > mx[k]) mx[k] = positions[i + k];
    }
  return { mn, mx, size: mx.map((v, k) => v - mn[k]) };
}

export function triNormalArea(positions, i) {
  const o = i * 9;
  const p0 = [positions[o], positions[o + 1], positions[o + 2]];
  const e1 = [positions[o + 3] - p0[0], positions[o + 4] - p0[1], positions[o + 5] - p0[2]];
  const e2 = [positions[o + 6] - p0[0], positions[o + 7] - p0[1], positions[o + 8] - p0[2]];
  const n = [
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ];
  const len = Math.hypot(...n);
  if (len < 1e-9) return null;
  return { p0, normal: [n[0] / len, n[1] / len, n[2] / len], area: len / 2 };
}

/**
 * One pass, two bucketings — the per-triangle cross product is the expensive part and both views
 * need it.
 *
 * `list` is bucketed identically to detectFlatPatches in src/geometry/meshparts.ts (normal AND
 * plane offset, both to 2 decimals); tests/meshmatch.test.ts pins the two together.
 *
 * `spectrum` is total area per *direction*, ignoring plane offset. Because detectFlatPatches keys
 * on offset.toFixed(2), a face that is a hair non-planar splits into many patches — and it splits
 * differently at different tessellation densities, which makes raw patch areas useless for
 * comparing two meshes. Summing by direction is stable across tessellations, so this is what
 * matching uses.
 */
function bucketize(positions) {
  const pb = new Map();
  const sb = new Map();
  let total = 0;
  for (let i = 0; i < positions.length / 9; i++) {
    const t = triNormalArea(positions, i);
    if (!t) continue;
    total += t.area;

    const offset = t.normal[0] * t.p0[0] + t.normal[1] * t.p0[1] + t.normal[2] * t.p0[2];
    const pkey = [...t.normal.map((v) => v.toFixed(2)), offset.toFixed(2)].join(',');
    let p = pb.get(pkey);
    if (!p) pb.set(pkey, (p = { area: 0, normal: t.normal, offset }));
    p.area += t.area;

    const cell = t.normal.map((v) => Math.round(v * 20) / 20 + 0); // +0 folds -0 to 0
    const skey = cell.join(',');
    let s = sb.get(skey);
    if (!s) sb.set(skey, (s = { area: 0, normal: t.normal, cell }));
    s.area += t.area;
  }
  const byArea = (a, b) => b.area - a.area;
  return {
    list: [...pb.values()].sort(byArea),
    total,
    spectrum: [...sb.values()].sort(byArea),
  };
}

/** The flat patches detectFlatPatches would rank, plus total surface area. */
export function patches(positions) {
  const { list, total } = bucketize(positions);
  return { list, total };
}

/** Total area per direction bucket, tessellation-stable. */
export function normalSpectrum(positions) {
  return bucketize(positions).spectrum;
}

/**
 * Everything the tools report on or match against, computed in one pass. Deliberately does NOT
 * retain `positions` — a analyze() result outlives the loop it was made in (compare-meshes holds
 * one per candidate), and a 388k-triangle soup is ~14MB to keep alive for a triangle count.
 */
export function analyze(positions) {
  return { bb: bbox(positions), triCount: positions.length / 9, ...bucketize(positions) };
}

/** Two unit normals within ~8 degrees are the same face direction for coherence purposes. */
const SAME_DIR_DOT = 0.99;

/**
 * How much of the area facing the top patch's direction lands in that single patch. A low number
 * means the face is fragmenting across offset buckets and the app will detect less art surface
 * than the part actually has — the main reason to reject a dense slicer mesh.
 *
 * The denominator sums *every* direction bucket pointing that way rather than picking one. The
 * scatter this metric exists to measure also scatters normals across neighbouring spectrum cells,
 * so a single cell both undercounts the face (inflating the ratio, hiding the fragmentation) and
 * can be a neighbouring cell smaller than the patch itself (ratios over 100%).
 *
 * Returns null for a mesh with no triangles — the <component p:path> case, where the caller wants
 * to report the empty read, not crash on it.
 */
export function faceCoherence(a) {
  const top = a.list[0];
  if (!top) return null;
  let dirArea = 0;
  for (const s of a.spectrum) {
    const dot =
      s.normal[0] * top.normal[0] + s.normal[1] * top.normal[1] + s.normal[2] * top.normal[2];
    if (dot > SAME_DIR_DOT) dirArea += s.area;
  }
  return { patchArea: top.area, dirArea, ratio: top.area / dirArea };
}

/** All 48 signed axis permutations, tagged with determinant (+1 rotation, -1 mirror). */
export function axisMaps() {
  const out = [];
  const perms = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  for (const p of perms)
    for (let bits = 0; bits < 8; bits++) {
      const s = [0, 1, 2].map((k) => ((bits >> k) & 1 ? -1 : 1));
      const m = [0, 1, 2].map((r) => [0, 1, 2].map((c) => (p[r] === c ? s[r] : 0)));
      const det =
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
        m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
        m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
      out.push({ perm: p, sign: s, det });
    }
  return out;
}

export const applyMap = (r, v) => [0, 1, 2].map((k) => r.sign[k] * v[r.perm[k]]);
export const axisName = (r) =>
  [0, 1, 2].map((k) => `${r.sign[k] < 0 ? '-' : ''}${'xyz'[r.perm[k]]}`).join(', ');

/** p' = applyMap(r, p) + translate, as a new triangle soup. */
export function applyTransform(positions, r, translate) {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const v = [positions[i], positions[i + 1], positions[i + 2]];
    for (let k = 0; k < 3; k++) out[i + k] = r.sign[k] * v[r.perm[k]] + translate[k];
  }
  // A determinant -1 map turns every triangle inside out; flip winding so normals still point out.
  if (r.det < 0)
    for (let i = 0; i < out.length; i += 9)
      for (let k = 0; k < 3; k++) {
        const t = out[i + 3 + k];
        out[i + 3 + k] = out[i + 6 + k];
        out[i + 6 + k] = t;
      }
  return out;
}

/**
 * A mirror scoring no better than a rotation means the part is symmetric about that axis, so the
 * mirror is indistinguishable from the rotation — and the rotation is the honest answer. Ranking
 * purely by score gets this backwards: on the X-symmetric footrest, (-x,y,z) beat the identity by
 * 0.002% of pure tessellation noise and the tool reported "opposite hand", rejecting a good mesh.
 * Only call a match MIRRORED when a mirror wins by more than this margin.
 */
const MIRROR_MARGIN = 0.01;

/** Minimum spectrum overlap to call two meshes the same part at all. */
const MATCH_FLOOR = 0.5;

function scoreMap(a, bMap, denom, r) {
  let overlap = 0;
  for (const p of a.spectrum) {
    const area = bMap.get(
      applyMap(r, p.cell)
        .map((v) => v + 0)
        .join(','),
    );
    if (area) overlap += Math.min(p.area, area);
  }
  return overlap / denom;
}

/**
 * Returns { hit, reason, bboxWorst, score }. `hit` is null when the two meshes don't match, and
 * `reason` says which test rejected them — 'bbox' (no axis map lines the bounding boxes up within
 * `bboxTol`) is a very different diagnosis from 'score' (they line up but the geometry disagrees),
 * and the caller needs to say so: a coarser tessellation of a curved part can miss on bbox alone.
 */
export function findTransform(a, b, bboxTol = BBOX_TOL) {
  // Histogram intersection over direction buckets. Per-bucket equality thresholds don't work
  // here: curved regions discretize differently at 25k vs 388k triangles, so any single bucket
  // can disagree wildly while the overall distribution still matches. Summing min(areaA, areaB)
  // degrades gracefully instead of failing outright on one noisy bucket.
  const bMap = new Map(b.spectrum.map((s) => [s.cell.join(','), s.area]));
  const denom = Math.max(a.total, b.total);
  let bestRot = null,
    bestMirror = null,
    bboxWorst = Infinity;
  for (const r of axisMaps()) {
    const dims = applyMap(r, a.bb.size).map(Math.abs);
    const off = Math.max(...[0, 1, 2].map((k) => Math.abs(dims[k] - b.bb.size[k])));
    if (off < bboxWorst) bboxWorst = off;
    if (off >= bboxTol) continue;
    const score = scoreMap(a, bMap, denom, r);
    const slot = r.det > 0 ? 'rot' : 'mirror';
    const cur = slot === 'rot' ? bestRot : bestMirror;
    if (!cur || score > cur.score) {
      const mapped = [0, 1, 2].map((k) =>
        Math.min(r.sign[k] * a.bb.mn[r.perm[k]], r.sign[k] * a.bb.mx[r.perm[k]]),
      );
      const hit = { r, score, translate: [0, 1, 2].map((k) => b.bb.mn[k] - mapped[k]) };
      if (slot === 'rot') bestRot = hit;
      else bestMirror = hit;
    }
  }
  const best =
    bestRot && (!bestMirror || bestRot.score >= bestMirror.score - MIRROR_MARGIN)
      ? bestRot
      : bestMirror;
  if (!best) return { hit: null, reason: 'bbox', bboxWorst };
  if (best.score < MATCH_FLOOR) return { hit: null, reason: 'score', bboxWorst, score: best.score };
  return { hit: best, bboxWorst, score: best.score };
}
