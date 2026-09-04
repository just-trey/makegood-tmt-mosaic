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
import { eachElement, meshTris, meshVerts, modelXML } from './mesh.mjs';
import { detectFlatPatches } from '../../src/geometry/meshparts.ts';
import { CHART_SNAP_MM } from '../../src/geometry/conformal.ts';
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
 * order the runtime loader will see. Element walk and attribute-wise reads shared with
 * scripts/lib/mesh.mjs: 3MF does not mandate an attribute order, and a self-closing `<object/>`
 * must not merge two bodies.
 */
export async function read3MFIndexed(buf) {
  const xml = await modelXML(buf);
  const verts = [];
  const tris = [];
  for (const { body } of eachElement(xml, 'object')) {
    if (!body) continue;
    const base = verts.length;
    for (const v of meshVerts(body)) verts.push(v);
    for (const t of meshTris(body)) tris.push(t.map((i) => base + i));
  }
  checkMesh(verts, tris, '3MF');
  return { verts, tris };
}

/**
 * Refuses a mesh whose vertices did not parse, or whose triangles point outside its vertex list.
 *
 * `attrs` (mesh.mjs) reads a missing or malformed coordinate as NaN, and nothing downstream rejects
 * one: a NaN vertex turns its body's bounds NaN, which loses every comparison silently, so the
 * covers file registers against nothing and the bake fails somewhere far from the cause. `where`
 * names the file and object so the message points at it.
 *
 * Shared by both readers rather than checked in one, because the one that reads the covers file is
 * the one whose input is a hand-driven CAD export.
 */
function checkMesh(verts, tris, where) {
  for (let i = 0; i < verts.length; i++)
    if (!verts[i].every((x) => Number.isFinite(x)))
      throw new Error(
        `${where}: vertex ${i} did not parse as a point (x, y, z read as ${verts[i].join(', ')})`,
      );
  for (const t of tris)
    for (const vi of t)
      if (!(Number.isInteger(vi) && vi >= 0 && vi < verts.length))
        throw new Error(
          `${where}: triangle references vertex ${vi}, but the mesh has ${verts.length}`,
        );
}

/**
 * `pid` -> that m:colorgroup's colours in document order, so an object's `pindex` selects one.
 *
 * Read as attributes and children rather than as one fixed-shape match. `<m:colorgroup id="(\d+)">`
 * required `id` to be the LAST attribute of the tag, so a writer emitting
 * `<m:colorgroup displaypropertiesid="7" id="2">` produced zero groups and left every body with no
 * colour at all; and it took only the first `<m:color>`, so a group holding several resolved every
 * body in it to colour 0 whatever its `pindex` said.
 */
function colorGroups(xml) {
  const groups = new Map();
  for (const { attrs: a, body } of eachElement(xml, 'm:colorgroup')) {
    const id = a.match(/\bid="(\d+)"/)?.[1];
    if (!id || !body) continue;
    groups.set(
      id,
      [...body.matchAll(/<m:color\b[^>]*\bcolor="(#[0-9A-Fa-f]+)"/g)].map((c) =>
        c[1].toUpperCase(),
      ),
    );
  }
  return groups;
}

/**
 * Reads every mesh object out of a multi-body 3MF along with its material color, resolved
 * through pid + pindex -> m:colorgroup -> m:color. The covers file (a whole-assembly CAD export)
 * tells its bodies apart only by color: every body is named the same and carries no part id.
 *
 * **An unresolvable colour is fatal, never null.** Colour is the whole classification here:
 * registerCovers sorts reference bodies from cover bodies on it, and a body with no colour used to
 * fall through as a COVER, which is the one guess that silently starts hiding surface. `file` only
 * names the file in those messages.
 */
export async function read3MFObjectsByColor(buf, file = 'covers file') {
  const xml = await modelXML(buf);
  const groups = colorGroups(xml);
  // Vertices are read in each object's local frame. A file whose build items or components carry
  // their own transforms would collapse every body toward its origin, and a coincidental bbox
  // match could then register the covers somewhere wrong without tripping the residual check, so
  // such files are refused outright rather than mis-read.
  if (/<(item|component)\b[^>]*\btransform="/.test(xml))
    throw new Error(
      'covers file places its bodies with 3MF transforms, which this reader does not apply: ' +
        're-export it with all transforms applied to the mesh coordinates',
    );
  const objects = [];
  for (const { attrs: a, body } of eachElement(xml, 'object')) {
    if (!body) continue;
    // Spread, not streamed: this reader keeps both lists on the object it returns, and the
    // triangle count decides whether the object is a mesh at all before anything else is read.
    const tris = [...meshTris(body)];
    if (!tris.length) continue;
    const id = a.match(/\bid="([^"]*)"/)?.[1] ?? '?';
    // A per-triangle property overrides the object's, so one body would carry several colours and
    // this reader has nowhere to put them. Refused rather than reported as the object's colour.
    if (/<triangle\b[^>]*\bp1="/.test(body))
      throw new Error(
        `${file}: object id=${id} sets colours per triangle (p1=), which this reader cannot split`,
      );
    const pid = a.match(/\bpid="([^"]*)"/)?.[1];
    const colors = pid == null ? undefined : groups.get(pid);
    if (!colors?.length)
      throw new Error(
        `${file}: object id=${id} ` +
          (pid == null
            ? 'has no pid, so its colour cannot be resolved'
            : `points at pid="${pid}", which is not an m:colorgroup holding colours`),
      );
    const pindex = +(a.match(/\bpindex="(\d+)"/)?.[1] ?? 0);
    if (!(pindex < colors.length))
      throw new Error(
        `${file}: object id=${id} asks m:colorgroup ${pid} for colour ${pindex}, ` +
          `but that group holds ${colors.length}`,
      );
    const verts = [...meshVerts(body)];
    checkMesh(verts, tris, `${file}: object id=${id}`);
    objects.push({ color: colors[pindex], verts, tris });
  }
  return objects;
}

const REGISTER_DIM_TOL_MM = 1.5;
const REGISTER_RESIDUAL_MM = 1;

/**
 * Circle segments per declared cylinder. The polygon sits `r * (1 - cos(pi/n))` inside the true
 * circle: at the chair's r = 140 that is 0.042mm, two orders under the ~5mm boundary resolution
 * COVER_SAMPLE_MM2 buys the classifier, so the shadow edge is limited by the sampling and not by
 * this. It costs 508 triangles against the 17,902 of one dished CAD half-wheel.
 */
const SOLID_SEGMENTS = 128;

/** A closed cylinder about `axis`, spanning lo..hi, centred on `centre` in the other two axes. */
function cylinderMesh(axis, lo, hi, centre, radius, segments = SOLID_SEGMENTS) {
  const u = (axis + 1) % 3;
  const w = (axis + 2) % 3;
  const verts = [];
  for (const s of [lo, hi])
    for (let i = 0; i < segments; i++) {
      const a = (2 * Math.PI * i) / segments;
      const v = [0, 0, 0];
      v[axis] = s;
      v[u] = centre[u] + radius * Math.cos(a);
      v[w] = centre[w] + radius * Math.sin(a);
      verts.push(v);
    }
  const tris = [];
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    tris.push([i, j, segments + j], [i, segments + j, segments + i]);
  }
  // Both caps wound outward like the wall. Nothing here reads an orientation today (a cover is only
  // ray-cast, double-sided, and point-queried), but a mesh whose signed volume is 52.3 where its
  // real one is 157.1 is a trap for the first consumer that does.
  for (let i = 1; i + 1 < segments; i++) {
    tris.push([0, i + 1, i], [segments, segments + i, segments + i + 1]);
  }
  return { verts, tris };
}

/**
 * Replaces cover bodies with a declared solid of revolution, and returns the new cover list.
 *
 * A CAD export models a cover as the printed part. The chair's wheel arrives as its two hollow
 * printed halves, spoke openings and all, so rays reach the far wall through the body's own holes:
 * the shadow came out a ragged patch instead of a circle, and COVER_RAY_MM had to be stretched to
 * 120mm to catch that wall at all. What hides the fender is the mounted wheel's silhouette, and
 * that is a known number — the same 280mm `public/templates/wheel-cover-circle.svg` draws — not
 * something to recover by sampling a mesh full of holes.
 *
 * **The solid is posed from the file, never from the config.** `replacesDims` matches bodies by
 * bbox dimensions (REGISTER_DIM_TOL_MM, the test registerCovers already matches parts to reference
 * bodies on); matched bodies whose boxes overlap become ONE solid, which is what turns the wheel's
 * two printed halves into a single disc; and the axis extent and centre are read off that cluster.
 * Only `radiusMm` is declared, and it is checked against the cluster's own diameter. So a
 * re-exported covers file carries the solid with it, and a radius disagreeing with the mesh fails
 * loudly rather than quietly hiding the wrong disc somewhere.
 */
export function buildCoverSolids(covers, specs) {
  const info = covers.map((c, i) => ({ i, b: bounds(c.verts) }));
  const taken = new Set();
  const built = [];
  const report = [];
  const overlaps = (a, b) => a.b.mn.every((x, k) => x <= b.b.mx[k] && b.b.mn[k] <= a.b.mx[k]);
  for (const spec of specs) {
    const axis = 'xyz'.indexOf(spec.axis);
    const pool = info.filter(
      (e) =>
        !taken.has(e.i) &&
        e.b.dims.every((d, k) => Math.abs(d - spec.replacesDims[k]) < REGISTER_DIM_TOL_MM),
    );
    if (!pool.length)
      throw new Error(
        `covers.solids "${spec.id}": no cover body measures ` +
          `${spec.replacesDims.join(' x ')}mm (within ${REGISTER_DIM_TOL_MM}mm). The file holds ` +
          info.map((e) => e.b.dims.map((d) => d.toFixed(2)).join(' x ')).join(', '),
      );
    const group = new Array(pool.length).fill(-1);
    let groups = 0;
    for (let i = 0; i < pool.length; i++) {
      if (group[i] >= 0) continue;
      const g = groups++;
      group[i] = g;
      const stack = [i];
      while (stack.length) {
        const a = stack.pop();
        for (let j = 0; j < pool.length; j++)
          if (group[j] < 0 && overlaps(pool[a], pool[j])) {
            group[j] = g;
            stack.push(j);
          }
      }
    }
    for (let g = 0; g < groups; g++) {
      const members = pool.filter((_, k) => group[k] === g);
      const cb = bounds(members.flatMap((e) => covers[e.i].verts));
      for (let k = 0; k < 3; k++) {
        if (k === axis) continue;
        if (Math.abs(cb.dims[k] - 2 * spec.radiusMm) >= REGISTER_DIM_TOL_MM)
          throw new Error(
            `covers.solids "${spec.id}": a ${spec.radiusMm}mm radius wants a ` +
              `${2 * spec.radiusMm}mm span on ${'xyz'[k]}, but the ${members.length} ` +
              `bod${members.length === 1 ? 'y' : 'ies'} it replaces span ` +
              `${cb.dims[k].toFixed(2)}mm there`,
          );
      }
      built.push(cylinderMesh(axis, cb.mn[axis], cb.mx[axis], cb.mid, spec.radiusMm));
      for (const e of members) taken.add(e.i);
      report.push({ id: spec.id, replaced: members.length, mid: cb.mid, dims: cb.dims });
    }
  }
  // Where each built solid landed in the returned cover list, so a declaredShadow reader can find
  // the solid's FINAL pose (symmetrizeCovers moves cover vertices after this returns; `mid` above
  // is the pre-snap cluster and reusing it would hand the two flanks discs a sub-mm apart).
  const kept = covers.length - taken.size;
  report.forEach((r, k) => {
    r.coverIndex = kept + k;
  });
  return { covers: [...covers.filter((_, i) => !taken.has(i)), ...built], report };
}

/**
 * Registers the covers file's frame against the bake frame and returns the cover meshes
 * transformed into it. A CAD export lands in its own axes (the chair's covers file is y-up where
 * the bake frame is z-forward), so the reference bodies (the kind's own parts, re-exported in the
 * same file) anchor the transform: each config part is matched to a reference body by bbox
 * dimensions, and the translation every matched pair agrees on picks the rotation. Mirrored part
 * pairs share dimensions, which is why single-pair matching is not enough: wrong pairings
 * disagree on the translation and lose the vote.
 *
 * Known limit: a part set that is symmetric as a WHOLE (the chair's left/right pairs plus
 * centered singles) also matches its own mirror rotation with the same count and residual, and
 * this cannot tell them apart. Harmless while the covers are symmetric too; a kind with an
 * asymmetric cover needs an asymmetric reference body in the file to break the tie.
 */
export function registerCovers(config, parts, objects) {
  const refColor = config.covers.referenceColor.toUpperCase();
  const refs = objects.filter((o) => o.color === refColor);
  const coverObjs = objects.filter((o) => o.color !== refColor);
  if (!refs.length || !coverObjs.length)
    throw new Error(
      `covers file has ${refs.length} reference bodies and ${coverObjs.length} covers: ` +
        `check covers.referenceColor (${config.covers.referenceColor})`,
    );
  const partBB = parts.map((p) => bounds(p.verts));
  const rotations = [];
  for (const p of [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ])
    for (const s0 of [1, -1])
      for (const s1 of [1, -1])
        for (const s2 of [1, -1]) {
          const R = [
            [0, 0, 0],
            [0, 0, 0],
            [0, 0, 0],
          ];
          R[0][p[0]] = s0;
          R[1][p[1]] = s1;
          R[2][p[2]] = s2;
          const det =
            R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) -
            R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) +
            R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]);
          if (det > 0) rotations.push(R);
        }
  const apply = (R, v) => [
    R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2],
    R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2],
    R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2],
  ];
  // Each reference body's bounds once, in the file's own frame. A rotation here is a signed axis
  // permutation, so its bounds follow from these by permuting and swapping min/max where the sign
  // is negative — exactly, since the only arithmetic is negation. Transforming every vertex 24 times
  // over to re-derive them was the same answer for 24x the work.
  const refBB0 = refs.map((r) => bounds(r.verts));
  const rotBounds = (b, R) => {
    const mn = [0, 0, 0];
    const mx = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const j = R[i].findIndex((x) => x !== 0);
      mn[i] = R[i][j] > 0 ? b.mn[j] : -b.mx[j];
      mx[i] = R[i][j] > 0 ? b.mx[j] : -b.mn[j];
    }
    return { mn, mx, dims: [0, 1, 2].map((k) => mx[k] - mn[k]) };
  };
  let best = null;
  for (const R of rotations) {
    const refBB = refBB0.map((b) => rotBounds(b, R));
    // Candidate translations clustered by distance to a running mean, not a fixed mm grid: a
    // consensus straddling a grid boundary would split into two half-sized votes and fail a
    // registration whose true residual is far under the limit.
    const clusters = [];
    for (let pi = 0; pi < parts.length; pi++)
      for (let ri = 0; ri < refs.length; ri++) {
        if (partBB[pi].dims.some((d, k) => Math.abs(d - refBB[ri].dims[k]) >= REGISTER_DIM_TOL_MM))
          continue;
        const t = partBB[pi].mn.map((x, k) => x - refBB[ri].mn[k]);
        let c = clusters.find((cl) => cl.mean.every((x, k) => Math.abs(x - t[k]) <= 1));
        if (!c) clusters.push((c = { mean: [...t], list: [] }));
        c.list.push({ pi, t });
        for (let k = 0; k < 3; k++)
          c.mean[k] = c.list.reduce((s, e) => s + e.t[k], 0) / c.list.length;
      }
    for (const { list } of clusters) {
      const matched = new Set(list.map((e) => e.pi)).size;
      const T = [0, 1, 2].map((k) => list.reduce((s, e) => s + e.t[k], 0) / list.length);
      const residual = Math.max(
        ...list.map((e) => Math.max(...e.t.map((x, k) => Math.abs(x - T[k])))),
      );
      if (!best || matched > best.matched || (matched === best.matched && residual < best.residual))
        best = { R, T, matched, residual };
    }
  }
  if (!best || best.matched < parts.length)
    throw new Error(
      `covers file registration failed: only ${best?.matched ?? 0} of ${parts.length} parts ` +
        `matched a reference body, so the covers file does not contain this assembly`,
    );
  if (best.residual > REGISTER_RESIDUAL_MM)
    throw new Error(
      `covers file registration failed: matched parts disagree on the transform by ` +
        `${best.residual.toFixed(3)}mm (limit ${REGISTER_RESIDUAL_MM}mm)`,
    );
  const xform = (v) => apply(best.R, v).map((x, k) => x + best.T[k]);
  let covers = coverObjs.map((c) => ({ verts: c.verts.map(xform), tris: c.tris }));
  // Before the mirror snap, not after: a declared solid is posed from the bodies it replaces, so
  // it inherits their sub-millimetre asymmetry, and symmetrizeCovers is what takes that back out.
  let solids = null;
  if (config.covers.solids?.length) {
    const s = buildCoverSolids(covers, config.covers.solids);
    covers = s.covers;
    solids = s.report;
  }
  const mirror = config.covers.mirrorAxis
    ? symmetrizeCovers(covers, 'xyz'.indexOf(config.covers.mirrorAxis))
    : null;
  return { covers, matched: best.matched, residual: best.residual, mirror, solids };
}

/**
 * Axis-aligned bounds of a vertex list, with both derived forms the bake reads off them: per-axis
 * dimensions (registerCovers matches parts to reference bodies on these) and the midpoint.
 *
 * Midpoint, not centroid: these meshes are unevenly tessellated, so a centroid drifts with triangle
 * density (the seat cushion's is 1.1mm off a bbox that is centred to 0.000mm).
 */
function bounds(verts) {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (const v of verts)
    for (let k = 0; k < 3; k++) {
      if (v[k] < mn[k]) mn[k] = v[k];
      if (v[k] > mx[k]) mx[k] = v[k];
    }
  return {
    mn,
    mx,
    dims: [0, 1, 2].map((k) => mx[k] - mn[k]),
    mid: [0, 1, 2].map((k) => (mn[k] + mx[k]) / 2),
  };
}

/**
 * Moves mirror-paired cover bodies onto exactly mirrored POSES about `axis` = 0, IN PLACE. Each
 * body keeps its own vertices and its own winding; only where it stands changes.
 *
 * A CAD export lands its instances where the assembly put them, not where symmetry would: the
 * chair's four casters pair up 1.187mm off their own mirror image and 0.315 degrees rotated. That
 * is far under any tolerance the bake cares about on its own, and it still decides a knife-edge —
 * the flanks classify within 3.8% of each other and the surviving dead region did not, because a
 * sample sitting at 27 or 28 blocked directions of 32 goes whichever way the sub-millimetre pose
 * pushes it. Snapping the poses removes the tie-breaker instead of tuning the threshold that
 * exposes it.
 *
 * Both sides move to the averaged offset, so neither side's pose is adopted wholesale. The pairing
 * itself is by triangle count and mirror-midpoint distance. Unpaired bodies (the chair's two
 * cushions, which straddle the plane themselves) are left alone.
 *
 * **The pose only, never the mesh.** This used to rebuild each pair from one of its two meshes,
 * mirrored for the other side, which is symmetry exactly rather than to a residual — and wrong for
 * this file. The owner answered the open question on 2026-08-31: the chair's paired casters are the
 * same part mounted rotated 180 degrees, not mirrored, so the left and right wheels really do
 * present different faces outward. Replacing one with the other's mirror moved real geometry by up
 * to 21.976mm, 3,958 of its 8,953 vertices past 1mm, because the true relation is
 * `(x, y, z) -> (-x, y, -z)` — a rotation, determinant +1, off by a further mirror in z. Re-derive
 * with `npx vite-node scripts/measure-caster-axis-map.mjs`.
 *
 * Those numbers are the covers FILE's own bodies. The chair's config no longer hands them here:
 * `covers.solids` stands one disc in each pair's place first (buildCoverSolids), and a disc pair is
 * an exact mirror, so this run reports 0.000mm on the chair today. The rule is not about the chair —
 * it is what any covers file gets, and the next one may well pair by rotation with no disc to hide
 * it. That is why the script takes `solids` off to answer the question.
 *
 * The pair is still checked for being the same body at all: two unrelated bodies can share a
 * triangle count and a mirror midpoint, and posing those as a pair moves one of them somewhere it
 * does not belong. Vertex count and bbox extent decide, the same test registerCovers matches parts
 * to reference bodies on. How far the two are from being mirror images still comes back as
 * `maxResidualMm` for the bake log, and nothing enforces it: for this file the answer is "they are
 * not, on purpose".
 */
export function symmetrizeCovers(covers, axis) {
  if (axis < 0) throw new Error('covers.mirrorAxis must be "x", "y" or "z"');
  const flip = reflectAcross(axis);
  // Which cover is each cover's mirror image. A body with no partner straddles the plane and is
  // its own, so the map is total and the classifier can reflect any blocker without a branch.
  const twin = covers.map((_, i) => i);
  const info = covers.map((c, i) => ({ i, c, b: bounds(c.verts) }));
  const used = new Set();
  const moved = [];
  let maxResidual = 0;
  for (const a of info) {
    if (used.has(a.i)) continue;
    const partner = info
      .filter((o) => o.i !== a.i && !used.has(o.i) && o.c.tris.length === a.c.tris.length)
      .map((o) => ({ o, d: dist3(a.b.mid, flip(o.b.mid)) }))
      .sort((x, y) => x.d - y.d)[0];
    // A pair has to be nearer its own mirror image than the sampling resolution, or it is two
    // different bodies that merely happen to share a triangle count.
    if (!partner || partner.d > MIRROR_PAIR_TOL_MM) continue;
    const src = a.b.mid[axis] < 0 ? a : partner.o;
    const dst = src === a ? partner.o : a;
    // averaged pose: same distance from the plane on both sides, averaged along the others
    const target = [0, 1, 2].map((k) =>
      k === axis
        ? -(Math.abs(a.b.mid[k]) + Math.abs(partner.o.b.mid[k])) / 2
        : (a.b.mid[k] + partner.o.b.mid[k]) / 2,
    );
    const shift = [0, 1, 2].map((k) => target[k] - src.b.mid[k]);
    const srcVerts = src.c.verts.map((v) => v.map((x, k) => x + shift[k]));
    // Same body, or two different ones that happen to share a triangle count? Vertex count and
    // per-axis extent, the same test registerCovers already matches parts to reference bodies on,
    // at the same measured tolerance. Two unrelated bodies agree on neither; the chair's four
    // caster bodies agree on both exactly (8,953 vertices, 48.500 x 154.059 x 279.997mm, all four),
    // measured on the covers file before covers.solids replaces them.
    if (
      src.c.verts.length !== dst.c.verts.length ||
      src.b.dims.some((d, k) => Math.abs(d - dst.b.dims[k]) >= REGISTER_DIM_TOL_MM)
    )
      throw new Error(
        `covers file: two bodies pair as mirrors (${a.c.tris.length} triangles, midpoints ` +
          `${partner.d.toFixed(3)}mm apart) but are not the same body — ` +
          `${src.c.verts.length} vs ${dst.c.verts.length} vertices, ` +
          `${src.b.dims.map((d) => d.toFixed(3)).join(' x ')} against ` +
          `${dst.b.dims.map((d) => d.toFixed(3)).join(' x ')}mm. Check covers.mirrorAxis.`,
      );
    // How far the posed pair is from being mirror images: each vertex of one against the nearest of
    // the other's reflection, both ways, as point SETS. Not index for index (two bodies that ARE
    // each other's mirror need not list vertices in the same order) and not sorted either (a
    // caster's disc puts thousands of vertices at nearly equal x, so sorting reorders whole runs of
    // them and reads 279.997mm on a pair that is 0.000mm apart as sets).
    //
    // Reported, never enforced. On this file it is 21.976mm and that is correct geometry: the
    // casters are rotated, not mirrored (see above). Nothing downstream reads it.
    const mirrorTarget = flip(target);
    const have = dst.c.verts.map((v) =>
      [0, 1, 2].map((k) => v[k] + mirrorTarget[k] - dst.b.mid[k]),
    );
    const want = srcVerts.map(flip);
    maxResidual = Math.max(
      maxResidual,
      Math.max(
        nearestPointResidual(want, have, MIRROR_REPORT_MM),
        nearestPointResidual(have, want, MIRROR_REPORT_MM),
      ),
    );
    used.add(a.i);
    used.add(partner.o.i);
    twin[a.i] = partner.o.i;
    twin[partner.o.i] = a.i;
    // Each side keeps its own mesh, translated onto its half of the mirrored pose. `have` is
    // already the destination's own vertices at that pose, computed for the residual above.
    src.c.verts = srcVerts;
    dst.c.verts = have;
    moved.push(dist3(src.b.mid, target), dist3(dst.b.mid, mirrorTarget));
  }
  // A body nothing paired with is left alone AND mapped to itself, which only holds if it really is
  // its own mirror image — the chair's two cushions, which cross the plane. An off-centre lone
  // cover would be mapped to itself too, and the mirrored classify pass reads `twin` to decide
  // whether a blocker is one THIS part carries: it would stamp the far flank's samples hidden and
  // claimed against a cover sitting nowhere near them, deleting artwork a user can see with nothing
  // said. Refused rather than approximated, since there is no right answer to approximate.
  for (const e of info) {
    if (used.has(e.i)) continue;
    if (e.b.mn[axis] <= 0 && 0 <= e.b.mx[axis]) continue;
    throw new Error(
      `covers file: a cover body (${e.c.tris.length} triangles, ${'xyz'[axis]} ` +
        `${e.b.mn[axis].toFixed(1)}..${e.b.mx[axis].toFixed(1)}mm) pairs with nothing and does not ` +
        `cross the ${'xyz'[axis]} mirror plane, so it is neither half of a pair nor its own ` +
        `mirror. Give it its partner in the export, or drop covers.mirrorAxis.`,
    );
  }
  return {
    pairs: moved.length / 2,
    maxShiftMm: moved.length ? Math.max(...moved) : 0,
    maxResidualMm: maxResidual,
    twin,
  };
}

const MIRROR_PAIR_TOL_MM = 5;

/**
 * Distance from each point of `a` to the nearest point of `b`, in `a`'s order, Infinity where none
 * is within `cap`. Cells are `cap` wide, so the 27-neighbour search cannot miss a counterpart that
 * is inside it, and anything outside it has already failed.
 */
// Exported for scripts/measure-caster-axis-map.mjs, which reports both the worst distance and how
// many vertices exceed a threshold, off one pass of the same search the bake reports its residual
// with — see bodyIndex above for why a measurement script must not re-implement one.
export function nearestPointDistances(a, b, cap) {
  return nearestPoints(a, b, cap).map((n) => n.d);
}

/** The search behind nearestPointDistances, keeping WHICH point of `b` won (`j`, -1 for none). */
export function nearestPoints(a, b, cap) {
  const cell = (p) =>
    `${Math.floor(p[0] / cap)},${Math.floor(p[1] / cap)},${Math.floor(p[2] / cap)}`;
  const cells = new Map();
  b.forEach((p, j) => {
    const k = cell(p);
    let l = cells.get(k);
    if (!l) cells.set(k, (l = []));
    l.push(j);
  });
  return a.map((p) => {
    const [ci, cj, ck] = [0, 1, 2].map((k) => Math.floor(p[k] / cap));
    let best = { d: Infinity, j: -1 };
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (let k = -1; k <= 1; k++)
          for (const qj of cells.get(`${ci + i},${cj + j},${ck + k}`) ?? []) {
            const q = b[qj];
            const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
            if (d < best.d) best = { d, j: qj };
          }
    return best;
  });
}

/** Worst of those, so a pair with nothing within `cap` reports Infinity rather than a figure. */
function nearestPointResidual(a, b, cap) {
  return nearestPointDistances(a, b, cap).reduce((w, d) => (d > w ? d : w), 0);
}
/**
 * Search cap (mm) for the reported mirror-shape residual. Not a limit on anything: it only bounds
 * the point-set search, and a pair further apart than this reports Infinity rather than a figure.
 * 50 is above the chair's 21.976mm and below the 280mm body it sits on, so the number stays
 * meaningful without the search widening over the whole assembly.
 */
const MIRROR_REPORT_MM = 50;
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** Reflection across the plane through the origin normal to `axis` (0, 1 or 2). */
const reflectAcross = (axis) => (v) => v.map((x, k) => (k === axis ? -x : x));

/**
 * Which zone mirrors which, off the seed points: twins when the seeds reflect onto each other
 * across the axis plane, self when the seed sits on it, both at symmetrizeCovers' own
 * MIRROR_PAIR_TOL_MM. A seedNormal zone states no point to pair on, so it is warned and skipped.
 */
export function pairMirrorZones(zones, axis) {
  const mirror = new Map();
  const warnings = [];
  const flip = reflectAcross(axis);
  const seeded = zones.filter((z) => Array.isArray(z.seedPoint));
  for (const z of zones)
    if (!Array.isArray(z.seedPoint))
      warnings.push(
        `zone "${z.id}" grows from a seedNormal, so mirrorAxis cannot pair it: it offers no mirror`,
      );
  for (const z of seeded) {
    if (mirror.has(z.id)) continue;
    if (Math.abs(z.seedPoint[axis]) <= MIRROR_PAIR_TOL_MM) {
      mirror.set(z.id, { self: true });
      continue;
    }
    const want = flip(z.seedPoint);
    const partner = seeded
      .filter((o) => o !== z && !mirror.has(o.id))
      .map((o) => ({ o, d: dist3(o.seedPoint, want) }))
      .sort((x, y) => x.d - y.d)[0];
    if (!partner || partner.d > MIRROR_PAIR_TOL_MM) {
      warnings.push(
        `zone "${z.id}" has no mirror: its seed ${z.seedPoint.join(', ')} is ` +
          `${Math.abs(z.seedPoint[axis]).toFixed(1)}mm off the ${'xyz'[axis]} plane and no other ` +
          `zone seeds within ${MIRROR_PAIR_TOL_MM}mm of its reflection. It offers no mirror`,
      );
      continue;
    }
    mirror.set(z.id, { twin: partner.o.id });
    mirror.set(partner.o.id, { twin: z.id });
  }
  return { mirror, warnings };
}

/**
 * How far (mm) a vertex may sit from its counterpart's reflection and still be the same point.
 * Twins are exact mirrors tessellated differently, so a counterpart is either right there or
 * absent; past 0.5 the search starts pairing vertices the twin lacks and the rms climbs with the
 * count (`measure-zone-mirror.mjs --pair-mm 0.25|0.5|1`). tests/chair-zones.test.ts pins counts here.
 */
export const MIRROR_VERT_PAIR_MM = 0.5;

/**
 * Every chart vertex of a zone with its 3D position, its UV, and the packed vertex it indexes —
 * `part:index`, which is what makes two zones' claims on the SAME vertex recognisable. With
 * `withBoundary` it also returns which of them lie on a chart edge carried by one triangle: the
 * zone's outer rim, its holes, and the printed seams where the next part's chart takes over.
 */
function zoneChartPoints(zone, vertsOf, withBoundary = false) {
  const pos = [];
  const uv = [];
  const keys = [];
  const boundary = [];
  for (const c of zone.charts) {
    const verts = vertsOf(c.libraryPartId);
    const base = pos.length;
    for (let i = 0; i < c.verts.length; i++) {
      pos.push(verts[c.verts[i]]);
      uv.push([c.uv[2 * i], c.uv[2 * i + 1]]);
      keys.push(`${c.libraryPartId}:${c.verts[i]}`);
    }
    if (!withBoundary) continue;
    const use = new Map();
    for (const t of c.chartTris)
      for (let k = 0; k < 3; k++) {
        const e = edgeKey(t[k], t[(k + 1) % 3]);
        use.set(e, (use.get(e) ?? 0) + 1);
      }
    const onEdge = new Set();
    for (const [e, n] of use) if (n === 1) for (const v of e.split(',')) onEdge.add(+v);
    for (const v of onEdge) boundary.push(base + v);
  }
  return { pos, uv, keys, boundary };
}

/**
 * How far zone B's UV is from zone A's UV reflected about A's uvBounds centre, per vertex of A
 * whose reflection has a counterpart on B within `cap` (a self-mirrored zone measures against
 * itself). `vertsOf(libraryPartId)` is the packed vertex list the charts index. The reflection is
 * the whole transform: a best-fit rotation and scale add nothing (scripts/measure-zone-mirror.mjs).
 */
export function measureZoneMirror(zoneA, zoneB, axis, vertsOf, cap = MIRROR_VERT_PAIR_MM) {
  const a = zoneChartPoints(zoneA, vertsOf);
  const b = zoneA === zoneB ? a : zoneChartPoints(zoneB, vertsOf);
  const cA = [zoneA.uvBounds.maxU / 2, zoneA.uvBounds.maxV / 2];
  const cB = [zoneB.uvBounds.maxU / 2, zoneB.uvBounds.maxV / 2];
  const near = nearestPoints(a.pos.map(reflectAcross(axis)), b.pos, cap);
  const residuals = [];
  const pairList = [];
  near.forEach((n, i) => {
    // The search reaches into neighbouring cells, so it answers past `cap`; this does not.
    if (n.j < 0 || n.d > cap) return;
    const [u, v] = a.uv[i];
    const want = [cB[0] - (u - cA[0]), cB[1] + (v - cA[1])];
    const got = b.uv[n.j];
    pairList.push({ want, got });
    residuals.push(Math.hypot(got[0] - want[0], got[1] - want[1]));
  });
  residuals.sort((x, y) => x - y);
  const n = residuals.length;
  return {
    of: a.pos.length,
    pairs: n,
    pairList,
    rms: n ? Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / n) : 0,
    p95: n ? residuals[Math.max(0, Math.ceil(0.95 * n) - 1)] : 0,
    max: n ? residuals[n - 1] : 0,
  };
}

/**
 * Best q ~= s*R(theta)*(p - p_bar) + q_bar over the pairs, and what is left of them after it. Closed
 * form: theta from the cross/dot sums of the centred pairs, s from their ratio of norms — or s = 1
 * when `allowScale` is false, which is what a registration between two true-mm charts has to be: a
 * fit allowed to resize would land the design at the wrong size on the far side of the seam.
 */
export function procrustesFit(pairs, allowScale = true) {
  const n = pairs.length;
  if (n < 2) return null;
  const pc = [0, 0];
  const qc = [0, 0];
  for (const { want, got } of pairs) {
    pc[0] += want[0] / n;
    pc[1] += want[1] / n;
    qc[0] += got[0] / n;
    qc[1] += got[1] / n;
  }
  let dot = 0;
  let cross = 0;
  let pp = 0;
  for (const { want, got } of pairs) {
    const px = want[0] - pc[0];
    const py = want[1] - pc[1];
    const qx = got[0] - qc[0];
    const qy = got[1] - qc[1];
    dot += px * qx + py * qy;
    cross += px * qy - py * qx;
    pp += px * px + py * py;
  }
  // Every source point at one place: nothing to recover but a translation, and s would divide by 0.
  if (!(pp > 0)) return null;
  const theta = Math.atan2(cross, dot);
  const s = allowScale ? Math.hypot(dot, cross) / pp : 1;
  const c = Math.cos(theta);
  const sn = Math.sin(theta);
  const res = pairs
    .map(({ want, got }) => {
      const px = want[0] - pc[0];
      const py = want[1] - pc[1];
      return Math.hypot(
        got[0] - (s * (c * px - sn * py) + qc[0]),
        got[1] - (s * (sn * px + c * py) + qc[1]),
      );
    })
    .sort((x, y) => x - y);
  return {
    n,
    thetaDeg: (theta * 180) / Math.PI,
    scale: s,
    rms: Math.sqrt(res.reduce((a, r) => a + r * r, 0) / n),
    p95: res[Math.max(0, Math.ceil(0.95 * n) - 1)],
    max: res[n - 1],
  };
}

/**
 * Report buckets (mm) for how far one zone's chart boundary sits from the next zone's surface.
 * Nothing acts on them: they bracket CHART_SNAP_MM (3), the slack a chart already tolerates, so a
 * reader can tell at a glance whether two zones abut, nearly abut, or merely face each other.
 */
export const SEAM_GAP_BUCKETS_MM = [2, 5, 10, 20];
/**
 * Widest gap (mm) a vertex pair may span and still register the two charts. Wider than this the two
 * points are not the same place on the chair, so the fit would be measuring the gap rather than the
 * registration. It is the third bucket above, kept in step with it deliberately.
 */
export const SEAM_FIT_MM = SEAM_GAP_BUCKETS_MM[2];

/** A zone's chart vertices with the boundary flags measureZoneSeam needs. Compute once per zone. */
export const zoneSeamPoints = (zone, vertsOf) => zoneChartPoints(zone, vertsOf, true);

/**
 * The seam relation from zone A to zone B, both as zoneSeamPoints: how many of A's chart-boundary
 * vertices have any B vertex within each SEAM_GAP_BUCKETS_MM and the median of those gaps, and the
 * rigid and similarity fits from A's UV onto B's over the pairs within SEAM_FIT_MM.
 *
 * Then the same two fits over the vertices the two zones SHARE outright — same part, same packed
 * index, so the pairs are the same point rather than merely a near one. That is the registration a
 * design crossing the seam actually rides on, and the two answers are far apart: on the chair's
 * flank/back corner the nearest-point fit reads 5.61mm p95 where the shared one reads 1.81, because
 * a boundary vertex within 10mm of the next zone is often not on the seam at all.
 */
export function measureZoneSeam(a, b) {
  const cap = SEAM_GAP_BUCKETS_MM[SEAM_GAP_BUCKETS_MM.length - 1];
  const near = nearestPoints(
    a.boundary.map((i) => a.pos[i]),
    b.pos,
    cap,
  );
  const counts = SEAM_GAP_BUCKETS_MM.map(() => 0);
  const gaps = [];
  const pairs = [];
  near.forEach((nb, k) => {
    // The search reaches into neighbouring cells, so it answers past `cap`; this does not.
    if (nb.j < 0 || nb.d > cap) return;
    SEAM_GAP_BUCKETS_MM.forEach((t, i) => {
      if (nb.d <= t) counts[i]++;
    });
    gaps.push(nb.d);
    if (nb.d <= SEAM_FIT_MM) pairs.push({ want: a.uv[a.boundary[k]], got: b.uv[nb.j] });
  });
  gaps.sort((x, y) => x - y);
  const m = gaps.length;
  const bAt = new Map(b.keys.map((k, i) => [k, i]));
  const sharedPairs = [];
  a.keys.forEach((k, i) => {
    const j = bAt.get(k);
    if (j !== undefined) sharedPairs.push({ want: a.uv[i], got: b.uv[j] });
  });
  return {
    of: a.boundary.length,
    counts,
    medianMm: m ? (m % 2 ? gaps[(m - 1) / 2] : (gaps[m / 2 - 1] + gaps[m / 2]) / 2) : null,
    shared: sharedPairs.length,
    rigid: procrustesFit(pairs, false),
    similarity: procrustesFit(pairs, true),
    sharedRigid: procrustesFit(sharedPairs, false),
    sharedSimilarity: procrustesFit(sharedPairs, true),
  };
}

/**
 * How far one visibility ray looks (mm) before it counts as escaping. Not a proximity limit: a
 * sample is hidden when its whole outward hemisphere is blocked, and this only bounds the search.
 *
 * Measured on the chair's covers file (2026-08-30, scratch sweep over ray length at 48 directions,
 * threshold 0.90): every zone's hidden area settles by 100mm and 100 -> 300mm then moves the flanks
 * by 0.02% and the cushioned zones by 0.5%. Below 80mm it collapses — the wheel is a dish, its
 * outer wall sits ~40mm behind the mount face, and grazing paths to that wall are longer still, so
 * a short ray reports the wheel's shadow as a hollow ring (left flank 11,315mm² at 25mm against
 * 32,896mm² at 120mm). Stopping at 120 rather than running unbounded keeps a ray from crossing the
 * 340mm-wide chair and being blocked by a cover on the far side.
 */
export const COVER_RAY_MM = 120;
/**
 * Directions per hemisphere sample, cosine-weighted (see HEMI_DIRS). Converged: 24 through 192
 * directions agree within 0.6% on every chair zone, 12 is 1.4% off. 32 costs ~2.2s of the bake.
 */
const COVER_HEMI_DIRS = 32;
/**
 * Fraction of a sample's outward hemisphere that must be blocked for it to count as hidden.
 *
 * Chosen on the chair's mirrored flanks, which are the only pair whose two answers must agree:
 * `left` and `right` disagree by 3.2% at 1.00, 4.3% at 0.95 and 1.5% at 0.90, then drop to 1.3% at
 * 0.85 and flatten (0.6% at 0.80, 0.5% at 0.70). 0.85 is the strictest value past that knee, and
 * stricter is the safe direction: over-claiming deletes surface a user can see, under-claiming only
 * leaves artwork somewhere nobody looks. It lands at 90% of the wheels' straight-on projected
 * shadow (33,746 against 37,456mm² on `left`), the missing tenth being the rim you can see into at
 * a grazing angle.
 *
 * **Settled by the owner, 2026-09-01: surface the cushion covers takes no image or pattern.** An
 * earlier run had them marking four regions on the Front sheet as hatched wrongly, and the bake
 * then read 0 / 0 / 1 / 9mm² in them. This threshold, the contact test and the smoothing order
 * together now read 297 / 390 / 1,402 / 1,465mm² there. The cushion sits 0.5 to 18.4mm off the
 * surface in those four (median 4.4mm on the two by the shoulder, 12-13mm on the two lower down),
 * which is the band where "can you see it once assembled" is a judgement and not a measurement.
 * The ruling above is that judgement, and it replaces the four marks. Do not tune this constant to
 * bring those numbers back down.
 */
const COVER_HIDDEN_FRACTION = 0.85;
/**
 * Target area (mm²) of one classification sample. The chair's CAD faces arrive as coarse fans —
 * ten triangles carry 68% of the left wheel mount's 37,443mm², the largest 8,430mm² — so a
 * per-triangle verdict cannot draw a shadow edge at all. Converged: 100 down to 3mm² moves every
 * zone under 1.5%, while a per-triangle verdict is 7% high on the flanks and 7% high on `front`.
 * 25mm² is a ~5mm boundary resolution against the 20mm bleed, at 67k samples for the whole chair.
 */
export const COVER_SAMPLE_MM2 = 25;
/**
 * A sample with a cover this close (mm) straight out along its normal is hidden, whatever the
 * hemisphere test makes of it. Touching plastic is touching plastic; the hemisphere test is for
 * everything that is not in contact.
 *
 * It exists because a chamfer defeats the hemisphere test. The seat's clip recesses have ~45
 * degree walls, so a sample there tilts its whole hemisphere with the wall and 4 or 5 of its 32
 * directions escape sideways — 27 or 28 blocked against the 28 needed — while the cushion sits
 * 0.7 to 1.9mm above it and the cushion is solid over the whole bay (150 of 150 and 149 of 149
 * cells, measured 2026-08-30; the cushion projects 54,647mm² solid of a 59,813mm² bbox with no
 * cutout there).
 *
 * 2.5mm is chosen against the closest thing that is genuinely visible. On the chair the nearest a
 * visible sample gets to any cover is 3.26mm on the left flank and 3.97mm on the right — the wheel
 * standing off its mount, the 3-10mm band the ray-length note above describes. So the rule adds
 * exactly 0mm² on both flanks at every threshold up to 3mm, and 2.5 keeps 0.76mm of margin under
 * the measured floor rather than crowding it. Above it, the flanks start losing rim: 4mm would
 * take 2,164 and 2,127mm² of surface measured as visible.
 *
 * What it buys, in area the hemisphere test alone leaves printable: seat +1,026mm² (of 1,028 at
 * saturation, so the bays are essentially all of it) and front +1,583mm².
 */
const COVER_CONTACT_MM = 2.5;
/**
 * Dead islands under this (mm²) are dropped. Deliberately looser than MIN_ISLAND_AREA_MM2:
 * dropping a dead sliver only means a speck of hidden surface still takes artwork, the safe
 * direction, where dropping a clip-region island deletes design surface.
 */
const MIN_DEAD_AREA_MM2 = 15;
/**
 * Radius (mm) of the morphological smoothing applied to the dead region in UV (see smoothDead for
 * the order, which is load-bearing).
 *
 * The classifier is piecewise-constant on COVER_SAMPLE_MM2 patches, so a lone cell whose hemisphere
 * escaped where every neighbour's did not leaves a one-cell hole, and a lone cell that was blocked
 * leaves a one-cell spike. The closing fills the holes, the opening takes the spikes off; both are
 * Round, so the structuring element is a real disc.
 *
 * **5mm is the sampling cell, not a swept knee.** COVER_SAMPLE_MM2 is 25mm², so a cell is about
 * 5mm on a side (a 25mm² triangle is 6.6mm on its long side), and that is the scale of every
 * artifact this exists to remove. Tying it there rather than tuning it is deliberate: swept
 * 2026-08-31 at 3 / 5 / 7mm, the shipped zones come out
 *
 *   zone         3mm              5mm              7mm
 *   left         19,478 + 3,865   19,473 + 4,013   19,409 + 3,998
 *   right        19,654 + 3,868   19,760 + 4,017   19,630 + 3,998
 *   seat-left    13,457 +   803   13,094 +   798   14,724 +   790
 *   seat-right   13,463 +   804   13,113 +   801   14,730 +   790
 *
 * — the same component count everywhere and totals within a few percent, so there IS no knee in
 * this band and a number picked from one would be picked from noise. An earlier version of this
 * comment claimed 5mm was where a component histogram separated, on figures taken when the
 * smoothing ran AFTER the bleed and had the bleed's own pinched necks to repair; smoothDead
 * describes what changed.
 */
const DEAD_SMOOTH_MM = 5;

const CELL_MM = 8;

// Cell hash. Collisions merge two cells' triangle lists, which only ever adds candidates a ray
// then rejects exactly — a hit can't be lost, so the hash needs no perfectness.
const cellKey = (i, j, k) => (i * 73856093) ^ (j * 19349663) ^ (k * 83492791);

/**
 * Every body's triangles in ONE 8mm cell grid, flattened to a Float64Array. One grid rather than
 * one per body because the question is only ever "does any of them block this ray", so a single
 * walk answers it; `seen` stamps a triangle per ray, since a triangle sits in every cell its bbox
 * spans. Measured 67x faster than the per-body sampled march it replaces, over 16,031 chair zone
 * triangles, with zero verdicts changed. `owner` keeps which body each triangle came from, which
 * is what lets a hit name the cover that scored it.
 */
// Exported for scripts/measure-wheel-shadow.mjs, which has to cast against the covers the way the
// bake does rather than re-implement the intersection: a re-implemented hot loop IS the
// measurement, and a published figure taken with a lookalike is a figure nobody can check.
/**
 * The first part that breaks mirror symmetry about coordinate 0 of `axis`, or null. A part passes
 * by crossing the plane itself, or by having another part whose bbox is its reflection, at
 * REGISTER_DIM_TOL_MM — the tolerance every other body-matching test here already uses.
 *
 * `covers.mirrorAxis` describes the COVERS file. The mirrored classify pass reflects sample points
 * about the same plane and asks the question again there, which is only a point on this kind at all
 * if the kind shares that symmetry — and OR-ing the two answers can only ADD hidden surface, so
 * getting it wrong deletes artwork rather than leaving some. Nothing else states the parts are
 * symmetric, so this is checked rather than assumed.
 */
export function asymmetricPart(parts, axis) {
  const bb = parts.map((p) => bounds(p.verts));
  const near = (a, b) => Math.abs(a - b) < REGISTER_DIM_TOL_MM;
  for (let i = 0; i < parts.length; i++) {
    const b = bb[i];
    if (b.mn[axis] <= 0 && 0 <= b.mx[axis]) continue;
    const mn = [...b.mn];
    const mx = [...b.mx];
    mn[axis] = -b.mx[axis];
    mx[axis] = -b.mn[axis];
    if (!bb.some((o, j) => j !== i && mn.every((x, k) => near(x, o.mn[k]) && near(mx[k], o.mx[k]))))
      return parts[i].libraryPartId;
  }
  return null;
}

export function bodyIndex(bodies) {
  const pts = [];
  const owner = [];
  bodies.forEach((b, bi) => {
    for (const t of b.tris) {
      pts.push(b.verts[t[0]], b.verts[t[1]], b.verts[t[2]]);
      owner.push(bi);
    }
  });
  const count = pts.length / 3;
  const xyz = new Float64Array(pts.length * 3);
  pts.forEach((v, i) => xyz.set(v, i * 3));
  const cells = new Map();
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  // Per-axis cell span of this triangle, computed once each. The nested loops below re-derived
  // their own bounds on every iteration, which is the same three coordinates through Math.min,
  // Math.max and Math.floor again per cell entered.
  const cmn = [0, 0, 0];
  const cmx = [0, 0, 0];
  for (let t = 0; t < count; t++) {
    const o = t * 9;
    for (let k = 0; k < 3; k++) {
      cmn[k] = Math.floor(Math.min(xyz[o + k], xyz[o + 3 + k], xyz[o + 6 + k]) / CELL_MM);
      cmx[k] = Math.floor(Math.max(xyz[o + k], xyz[o + 3 + k], xyz[o + 6 + k]) / CELL_MM);
      if (cmn[k] < lo[k]) lo[k] = cmn[k];
      if (cmx[k] > hi[k]) hi[k] = cmx[k];
    }
    for (let i = cmn[0]; i <= cmx[0]; i++)
      for (let j = cmn[1]; j <= cmx[1]; j++)
        for (let k = cmn[2]; k <= cmx[2]; k++) {
          const key = cellKey(i, j, k);
          let cell = cells.get(key);
          if (!cell) cells.set(key, (cell = []));
          cell.push(t);
        }
  }
  return {
    xyz,
    cells,
    seen: new Int32Array(count).fill(-1),
    ray: 0,
    owner: Int32Array.from(owner),
    bodyCount: bodies.length,
    lo,
    hi,
  };
}

/** Möller-Trumbore against cover triangle `t`; distance along dir, or Infinity. */
function rayTriDist(xyz, t, px, py, pz, dx, dy, dz) {
  const o = t * 9;
  const ax = xyz[o],
    ay = xyz[o + 1],
    az = xyz[o + 2];
  const e1x = xyz[o + 3] - ax,
    e1y = xyz[o + 4] - ay,
    e1z = xyz[o + 5] - az;
  const e2x = xyz[o + 6] - ax,
    e2y = xyz[o + 7] - ay,
    e2z = xyz[o + 8] - az;
  const hx = dy * e2z - dz * e2y,
    hy = dz * e2x - dx * e2z,
    hz = dx * e2y - dy * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (det > -1e-9 && det < 1e-9) return Infinity;
  const inv = 1 / det;
  const sx = px - ax,
    sy = py - ay,
    sz = pz - az;
  const u = (sx * hx + sy * hy + sz * hz) * inv;
  if (u < 0 || u > 1) return Infinity;
  const qx = sy * e1z - sz * e1y,
    qy = sz * e1x - sx * e1z,
    qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return Infinity;
  const t0 = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t0 > 1e-6 ? t0 : Infinity;
}

/**
 * Which cover blocks the ray from `p` along `dir` within `maxMm`, or -1, by walking the grid cell
 * by cell (3D DDA). Each cell is entered once, so no de-duplication beyond the per-ray triangle
 * stamp is needed.
 *
 * **The nearest hit, not the first one found.** Which cover a ray is attributed to decides more
 * than whether the sample is hidden: `hemisphereBlocked` stamps it into `blockers`, and the caller
 * reads that to ask whether one of THIS part's own covers is among them (see `coverHomeParts`). At
 * a seam two covers block the same direction and the first-found rule handed the answer to whichever
 * the walk reached first, which depends on cell order rather than on geometry — so the same sample
 * could be claimed or unclaimed according to how the covers happened to be listed. The nearest hit
 * is the one actually doing the occluding, and it does not depend on any ordering.
 *
 * It costs one extra thing: the walk cannot stop on a hit, it stops once the cell it is entering
 * starts beyond the best hit so far. Measured on the chair bake, whole-run wall time: 88.6s
 * first-found (87.63 / 89.59) against 96.5s nearest (97.23 / 95.85), so about 9%. The sidecar came
 * out byte-identical either way — this file's covers do not overlap along a shared ray, so the
 * ordering never gets to decide anything here. The cost buys that staying true of the next one.
 */
export function coverOccludes(index, p, dir, maxMm = COVER_RAY_MM) {
  index.ray++;
  const { xyz, cells, seen } = index;
  let ix = Math.floor(p[0] / CELL_MM),
    iy = Math.floor(p[1] / CELL_MM),
    iz = Math.floor(p[2] / CELL_MM);
  const sx = dir[0] > 0 ? 1 : -1,
    sy = dir[1] > 0 ? 1 : -1,
    sz = dir[2] > 0 ? 1 : -1;
  let tx = dir[0] !== 0 ? ((sx > 0 ? (ix + 1) * CELL_MM : ix * CELL_MM) - p[0]) / dir[0] : Infinity;
  let ty = dir[1] !== 0 ? ((sy > 0 ? (iy + 1) * CELL_MM : iy * CELL_MM) - p[1]) / dir[1] : Infinity;
  let tz = dir[2] !== 0 ? ((sz > 0 ? (iz + 1) * CELL_MM : iz * CELL_MM) - p[2]) / dir[2] : Infinity;
  const dx = dir[0] !== 0 ? Math.abs(CELL_MM / dir[0]) : Infinity;
  const dy = dir[1] !== 0 ? Math.abs(CELL_MM / dir[1]) : Infinity;
  const dz = dir[2] !== 0 ? Math.abs(CELL_MM / dir[2]) : Infinity;
  let bestT = Infinity;
  let bestOwner = -1;
  // A hit at distance d lies in a cell the walk enters at or before d, so once the cell being
  // entered starts past `bestT` nothing nearer is left to find.
  for (let entry = 0; entry <= maxMm && entry <= bestT;) {
    const cell = cells.get(cellKey(ix, iy, iz));
    if (cell)
      for (let a = 0; a < cell.length; a++) {
        const t = cell[a];
        if (seen[t] === index.ray) continue;
        seen[t] = index.ray;
        const d = rayTriDist(xyz, t, p[0], p[1], p[2], dir[0], dir[1], dir[2]);
        if (d <= maxMm && d < bestT) {
          bestT = d;
          bestOwner = index.owner[t];
        }
      }
    if (tx < ty && tx < tz) {
      entry = tx;
      ix += sx;
      tx += dx;
    } else if (ty < tz) {
      entry = ty;
      iy += sy;
      ty += dy;
    } else {
      entry = tz;
      iz += sz;
      tz += dz;
    }
  }
  return bestOwner;
}

/**
 * Directions over the hemisphere about +Z, spiralled by the golden angle and cosine-weighted, so
 * each one stands for the same slice of PROJECTED area and a grazing view counts for as little as
 * it shows. Index 0 is the pole, which lets a sample that can see straight out escape on its first
 * ray. Fixed and deterministic: the bake must be reproducible, so no RNG.
 */
const HEMI_DIRS = (() => {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const out = [];
  for (let i = 0; i < COVER_HEMI_DIRS; i++) {
    const z = Math.sqrt(1 - (i + 0.5) / COVER_HEMI_DIRS);
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    out.push([r * Math.cos(i * golden), r * Math.sin(i * golden), z]);
  }
  return out;
})();
/** Escaping directions a hidden sample is still allowed. 32 - ceil(0.85 * 32) = 4. */
const HEMI_ESCAPE_BUDGET = COVER_HEMI_DIRS - Math.ceil(COVER_HIDDEN_FRACTION * COVER_HEMI_DIRS);

/**
 * Whether `p`, on surface facing `n`, is hidden once the covers are on: all but
 * HEMI_ESCAPE_BUDGET of its outward hemisphere runs into a cover. The part's own surface is
 * ignored — assembling the covers is what changes visibility, and a zone that is already
 * self-occluded was never printable artwork in the first place.
 *
 * `blockers`, zeroed by the caller, comes back stamped with every cover that took a direction.
 */
function hemisphereBlocked(index, p, n, blockers) {
  // any vector not parallel to n; the pair only has to be orthonormal, not aligned to anything
  let ux, uy, uz;
  if (Math.abs(n[2]) < 0.9) {
    ux = -n[1];
    uy = n[0];
    uz = 0;
  } else {
    ux = 0;
    uy = -n[2];
    uz = n[1];
  }
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const vx = n[1] * uz - n[2] * uy,
    vy = n[2] * ux - n[0] * uz,
    vz = n[0] * uy - n[1] * ux;
  let escaped = 0;
  const w = [0, 0, 0];
  for (let i = 0; i < HEMI_DIRS.length; i++) {
    const d = HEMI_DIRS[i];
    w[0] = ux * d[0] + vx * d[1] + n[0] * d[2];
    w[1] = uy * d[0] + vy * d[1] + n[1] * d[2];
    w[2] = uz * d[0] + vz * d[1] + n[2] * d[2];
    const hit = coverOccludes(index, p, w);
    if (hit < 0) {
      if (++escaped > HEMI_ESCAPE_BUDGET) return false;
    } else blockers[hit] = 1;
  }
  return true;
}

/** Squared distance from `p` to triangle `t` of a body index (Ericson's Voronoi-region test). */
function ptTriDist2(xyz, t, px, py, pz) {
  const o = t * 9;
  const ax = xyz[o],
    ay = xyz[o + 1],
    az = xyz[o + 2];
  const abx = xyz[o + 3] - ax,
    aby = xyz[o + 4] - ay,
    abz = xyz[o + 5] - az;
  const acx = xyz[o + 6] - ax,
    acy = xyz[o + 7] - ay,
    acz = xyz[o + 8] - az;
  const apx = px - ax,
    apy = py - ay,
    apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
  const bpx = apx - abx,
    bpy = apy - aby,
    bpz = apz - abz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const qx = apx - abx * v,
      qy = apy - aby * v,
      qz = apz - abz * v;
    return qx * qx + qy * qy + qz * qz;
  }
  const cpx = apx - acx,
    cpy = apy - acy,
    cpz = apz - acz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const qx = apx - acx * w,
      qy = apy - acy * w,
      qz = apz - acz * w;
    return qx * qx + qy * qy + qz * qz;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const qx = bpx + (cpx - bpx) * w,
      qy = bpy + (cpy - bpy) * w,
      qz = bpz + (cpz - bpz) * w;
    return qx * qx + qy * qy + qz * qz;
  }
  const den = 1 / (va + vb + vc);
  const v = vb * den,
    w = vc * den;
  const qx = apx - abx * v - acx * w,
    qy = apy - aby * v - acy * w,
    qz = apz - abz * v - acz * w;
  return qx * qx + qy * qy + qz * qz;
}

/**
 * The body of `index` nearest to `p`, and its distance, by widening shells of cells around p's own
 * cell. `cap` bounds the search: nothing within it comes back as body -1. Pass a real upper bound
 * where one is known — an unbounded search on a point far from every body walks the whole grid.
 */
function nearestBody(index, p, cap) {
  const { xyz, cells, owner, lo, hi } = index;
  let best = cap * cap;
  let body = -1;
  const c0 = Math.floor(p[0] / CELL_MM),
    c1 = Math.floor(p[1] / CELL_MM),
    c2 = Math.floor(p[2] / CELL_MM);
  for (let r = 0; ; r++) {
    // A cell in shell r cannot come nearer than (r-1) cells, p sitting anywhere inside its own.
    const reach = (r - 1) * CELL_MM;
    if (r > 1 && reach * reach > best) break;
    for (let i = c0 - r; i <= c0 + r; i++)
      for (let j = c1 - r; j <= c1 + r; j++)
        for (let k = c2 - r; k <= c2 + r; k++) {
          if (r > 0 && Math.abs(i - c0) !== r && Math.abs(j - c1) !== r && Math.abs(k - c2) !== r)
            continue;
          const cell = cells.get(cellKey(i, j, k));
          if (!cell) continue;
          const bx = Math.max(i * CELL_MM - p[0], 0, p[0] - (i + 1) * CELL_MM);
          const by = Math.max(j * CELL_MM - p[1], 0, p[1] - (j + 1) * CELL_MM);
          const bz = Math.max(k * CELL_MM - p[2], 0, p[2] - (k + 1) * CELL_MM);
          if (bx * bx + by * by + bz * bz > best) continue;
          for (let a = 0; a < cell.length; a++) {
            const d = ptTriDist2(xyz, cell[a], p[0], p[1], p[2]);
            if (d < best) {
              best = d;
              body = owner[cell[a]];
            }
          }
        }
    if (
      c0 - r <= lo[0] &&
      c0 + r >= hi[0] &&
      c1 - r <= lo[1] &&
      c1 + r >= hi[1] &&
      c2 - r <= lo[2] &&
      c2 + r >= hi[2]
    )
      break;
  }
  return { d: Math.sqrt(best), body };
}

/** Barycentric point (s, t) of the triangle v0/v1/v2, in whatever dimension they carry. */
export const at = (v0, v1, v2, s, t) => v0.map((x, i) => x + (v1[i] - x) * s + (v2[i] - x) * t);

/**
 * Which printed parts each cover may hide surface on, or `null` for "wherever it occludes".
 *
 * A cover that RESTS on parts hides on the parts it rests on, contact being the same
 * COVER_CONTACT_MM the classifier calls touching. The chair's two cushions rest at 0.42-0.62mm on
 * everything they hide (measured 2026-08-30), so contact names their parts exactly.
 *
 * A cover that rests on nothing is unconstrained. It used to be attributed to the ONE part holding
 * the largest share of its own nearest surface, which on the chair gave each wheel its mount and
 * nothing else — and that is what cut the wheel's shadow off along a straight line down the
 * mount/fender seam on both side sheets, when a mounted wheel plainly hides across it. Each fender
 * carries ~7,450mm² of surface the wheel hides and the rule handed all of it back.
 *
 * The rule was guarding against a cover claiming surface the assembly does not actually hide. But
 * the hemisphere test already answers that, and now answers it against exact geometry: the wheel is
 * a declared solid disc (see buildCoverSolids) rather than a hollow CAD half-dish whose own spoke
 * openings let rays through. A second, weaker guess layered on top only subtracted right answers.
 */
function coverHomeParts(coverIdx, partIdx, covers, parts) {
  const home = covers.map(() => new Set());
  covers.forEach((c, ci) => {
    for (const v of c.verts) {
      const { body } = nearestBody(partIdx, v, COVER_CONTACT_MM);
      if (body >= 0) home[ci].add(body);
    }
  });
  // Both directions: a vertex of either mesh can be the only witness of a flush contact whose
  // other side is one big triangle with its vertices far away.
  parts.forEach((p, pi) => {
    for (const v of p.verts) {
      const { body } = nearestBody(coverIdx, v, COVER_CONTACT_MM);
      if (body >= 0) home[body].add(pi);
    }
  });
  return home.map((h) => (h.size ? h : null));
}

/**
 * Barycentric sub-triangles of one triangle, `k` to a side. Cached: the same handful of `k` values
 * covers a whole bake, and rebuilding the 24x24 case per triangle would cost more than the rays.
 */
const SUB_CELLS = new Map();
/** 24 to a side is 576 samples, which the chair's largest triangle (8,430mm²) already sits under. */
export const SUB_CELLS_MAX = 24;

/**
 * The barycentric patches one triangle of `uvArea` mm² is sampled at: COVER_SAMPLE_MM2 per patch,
 * capped at SUB_CELLS_MAX to a side.
 *
 * Exported with `cellCentroid` below so scripts/measure-wheel-shadow.mjs samples at the density and
 * the points the bake does rather than restating the arithmetic. A published figure taken with a
 * lookalike is a figure nobody can check, which is the same reason `bodyIndex` is exported.
 */
export const sampleCells = (uvArea) =>
  subCells(Math.max(1, Math.min(SUB_CELLS_MAX, Math.ceil(Math.sqrt(uvArea / COVER_SAMPLE_MM2)))));

/** Barycentric centroid of one such patch, which is where its single sample is taken. */
export const cellCentroid = (cell) => [
  (cell[0][0] + cell[1][0] + cell[2][0]) / 3,
  (cell[0][1] + cell[1][1] + cell[2][1]) / 3,
];

export function subCells(k) {
  let cached = SUB_CELLS.get(k);
  if (cached) return cached;
  const out = [];
  for (let i = 0; i < k; i++)
    for (let j = 0; j < k - i; j++) {
      out.push([
        [i, j],
        [i + 1, j],
        [i, j + 1],
      ]);
      if (j < k - i - 1)
        out.push([
          [i + 1, j],
          [i + 1, j + 1],
          [i, j + 1],
        ]);
    }
  cached = out.map((tri) => tri.map(([a, b]) => [a / k, b / k]));
  SUB_CELLS.set(k, cached);
  return cached;
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
 * The seed triangles a zone grows from and the direction it grows against, which claimWedge needs
 * too — a second derivation of "which way does this zone face" would be a second answer.
 */
export function zoneSeed(weld, zoneCfg, patches, triGeom) {
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
  return { seedTris, growNormal };
}

/**
 * BFS from the seeded patch across shared edges, accepting triangles whose face normal stays
 * within maxAngleDeg of the config's seed direction. Returns global triangle indices, sorted.
 */
export function segmentZone(weld, zoneCfg, patches, edgeTris, triGeom) {
  const { seedTris, growNormal } = zoneSeed(weld, zoneCfg, patches, triGeom);
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

/**
 * Hands the strip of surface left BETWEEN two zones to them, so their charts abut along it instead
 * of stopping either side of a fillet. Mutates `zoneTris` in place and returns one report row per
 * strip claimed.
 *
 * The strip is an unclaimed connected component with exactly two zones on its boundary, and every
 * triangle in it goes to whichever of those two grow normals its own is nearer: a Voronoi split in
 * normal space, which is the same measure the angle limits cut it out with in the first place.
 *
 * **The two-zone gate is the only thing bounding this, and it is not conservatism.** Most of a
 * printed assembly is surface no zone wants — the chair leaves 288,037 of its 332,784 welded
 * triangles unclaimed — and nearly all of it is ONE component with 8 zones around it (213,688
 * triangles, 927,946mm², against 159 and 156 for the two corner strips). A rule that took every
 * component touching a zone would put artwork over the whole hidden interior.
 *
 * Per-triangle adjacency does not work here and was measured before this: only 5 of the chair's
 * unclaimed triangles touch two zones directly, and iterating that rule to fixpoint claims 8 in
 * three passes and stops, because the strip is two triangles wide almost everywhere. Whole
 * components need no iteration either — claiming one cannot change another's boundary, since two
 * unclaimed components adjacent to each other would be one component.
 */
export function claimWedges(weld, zoneCfgs, zoneTris, edgeTris, triGeom, growNormals) {
  const owner = new Int32Array(weld.tris.length).fill(-1);
  zoneTris.forEach((tris, zi) => {
    for (const ti of tris) if (owner[ti] < 0) owner[ti] = zi;
  });
  const nbrsOf = (ti) => {
    const t = weld.tris[ti];
    const out = [];
    for (let k = 0; k < 3; k++)
      for (const o of edgeTris.get(edgeKey(t.v[k], t.v[(k + 1) % 3]))) if (o !== ti) out.push(o);
    return out;
  };
  const seen = new Uint8Array(weld.tris.length);
  const report = [];
  for (let start = 0; start < owner.length; start++) {
    if (owner[start] >= 0 || seen[start] || !triGeom[start]) continue;
    seen[start] = 1;
    const comp = [];
    const touches = new Set();
    const queue = [start];
    while (queue.length) {
      const ti = queue.pop();
      comp.push(ti);
      for (const o of nbrsOf(ti)) {
        if (!triGeom[o]) continue;
        if (owner[o] >= 0) touches.add(owner[o]);
        else if (!seen[o]) {
          seen[o] = 1;
          queue.push(o);
        }
      }
    }
    if (touches.size !== 2) continue;
    const [a, b] = [...touches];
    const inComp = new Set(comp);
    const want = new Map(
      comp.map((ti) => [
        ti,
        dot3(triGeom[ti].normal, growNormals[a]) >= dot3(triGeom[ti].normal, growNormals[b])
          ? a
          : b,
      ]),
    );
    // Grown from each zone's own edge of the strip rather than assigned outright, so a triangle
    // only joins a zone it is connected to. Assigning by normal alone left `left` a stray triangle
    // marooned in the far half of the corner strip, and assertSingleIsland refused the bake
    // (10,095 of 10,096 reachable). Whatever a front cannot reach stays unclaimed and is reported.
    const counts = [0, 0];
    const areas = [0, 0];
    let front = comp.filter((ti) => nbrsOf(ti).some((o) => owner[o] === want.get(ti)));
    while (front.length) {
      const next = [];
      for (const ti of front) {
        if (owner[ti] >= 0) continue;
        const zi = want.get(ti);
        owner[ti] = zi;
        zoneTris[zi].push(ti);
        const k = zi === a ? 0 : 1;
        counts[k]++;
        areas[k] += triGeom[ti].area;
        for (const o of nbrsOf(ti))
          if (owner[o] < 0 && inComp.has(o) && want.get(o) === zi) next.push(o);
      }
      front = next;
    }
    const left = comp.filter((ti) => owner[ti] < 0);
    report.push({
      zones: [zoneCfgs[a].id, zoneCfgs[b].id],
      tris: counts,
      areaMm2: areas,
      unreached: left.length,
      unreachedMm2: left.reduce((t, ti) => t + triGeom[ti].area, 0),
    });
  }
  for (const tris of zoneTris) tris.sort((x, y) => x - y);
  return report;
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

/**
 * Area (mm²) of one `{ outer, holes }` region: the outer loop less its holes, unsigned.
 *
 * Exported because the same sum is what the bake log reports, what dropSmallRegions filters on, and
 * what the tests assert against — and a region measured by its outer loop alone reads a ring as
 * solid, which is the difference between "this chart is mostly hidden" and "this chart is a frame".
 */
export const regionNetArea = (r) =>
  Math.abs(loopArea(r.outer)) - r.holes.reduce((s, h) => s + Math.abs(loopArea(h)), 0);

/**
 * Area centroid of a polygon, falling back to the bbox centre when the loop is too thin for the
 * signed-area formula to be stable. Only used to park a text label, so "somewhere sensible inside
 * the bbox" is the whole requirement — a concave region can push the true centroid outside itself.
 */
const loopCentroid = (pts) => {
  const a = loopArea(pts);
  if (Math.abs(a) > 1e-9) {
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      const c = x1 * y2 - x2 * y1;
      cx += (x1 + x2) * c;
      cy += (y1 + y2) * c;
    }
    return [cx / (6 * a), cy / (6 * a)];
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
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

/** Odd, so a containment vote can't tie. */
const CONTAIN_SAMPLES = 9;

/**
 * Is `inner` contained by `outer`? Votes over edge midpoints spread around `inner` rather than
 * trusting a single vertex.
 *
 * Testing loops[i][0] is not safe here: where splitAtRepeats cuts a figure-eight into lobes, the
 * first vertex of a sub-loop IS the pinch vertex it shares with its sibling, and a crossing-number
 * test evaluated exactly on the other loop's boundary is undefined — it answers on which side the
 * floating-point dust falls. The lobe-as-hole misclassification this function exists to prevent
 * was therefore being avoided by luck. Edge midpoints of a simple loop can only meet a sibling at
 * that same pinch point, so a majority over several of them is decided by samples genuinely off
 * the shared boundary.
 */
const loopInsideLoop = (inner, outer) => {
  const n = Math.min(inner.length, CONTAIN_SAMPLES);
  let votes = 0;
  for (let s = 0; s < n; s++) {
    const i = Math.floor((s * inner.length) / n);
    const [x1, y1] = inner[i];
    const [x2, y2] = inner[(i + 1) % inner.length];
    if (pointInLoop([(x1 + x2) / 2, (y1 + y2) / 2], outer)) votes++;
  }
  return votes * 2 > n;
};

/**
 * Group boundary loops into {outer, holes} regions by containment depth — even depth is a solid
 * island of its own, odd depth is a hole in its immediate parent. A part's slice of a zone can be
 * several disjoint islands (a stripe of surface interrupted by a bolt boss, say), so "largest loop
 * is the outline, everything else is a hole" isn't good enough here; depth is the same rule
 * shapeToFeature applies to SVG subpaths at runtime.
 *
 * Parity is right for nested SVG subpaths, wrong for triangulation loops: a concave slice has
 * solid lobes inside another loop's ring, and parity calls them holes. Cost a merged-zone
 * prototype 26%/60% of two handles' claims; every shipped claim matches its triangulation within
 * 0.3%, so today's bake is unaffected. Classify by winding sign instead if a future zone trips it.
 */
function classifyRegions(loops) {
  const n = loops.length;
  const areas = loops.map((l) => Math.abs(loopArea(l)));
  const parent = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let best = Infinity;
    for (let j = 0; j < n; j++) {
      if (i === j || areas[j] <= areas[i] || areas[j] >= best) continue;
      if (!loopInsideLoop(loops[i], loops[j])) continue;
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

/**
 * Morphological close-then-open at DEAD_SMOOTH_MM: fill the notches, then take the spikes off.
 * `close(X)` is contained in `X` dilated by the radius and `open` only ever shrinks, so the result
 * still cannot reach further onto surface the classifier called visible than the radius itself.
 *
 * Closing FIRST, which is the order that matters. This runs on the RAW sample union now, before
 * the bleed rather than after it, so what the closing repairs is the classifier's own speckle: a
 * cell whose hemisphere escaped where every neighbour's did not leaves a one-cell hole, and a
 * shadow crossing a curved seam arrives as lobes joined by a cell or two. Opening first erodes
 * those joins away before anything can bridge them, and the surface goes back to taking artwork
 * nobody will see. Re-derived 2026-08-31 by swapping the offset list and rebaking:
 *
 *   zone        open-then-close   close-then-open
 *   left               20,596mm²         23,486mm²
 *   right              20,611mm²         23,777mm²
 *   seat-left          13,276mm²         13,893mm²
 *   seat-right         13,361mm²         13,914mm²
 *   front              31,191mm²         31,014mm²
 *
 * The direction is safe despite claiming more: closing is bounded by the paragraph above, so it
 * reaches at most DEAD_SMOOTH_MM past what the classifier called hidden, and the visible region is
 * then grown by four times that (bleedMm 20) and subtracted. The bleed decides the edge; this only
 * decides whether the shape arriving at it is in one piece.
 */
function smoothDead(cs) {
  if (DEAD_SMOOTH_MM <= 0) return cs;
  let cur = cs;
  for (const d of [DEAD_SMOOTH_MM, -DEAD_SMOOTH_MM, -DEAD_SMOOTH_MM, DEAD_SMOOTH_MM]) {
    const next = cur.offset(d, 'Round', 2, 32);
    if (cur !== cs) cur.delete();
    cur = next;
  }
  return cur;
}

/** Drop whole outer-plus-holes regions under `minAreaMm2`; returns `cs` itself if none qualify. */
function dropSmallRegions(cs, minAreaMm2, wasm) {
  const rings = cs.toPolygons().map((r) => r.map(([x, y]) => [x, y]));
  const regions = classifyRegions(rings);
  const keep = regions.filter((r) => regionNetArea(r) >= minAreaMm2);
  if (keep.length === regions.length) return cs;
  return new wasm.CrossSection(
    keep.flatMap((r) => [r.outer, ...r.holes]),
    'EvenOdd',
  );
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

/** Below this (mm²) a sub-region cannot hold a readable part label at 1:1, so it goes unlabelled. */
const LABEL_MIN_AREA_MM2 = 400;

/** Top strip reserved for the sheet title (baseline 12) and legend (baseline 24), plus descender. */
const HEADER_BAND_MM = 28;

/**
 * Mean glyph advance as a fraction of font size, for estimating a label's width well enough to
 * tell whether two of them collide. 0.45 is about right for lowercase sans-serif, which is all
 * these labels ever are (shortPartName lowercases the id and strips the kind prefix).
 */
const LABEL_ADVANCE_EM = 0.45;

/** `chair-body` + `chair-storage-left` -> `storage left`: the kind prefix is on the sheet already. */
const shortPartName = (partId, kindId) => {
  const prefix = `${kindId.split('-')[0]}-`;
  return (partId.startsWith(prefix) ? partId.slice(prefix.length) : partId).replace(/-/g, ' ');
};

/**
 * True-size template SVG for one zone: the grey silhouette is the zone's UV outline with holes
 * punched (evenodd), dashed accent polylines mark printed-part seams. SVG y runs down while v
 * runs up, so v is flipped — the app's placer maps SVG y-down to −v the same way, which keeps a
 * template loaded at Scale 100% / Offset 0/0 landing exactly on the zone.
 *
 * A zone that spans a seam also names the printed part on each side of it. The seam lines say
 * *where* the artwork gets split; without the names there is nothing on the sheet saying which
 * physical piece each area ends up on, which is the thing an artist needs to know before putting a
 * face across the join. Labels sit on each part's largest sub-region only — the small islands are
 * usually too thin to hold text.
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
  // The per-part subRegions, the same loops the runtime clips artwork to, so the sheet shows what
  // will actually cut. The whole-zone lobes are display-only: chained across a stitched seam they
  // fan into spikes (48 of them on the chair's left flank), drawing surface that is not there and
  // hiding surface that is.
  const silhouette = zone.charts.flatMap((c) => c.subRegions.flatMap((r) => [r.outer, ...r.holes]));
  const d = silhouette.map((loop) => toD(loop.map(pt))).join(' ');
  // Hatched overlay: surface another part hides once the chair is assembled (deadRegions). The
  // artist sees where artwork stops before spending detail there. Fill style carries the meaning,
  // same ink as every other guide mark.
  const deadLoops = zone.charts.flatMap((c) =>
    (c.deadRegions ?? []).flatMap((r) => [r.outer, ...r.holes]),
  );
  const deadD = deadLoops.map((loop) => toD(loop.map(pt))).join(' ');
  const deadDefs = deadD
    ? `\n  <defs>\n    <pattern id="hidden" width="4" height="4" patternUnits="userSpaceOnUse">\n` +
      `      <path d="M-1 1 L1 -1 M0 4 L4 0 M3 5 L5 3" stroke="${ACCENT}" stroke-width="0.5" ` +
      `stroke-opacity="0.45"/>\n    </pattern>\n  </defs>`
    : '';
  const deadPath = deadD
    ? `\n  <path d="${deadD}" fill="url(#hidden)" fill-rule="evenodd" stroke="${ACCENT}" ` +
      `stroke-width="0.3" stroke-opacity="0.5"/>`
    : '';
  const dashed = (pts) =>
    `  <polyline points="${pts.map((p) => pt(p).join(',')).join(' ')}" fill="none" ` +
    `stroke="${ACCENT}" stroke-width="0.6" stroke-dasharray="2 3"/>`;
  // A self-mirrored zone's centre line: the runtime reflects a mirrored design about the uvBounds
  // centre, and this is the one mark on the sheet that says where "the right half" starts.
  const selfMirror = !!zone.mirror?.self;
  const centreU = zone.uvBounds.maxU / 2;
  const seams = [
    ...(zone.seams || []).map(dashed),
    ...(selfMirror
      ? [
          dashed([
            [centreU, chartBBox.maxV],
            [centreU, 0],
          ]),
        ]
      : []),
  ].join('\n');
  // Placed labels, so a later one can be dropped rather than land on top of an earlier one.
  const placed = [];
  const partLabels = (zone.charts.length > 1 ? zone.charts : [])
    .map((c) => {
      const biggest = c.subRegions
        .map((r) => ({ outer: r.outer, area: Math.abs(loopArea(r.outer)) }))
        .sort((a, b) => b.area - a.area)[0];
      return biggest ? { name: c.libraryPartId, ...biggest } : null;
    })
    .filter((l) => l && l.area >= LABEL_MIN_AREA_MM2)
    .map((l) => {
      const ys = l.outer.map((p) => pt(p)[1]);
      const [cx, cy] = pt(loopCentroid(l.outer));
      // The sheet title and legend are centered text at the top; a sub-region whose centroid lands
      // up there would print straight through them (five of the seat's labels did). Drop to the
      // middle of whatever of the region sits below the header band, and give up on the label
      // entirely if the region has nothing down there — no label beats an unreadable overprint.
      let y = cy;
      if (y < HEADER_BAND_MM) {
        const bottom = Math.max(...ys);
        if (bottom <= HEADER_BAND_MM) return null;
        y = (Math.max(Math.min(...ys), HEADER_BAND_MM) + bottom) / 2;
      }
      const text = shortPartName(l.name, kindId);
      const half = (text.length * LABEL_ADVANCE_EM * LABEL_SIZE) / 2;
      if (placed.some((p) => Math.abs(p[0] - cx) < p[2] + half && Math.abs(p[1] - y) < LABEL_SIZE))
        return null;
      placed.push([cx, y, half]);
      return (
        `  <text x="${round(cx, 2)}" y="${round(y, 2)}" text-anchor="middle" ` +
        `font-family="sans-serif" font-size="${LABEL_SIZE}" fill="${ACCENT}" ` +
        `opacity="0.75">${xmlEscape(text)}</text>`
      );
    })
    .filter(Boolean)
    .join('\n');
  const legend = [
    zone.seams?.length ? 'Dashed = printed-part seam' : '',
    selfMirror ? 'Dashed centre line = mirror' : '',
    partLabels ? 'Labels name the printed part' : '',
    deadD ? 'Hatched = hidden once assembled' : '',
  ]
    .filter(Boolean)
    .join('. ');
  // Shrunk to fit the sheet rather than wrapped: a second line would drop out of the header band
  // the part labels dodge, and land on top of one. Three clauses at full size run 320mm, which is
  // wider than every chair template.
  const legendSize = Math.min(
    LABEL_SIZE,
    (W * 0.96) / Math.max(1, legend.length * LABEL_ADVANCE_EM),
  );
  const seamNote = legend
    ? `\n  <text x="${W / 2}" y="${Math.min(H - 4, 24)}" text-anchor="middle" ` +
      `font-family="sans-serif" font-size="${round(legendSize, 2)}" fill="${ACCENT}">${legend}</text>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!--
  ${xmlEscape(zone.name)} design zone template (${kindId}) — true-to-size at 1:1 mm (${W} x ${H}mm).
  The grey shape is the zone's unwrapped printable area; the app clips artwork to exactly this
  outline and wraps it back onto the 3D part. Load it at Scale 100%, Offset 0/0 and it lands
  centered on the zone without adjustment. Gaps punched in the grey are real holes.

  GENERATED by scripts/bake-zones.mjs - do not hand-edit; re-run the bake to regenerate.
-->
<svg width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}" version="1.1"
     xmlns="http://www.w3.org/2000/svg">${deadDefs}
  <path d="${d}" fill="${GRAY}" fill-rule="evenodd" />${deadPath}
${seams}
${partLabels}
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

/**
 * Guard fingerprint: refuses at load time to pair zones with a mesh they weren't baked for.
 *
 * Math.fround is load-bearing. The runtime hashes the Float32Array load3MF hands it, while the
 * parsed 3MF here is doubles, and a coordinate can round to a different 3rd decimal across that
 * narrowing — chair-wheel-mount-left's max z is -203.4805, which is -203.481 as a double and
 * -203.480 once stored as float32. That mismatch reads at load time as "this part was re-packed
 * without re-baking" and the part's zones are silently dropped, so the bake has to see exactly the
 * numbers the browser will.
 */
export function meshFingerprint(part) {
  const bb = [
    [Infinity, Infinity, Infinity],
    [-Infinity, -Infinity, -Infinity],
  ];
  for (const v of part.verts)
    for (let k = 0; k < 3; k++) {
      const c = Math.fround(v[k]);
      if (c < bb[0][k]) bb[0][k] = c;
      if (c > bb[1][k]) bb[1][k] = c;
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
  if (config.mirrorAxis !== undefined && !['x', 'y', 'z'].includes(config.mirrorAxis))
    throw new Error('mirrorAxis must be "x", "y" or "z" when present');
  if (config.claimWedge !== undefined && config.claimWedge !== true)
    throw new Error('claimWedge is opt-in: set it to true or leave it out');
  if (config.covers !== undefined) {
    const c = config.covers;
    if (typeof c.file !== 'string' || !c.file)
      throw new Error('covers needs a file path (the whole-assembly export with the cover bodies)');
    if (!(c.bleedMm >= 0 && c.bleedMm <= 100))
      throw new Error('covers.bleedMm must be between 0 and 100mm');
    if (!/^#[0-9A-Fa-f]{6,8}$/.test(c.referenceColor ?? ''))
      throw new Error(
        'covers.referenceColor must be a hex color (the color of the parts themselves)',
      );
    if (c.mirrorAxis !== undefined && !['x', 'y', 'z'].includes(c.mirrorAxis))
      throw new Error('covers.mirrorAxis must be "x", "y" or "z" when present');
    if (c.solids !== undefined) {
      if (!Array.isArray(c.solids) || !c.solids.length)
        throw new Error('covers.solids must be a non-empty array when present');
      for (const s of c.solids) {
        if (!s.id) throw new Error('every covers.solids entry needs an id');
        if (s.type !== 'cylinder')
          throw new Error(`covers.solids "${s.id}": the only type is "cylinder"`);
        if (!['x', 'y', 'z'].includes(s.axis))
          throw new Error(`covers.solids "${s.id}": axis must be "x", "y" or "z"`);
        if (!(s.radiusMm > 0))
          throw new Error(`covers.solids "${s.id}": radiusMm must be positive`);
        if (!Array.isArray(s.replacesDims) || s.replacesDims.length !== 3)
          throw new Error(
            `covers.solids "${s.id}": replacesDims must be the 3 bbox dimensions of the bodies ` +
              `it replaces, which is what poses the solid from the file`,
          );
        if (s.declaredShadow !== undefined && s.declaredShadow !== true)
          throw new Error(`covers.solids "${s.id}": declaredShadow must be true when present`);
        if (s.declaredShadow && !(s.radiusMm - c.bleedMm > 0))
          throw new Error(
            `covers.solids "${s.id}": declaredShadow needs radiusMm (${s.radiusMm}) larger than ` +
              `covers.bleedMm (${c.bleedMm}) — the declared dead disc is their difference`,
          );
      }
    }
  }
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
 *
 * When the config declares `covers`, opts must carry `covers` (the registerCovers output, in the
 * bake frame) and `wasm` (a Manifold instance for the 2D bleed offset). Requiring them rather
 * than skipping is deliberate: a bake that silently ran without the covers file would emit a
 * sidecar with no dead surface at all, and nothing downstream could tell.
 */
export function bakeZones(config, parts, log = () => {}, opts = {}) {
  validateConfig(config);
  if (
    parts.length !== config.parts.length ||
    parts.some((p, i) => p.libraryPartId !== config.parts[i].libraryPartId)
  )
    throw new Error('parts array does not match config.parts (same ids, same order, required)');
  if (config.covers && !(opts.covers && opts.wasm))
    throw new Error('config declares covers but the bake was given no cover meshes / Manifold');
  if (config.covers?.mirrorAxis && opts.coverTwin?.length !== opts.covers.length)
    throw new Error(
      'covers.mirrorAxis needs opts.coverTwin, the cover pairing symmetrizeCovers returns: ' +
        'without it the classifier cannot ask the mirrored question and the bake is asymmetric',
    );
  if (config.covers?.mirrorAxis) {
    const bad = asymmetricPart(parts, 'xyz'.indexOf(config.covers.mirrorAxis));
    if (bad)
      throw new Error(
        `covers.mirrorAxis is "${config.covers.mirrorAxis}", but part "${bad}" neither crosses ` +
          `that plane nor has a part mirroring it, so the classifier's mirrored sample would not ` +
          `land on this kind at all. Drop covers.mirrorAxis for an asymmetric kind.`,
      );
  }
  const coverIdx = config.covers ? bodyIndex(opts.covers) : null;
  const coverHome = coverIdx
    ? coverHomeParts(coverIdx, bodyIndex(parts), opts.covers, parts)
    : null;
  const partCovers = parts.map((_, pi) =>
    coverHome ? coverHome.flatMap((h, ci) => (h === null || h.has(pi) ? [ci] : [])) : [],
  );
  if (coverHome)
    coverHome.forEach((h, ci) =>
      log(
        `  cover ${ci} hides on: ${
          h === null
            ? 'any part it occludes (rests on nothing)'
            : [...h].map((pi) => parts[pi].libraryPartId).join(', ')
        }`,
      ),
    );
  // Declared shadows: a solid whose silhouette is a known number gets its dead region DRAWN from
  // that number, not recovered by classify-and-bleed. The derived pipeline can never hand back a
  // clean disc under the chair's wheel: the bleed erodes 20mm in from the rim AND 20mm out from
  // every through-hole inside the shadow, so the arc came out at 112.5mm ± 11.4 against a rim at
  // 140. The dead radius is radiusMm − bleedMm — the same shifted-cover margin the bleed reserves
  // everywhere else, kept by construction instead of by dilation.
  const declaredSpecs = (config.covers?.solids ?? []).filter((s) => s.declaredShadow);
  if (declaredSpecs.length && !opts.solids)
    throw new Error(
      'config declares covers.solids with declaredShadow but the bake was given no opts.solids ' +
        '(the buildCoverSolids report): without the posed solids the shadow would silently fall ' +
        'back to the derived shape',
    );
  const declared = declaredSpecs.flatMap((spec) => {
    const axis = 'xyz'.indexOf(spec.axis);
    return opts.solids
      .filter((rep) => rep.id === spec.id)
      .map((rep) => {
        const b = bounds(opts.covers[rep.coverIndex].verts);
        return {
          id: spec.id,
          axis,
          u: (axis + 1) % 3,
          w: (axis + 2) % 3,
          mid: b.mid,
          lo: b.mn[axis],
          hi: b.mx[axis],
          deadR: spec.radiusMm - config.covers.bleedMm,
          cover: rep.coverIndex,
        };
      });
  });
  const warnings = [];
  const mirrorAxis = config.mirrorAxis ? 'xyz'.indexOf(config.mirrorAxis) : -1;
  const zoneMirror = mirrorAxis >= 0 ? pairMirrorZones(config.zones, mirrorAxis) : null;
  if (zoneMirror) warnings.push(...zoneMirror.warnings);
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
  // Every zone is segmented before any is unwrapped, so claimWedge can see what the angle limits
  // left between them.
  const zoneTriSets = config.zones.map((z) => segmentZone(weld, z, patches, edgeTris, triGeom));
  if (config.claimWedge) {
    const grow = config.zones.map((z) => zoneSeed(weld, z, patches, triGeom).growNormal);
    for (const w of claimWedges(weld, config.zones, zoneTriSets, edgeTris, triGeom, grow))
      log(
        `claimWedge: the strip between "${w.zones[0]}" and "${w.zones[1]}" went ` +
          `${w.tris[0]} tris (${w.areaMm2[0].toFixed(0)}mm²) to the first, ` +
          `${w.tris[1]} (${w.areaMm2[1].toFixed(0)}mm²) to the second, ` +
          `${w.unreached} (${w.unreachedMm2.toFixed(0)}mm²) reached by neither`,
      );
  }
  for (const [zi, zoneCfg] of config.zones.entries()) {
    const zoneTris = zoneTriSets[zi];
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
      .filter((pts) => pts.length >= 3);
    if (!loops.length) throw new Error(`zone "${zoneCfg.id}": no boundary loop found`);
    // A zone is one connected island of triangles, but its UV footprint need not be one disk: where
    // two lobes meet at a pinch vertex, splitAtRepeats hands back a separate simple loop for each.
    // Classify by containment rather than assuming "largest loop is the outline, rest are holes" —
    // on the chair's left flank that assumption made the second-largest LOBE a hole of the first,
    // leaving `boundary` enclosing 22,941mm² of a 124,728mm² zone with 17 of its 18 "holes" lying
    // outside it entirely.
    const zoneRegions = classifyRegions(loops)
      .map((r) => ({
        outer: r.outer,
        holes: r.holes.filter((h) => Math.abs(loopArea(h)) >= minHoleArea),
        area: Math.abs(loopArea(r.outer)),
      }))
      .sort((a, b) => b.area - a.area);
    // `boundary`/`holes` are singular in the sidecar and so can only carry the LARGEST lobe. That is
    // fine because nothing cuts against them: every chart carries `subRegions`, the bake refuses to
    // emit a chart without them, and ConformalZoneMapper.boundary() prefers them — the per-part
    // regions do sum to the whole zone (left: 124,728mm² across its 4 parts, against a 22,941mm²
    // largest lobe). Treat these two as the display outline, not the clip region.
    const outer = { pts: zoneRegions[0].outer };
    const holes = zoneRegions[0].holes.map((pts) => ({ pts }));
    const roundLoop = (pts) => pts.map((p) => [round(p[0], 3), round(p[1], 3)]);

    // Dead surface: what the covers hide, minus a bleed strip so artwork runs past the visible
    // edge and a slightly shifted cover never reveals blank plastic. The bleed is a dilation of
    // the VISIBLE region, not an erosion of the covered one: erosion would also pull the dead
    // region off the zone's own outer boundary, resurrecting a band of hidden surface that has
    // no visible artwork to continue. Every region here is unioned straight from UV triangles:
    // the zone-level boundary loops are the display-only outline that fans into spikes across
    // stitched seams, and a visible region derived from them eats real dead surface.
    //
    // Classification runs per COVER_SAMPLE_MM2 patch, not per triangle: a triangle here can be
    // 8,430mm² of one flat CAD face, and its verdict would be the whole face either way.
    //
    // Both sets are unioned from the SAME patches. `zone minus covered` looks equivalent and is
    // not: the two unions are triangulated differently along every shared edge, so the difference
    // keeps hairline slivers of no area but full length, and dilating one by 20mm sweeps away the
    // dead region around it. Measured on the seat: identical areas either way (5,780 against
    // 5,786mm² visible), 5,999mm² of dead surface by subtraction against 22,354mm² by union.
    //
    // The two sets do not cover every patch, and must not: a patch hidden only by a cover this
    // part does not carry (see coverHomeParts) is neither visible nor claimed, so it stays
    // printable without eating the dead region on the part next to it through the bleed.
    const triRing = (zt) => zt.map((z) => uvOf(z));
    let deadCS = null;
    if (coverIdx) {
      const coveredRings = [];
      const visibleRings = [];
      const declaredRings = [];
      const blockers = new Uint8Array(coverIdx.bodyCount);
      /**
       * Is this sample inside a declared dead disc? The gates mirror the classifier's own limits:
       * within COVER_RAY_MM of the solid's axial slab (the classifier's reach), facing it along
       * the axis, hidden only on parts that carry the cover (partCovers, same as claimed) — then
       * within deadR of the axis. Analytic on the snapped poses, so the flanks agree by
       * construction; samples in the bleed annulus (deadR..radiusMm) fall through to classify.
       */
      const declaredDead = (p, n, mine) => {
        for (const d of declared) {
          const ax = Math.max(d.lo - p[d.axis], p[d.axis] - d.hi, 0);
          if (ax > COVER_RAY_MM) continue;
          if (!mine.includes(d.cover)) continue;
          if (ax > 0 && n[d.axis] * (d.mid[d.axis] - p[d.axis]) <= 0) continue;
          if (Math.hypot(p[d.u] - d.mid[d.u], p[d.w] - d.mid[d.w]) <= d.deadR) return true;
        }
        return false;
      };
      const mirrorAxis = config.covers?.mirrorAxis ? 'xyz'.indexOf(config.covers.mirrorAxis) : -1;
      const twin = opts.coverTwin;
      /**
       * One sample's verdict as bit 1 = hidden, bit 2 = hidden by a cover this part carries.
       * `mirrored` says the point has been reflected across the mirror plane, so a blocker is
       * stamped against the twin cover and has to be read back through `twin`.
       */
      const classify = (p, nrm, mine, mirrored) => {
        // Contact first: it is one ray against the hemisphere's 32, and it is the cheap answer
        // for everything the cushions actually touch. A cover this close is resting on this
        // part by definition, so a contact hit needs no further attribution.
        if (coverOccludes(coverIdx, p, nrm, COVER_CONTACT_MM) >= 0) return 3;
        blockers.fill(0);
        if (!hemisphereBlocked(coverIdx, p, nrm, blockers)) return 0;
        // Hidden by a cover this part does not carry: hidden all the same, so it must not
        // dilate into the dead region around it, and not ours to hatch either.
        return mine.some((ci) => blockers[mirrored ? twin[ci] : ci]) ? 3 : 1;
      };
      zoneTris.forEach((ti, k) => {
        const p3 = weld.tris[ti].v.map((g) => weld.verts[g]);
        const mine = partCovers[weld.tris[ti].part];
        const q = triRing(zTris[k]);
        const uvArea =
          Math.abs(
            (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (q[1][1] - q[0][1]),
          ) / 2;
        const n = triGeom[ti].normal;
        for (const cell of sampleCells(uvArea)) {
          const [a, b] = cellCentroid(cell);
          const s3 = at(p3[0], p3[1], p3[2], a, b);
          // Asked at the sample AND at its mirror image, hidden if either says so. Mirrored parts
          // and mirrored covers are exact (bbox delta 0.000mm on all four twin pairs; the snapped
          // wheel discs agree to 1e-13mm), so both points sit on real, identical surface — but the
          // question asked at them is not mirror-equivariant. Two things break it: the twins are
          // tessellated differently (37,820 against 29,822 triangles on the fenders), so the
          // sample grids land in different places; and hemisphereBlocked builds its ray frame from
          // `n` by a rule whose output is not the reflection of the reflected input. Either alone
          // flips a knife-edge sample, which is what left the flanks 5.3% apart with nothing
          // asymmetric in the geometry. `h(p) OR h(-p)` is symmetric by construction, so it is a
          // guarantee rather than a threshold tuned until the two sides happened to agree.
          const ring = cell.map(([s, t]) => at(q[0], q[1], q[2], s, t));
          // Declared dead beats the classifier either way: as covered it would be bled in from
          // the rim, as visible (a through-hole ray escaping) it would erode the disc.
          if (declared.length && declaredDead(s3, n, mine)) {
            declaredRings.push(ring);
            continue;
          }
          let v = classify(s3, n, mine, false);
          if (mirrorAxis >= 0 && v !== 3) {
            const flip = reflectAcross(mirrorAxis);
            v |= classify(flip(s3), flip(n), mine, true);
          }
          const hidden = (v & 1) !== 0;
          const claimed = (v & 2) !== 0;
          if (!hidden) visibleRings.push(ring);
          else if (claimed) coveredRings.push(ring);
        }
      });
      if (coveredRings.length) {
        const wasm = opts.wasm;
        // Smooth the classification, THEN bleed — not the other way round. Both sets are unions of
        // COVER_SAMPLE_MM2 cells, so both arrive with a staircase edge and a scatter of lone cells
        // that escaped their neighbours' verdict. Those are artifacts of how the surface was asked,
        // not shape, and dilating one by bleedMm turns it into a 2*bleedMm bite out of the dead
        // region: a hidden strip narrower than that disappears outright. Measured on the fenders,
        // which classify 0.4% apart on the two flanks (7,450 against 7,477mm²): bleeding first took
        // the whole of the left one's wheel shadow and left the right one's, and the difference in
        // the OUTPUT was 100%. Smoothing first is also what lets the offset be Round — the true
        // dilation by a disc — since Miter was only ever there to fight the staircase's corners.
        const covRaw = new wasm.CrossSection(coveredRings, 'NonZero');
        const visRaw = new wasm.CrossSection(visibleRings, 'NonZero');
        const covCS = smoothDead(covRaw);
        const visible = smoothDead(visRaw);
        const grown = visible.offset(config.covers.bleedMm, 'Round', 2, 16);
        deadCS = covCS.subtract(grown);
        // A Set: smoothDead hands back its own argument when DEAD_SMOOTH_MM is off, and Manifold's
        // wasm handles do not survive being deleted twice.
        for (const cs of new Set([covRaw, visRaw, covCS, visible, grown])) cs.delete();
      }
      if (declaredRings.length) {
        const wasm = opts.wasm;
        const decRaw = new wasm.CrossSection(declaredRings, 'NonZero');
        const decCS = smoothDead(decRaw);
        // A derived component is replaced by the declared disc exactly when everything it would
        // add BEYOND the disc is under the bleed-footprint threshold dropSmallRegions already
        // treats as signal-free — those are the post-bleed rags of the solid's own shadow, and
        // unioning them onto the disc would put the raggedness back on its edge. Any component
        // adding more than that carries another cover's real shadow (the caster channel, the
        // cushion on the seat sides) and is kept whole; the union dedups where it laps the disc.
        // No overlap-share vote: a straddling region near a 50% line would flip whole regions of
        // hatch on a re-tessellation.
        const kept = [];
        let replacedN = 0;
        let replacedArea = 0;
        if (deadCS) {
          for (const comp of deadCS.decompose()) {
            const rem = comp.subtract(decCS);
            const beyond = rem.area();
            rem.delete();
            if (beyond <= Math.PI * config.covers.bleedMm ** 2) {
              replacedN++;
              replacedArea += comp.area();
              comp.delete();
            } else {
              kept.push(comp);
            }
          }
          deadCS.delete();
        }
        log(
          `  zone "${zoneCfg.id}": declared shadow ${decCS.area().toFixed(0)}mm² absorbs ` +
            `${replacedN} derived fragment(s) (${replacedArea.toFixed(0)}mm²), ` +
            `${kept.length} region(s) kept`,
        );
        deadCS = wasm.CrossSection.union([decCS, ...kept]);
        for (const cs of [decCS, ...kept]) cs.delete();
        if (decRaw !== decCS) decRaw.delete();
      }
      if (deadCS) {
        // Whole components, not per-chart pieces: a region split across a printed seam is still one
        // patch to whoever reads the template, and dropping half of it would be the visible defect.
        // A component under the bleed's own footprint (a disc of bleedMm) is smaller than the margin
        // the bleed already reserves, so hatching it tells nobody anything; at DEAD_SMOOTH_MM every
        // chair zone has exactly one such straggler and nothing between it and the real patch.
        const dropped = dropSmallRegions(deadCS, Math.PI * config.covers.bleedMm ** 2, opts.wasm);
        if (dropped !== deadCS) {
          deadCS.delete();
          deadCS = dropped;
        }
      }
    }

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
      const chart = {
        libraryPartId: parts[pi].libraryPartId,
        tris,
        verts: cVerts,
        uv: cUV,
        chartTris,
        subRegions,
      };
      if (coverIdx) {
        chart.deadRegions = [];
        if (deadCS) {
          const chartCS = new opts.wasm.CrossSection(
            list.map((e) => triRing(e.zTri)),
            'NonZero',
          );
          const cut = deadCS.intersect(chartCS);
          const rings = cut.toPolygons().map((ring) => ring.map(([x, y]) => [x, y]));
          cut.delete();
          chartCS.delete();
          chart.deadRegions = classifyRegions(rings)
            .map((r) => ({
              outer: r.outer,
              holes: r.holes.filter((h) => Math.abs(loopArea(h)) >= minHoleArea),
            }))
            // Net area, the same measure the bake log, dropSmallRegions and the tests use. On the
            // outer loop alone a ring of hidden surface reads as solid, so a region hiding almost
            // nothing survives a threshold meant to drop it. Holes are filtered first, because a
            // hole under minHoleArea is not subtracted from what ships either. Nothing in the
            // current sidecar moves: all 12 of its dead regions have no holes at all.
            .filter((r) => regionNetArea(r) >= MIN_DEAD_AREA_MM2)
            .map((r) => ({
              outer: roundLoop(simplifyLoop(r.outer, simplifyTol)),
              holes: r.holes.map((h) => roundLoop(simplifyLoop(h, simplifyTol))),
            }));
        }
      }
      charts.push(chart);
    }
    if (deadCS) deadCS.delete();

    // Seams: where one printed part's share of the zone ends against another's.
    //
    // Taken from the parts' own patch boundaries, NOT from edges shared by two parts' triangles.
    // Real printed parts meet across a clearance with mismatched tessellation, so stitchSeams welds
    // their *vertices* while the two edge chains almost never coincide — demanding a shared edge
    // drew 0.93mm of line across the seat's five pieces and 19mm on the back's six. An edge counts
    // as a seam when it bounds this part's patch (no second triangle of the same part behind it)
    // and both endpoints are welded to a common other part. Drawn from the lower-numbered part of
    // each pair only, so a join gets one line rather than two nearly-coincident ones.
    const zoneSet = new Set(zoneTris);
    const partsAtVert = new Map();
    for (const ti of zoneTris) {
      const t = weld.tris[ti];
      for (const g of t.v) {
        let s = partsAtVert.get(g);
        if (!s) partsAtVert.set(g, (s = new Set()));
        s.add(t.part);
      }
    }
    const seamEdges = [];
    const seen = new Set();
    for (const ti of zoneTris) {
      const t = weld.tris[ti];
      for (let k = 0; k < 3; k++) {
        const a = t.v[k];
        const b = t.v[(k + 1) % 3];
        // keyed per part: a genuinely shared edge must be judged once from each side, or the
        // lower-part rule below could drop it on behalf of a part that never gets to emit it
        const key = `${t.part}:${edgeKey(a, b)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const mine = edgeTris
          .get(edgeKey(a, b))
          .filter((o) => zoneSet.has(o) && weld.tris[o].part === t.part);
        if (mine.length > 1) continue;
        const atA = partsAtVert.get(a);
        const atB = partsAtVert.get(b);
        let lowest = Infinity;
        for (const p of atA) if (p !== t.part && atB.has(p) && p < lowest) lowest = p;
        if (lowest === Infinity || t.part > lowest) continue;
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
    // The relation is known from the seeds; the residual against the twin's finished chart is
    // merged in after the loop.
    const rel = zoneMirror?.mirror.get(zone.id);
    if (rel) zone.mirror = { ...rel };
    zones.push(zone);
    templates.push({
      file: zone.templateFile,
      svg: zoneTemplateSVG(zone, config.kindId, { maxU, maxV }),
    });
    const deadArea = coverIdx
      ? charts.reduce(
          (s, c) => s + (c.deadRegions ?? []).reduce((t, r) => t + regionNetArea(r), 0),
          0,
        )
      : 0;
    log(
      `zone "${zone.id}": ${zoneTris.length} tris across ${charts.length} part(s), ` +
        `${zoneRegions.length} lobe(s), ${zone.holes.length} hole(s), ${seams.length} seam(s), ` +
        `stretch max ${zone.distortion.max} mean ${zone.distortion.mean}, ` +
        `scale ${stats.scale.toFixed(5)}` +
        (coverIdx ? `, dead ${deadArea.toFixed(0)}mm²` : ''),
    );
  }

  if (zoneMirror) {
    const vertsOf = (id) => parts.find((p) => p.libraryPartId === id).verts;
    for (const zone of zones) {
      const rel = zone.mirror;
      if (!rel) continue;
      const other = rel.self ? zone : zones.find((z) => z.id === rel.twin);
      const m = measureZoneMirror(zone, other, mirrorAxis, vertsOf);
      rel.residualMm = {
        pairs: m.pairs,
        rms: round(m.rms, 3),
        p95: round(m.p95, 3),
        max: round(m.max, 3),
      };
      log(
        `zone "${zone.id}" mirrors ${rel.self ? 'itself' : `"${rel.twin}"`}: ${m.pairs} of ` +
          `${m.of} vertices paired, residual rms ${m.rms.toFixed(3)} p95 ${m.p95.toFixed(3)} ` +
          `max ${m.max.toFixed(3)}mm` +
          (rel.self
            ? ''
            : `, bbox gap ${Math.abs(zone.uvBounds.maxU - other.uvBounds.maxU).toFixed(3)} x ` +
              `${Math.abs(zone.uvBounds.maxV - other.uvBounds.maxV).toFixed(3)}mm`),
      );
      // The same slack the runtime already grants a chart against its own triangulation: a
      // reflection landing further off than that would put mirrored artwork visibly off its twin.
      if (m.p95 > CHART_SNAP_MM)
        warnings.push(
          `zone "${zone.id}": mirror residual p95 ${m.p95.toFixed(3)}mm exceeds ` +
            `${CHART_SNAP_MM}mm — a mirrored design will not land where its twin's reflection is`,
        );
    }
  }

  const meshes = {};
  config.parts.forEach((p, pi) => {
    meshes[p.libraryPartId] = meshFingerprint(parts[pi]);
  });
  // Sidecar schema 4 (zones may carry `mirror`, charts `deadRegions`); independent of the zone
  // *config* schema checked in validateConfig, which is still 1. Must match SIDECAR_SCHEMA in
  // src/geometry/zoneCharts.ts.
  return { sidecar: { schema: 4, kindId: config.kindId, meshes, zones }, templates, warnings };
}
