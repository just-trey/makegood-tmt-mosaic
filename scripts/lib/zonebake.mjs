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
 * Reads every mesh object out of a multi-body 3MF along with its material color, resolved
 * through pid -> m:colorgroup -> m:color. The covers file (a whole-assembly CAD export) tells
 * its bodies apart only by color: every body is named the same and carries no part id.
 */
export async function read3MFObjectsByColor(buf) {
  const zip = await JSZip.loadAsync(buf);
  const model = zip.file('3D/3dmodel.model');
  if (!model) throw new Error('not a valid 3MF: missing 3D/3dmodel.model');
  const xml = await model.async('string');
  const XA = [/\bx="([^"]*)"/, /\by="([^"]*)"/, /\bz="([^"]*)"/];
  const TA = [/\bv1="([^"]*)"/, /\bv2="([^"]*)"/, /\bv3="([^"]*)"/];
  const attrs = (tag, res) => res.map((r) => +(tag.match(r)?.[1] ?? NaN));
  const colorOf = new Map();
  for (const m of xml.matchAll(/<m:colorgroup id="(\d+)">\s*<m:color color="(#[0-9A-Fa-f]+)"/g))
    colorOf.set(m[1], m[2].toUpperCase());
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
  for (const om of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const pid = om[1].match(/\bpid="(\d+)"/)?.[1];
    const verts = [];
    const tris = [];
    for (const v of om[2].matchAll(/<vertex\b[^>]*>/g)) verts.push(attrs(v[0], XA));
    for (const t of om[2].matchAll(/<triangle\b[^>]*>/g)) tris.push(attrs(t[0], TA));
    if (tris.length) objects.push({ color: colorOf.get(pid ?? '') ?? null, verts, tris });
  }
  return objects;
}

const REGISTER_DIM_TOL_MM = 1.5;
const REGISTER_RESIDUAL_MM = 1;

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
  const bboxOf = (verts) => {
    const mn = [Infinity, Infinity, Infinity];
    const mx = [-Infinity, -Infinity, -Infinity];
    for (const v of verts)
      for (let k = 0; k < 3; k++) {
        if (v[k] < mn[k]) mn[k] = v[k];
        if (v[k] > mx[k]) mx[k] = v[k];
      }
    return { mn, mx, dims: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]] };
  };
  const partBB = parts.map((p) => bboxOf(p.verts));
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
  let best = null;
  for (const R of rotations) {
    const refBB = refs.map((r) => bboxOf(r.verts.map((v) => apply(R, v))));
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
  const covers = coverObjs.map((c) => ({ verts: c.verts.map(xform), tris: c.tris }));
  const mirror = config.covers.mirrorAxis
    ? symmetrizeCovers(covers, 'xyz'.indexOf(config.covers.mirrorAxis))
    : null;
  return { covers, matched: best.matched, residual: best.residual, mirror };
}

/** Axis-aligned bounds and their midpoint. Midpoint, not centroid: these meshes are unevenly */
/** tessellated, so a centroid drifts with triangle density (the seat cushion's is 1.1mm off a */
/** bbox that is centred to 0.000mm). */
function boundsMid(verts) {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (const v of verts)
    for (let k = 0; k < 3; k++) {
      if (v[k] < mn[k]) mn[k] = v[k];
      if (v[k] > mx[k]) mx[k] = v[k];
    }
  return { mn, mx, mid: [0, 1, 2].map((k) => (mn[k] + mx[k]) / 2) };
}

/**
 * Makes mirror-paired cover bodies exactly mirror-symmetric about `axis` = 0, IN PLACE.
 *
 * A CAD export lands its instances where the assembly put them, not where symmetry would: the
 * chair's four casters pair up 1.187mm off their own mirror image and 0.315 degrees rotated. That
 * is far under any tolerance the bake cares about on its own, and it still decides a knife-edge —
 * the flanks classify within 3.8% of each other and the surviving dead region did not, because a
 * sample sitting at 27 or 28 blocked directions of 32 goes whichever way the sub-millimetre pose
 * pushes it. Snapping the poses removes the tie-breaker instead of tuning the threshold that
 * exposes it.
 *
 * Each pair is rebuilt from ONE of its two meshes, mirrored for the other side, so the result is
 * symmetric exactly rather than to some residual. The source is the body on the negative side of
 * the axis: a geometric rule, so it does not depend on the order objects happen to appear in the
 * file. Both sides move to the averaged offset, so neither side's pose is adopted wholesale.
 * Unpaired bodies (the chair's two cushions, which straddle the plane themselves) are left alone.
 */
export function symmetrizeCovers(covers, axis) {
  if (axis < 0) throw new Error('covers.mirrorAxis must be "x", "y" or "z"');
  const flip = (v) => v.map((x, k) => (k === axis ? -x : x));
  const info = covers.map((c, i) => ({ i, c, b: boundsMid(c.verts) }));
  const used = new Set();
  const moved = [];
  for (const a of info) {
    if (used.has(a.i)) continue;
    const partner = info
      .filter((o) => o.i !== a.i && !used.has(o.i) && o.c.tris.length === a.c.tris.length)
      .map((o) => ({ o, d: dist3(a.b.mid, flip(o.b.mid)) }))
      .sort((x, y) => x.d - y.d)[0];
    // A pair has to be nearer its own mirror image than the sampling resolution, or it is two
    // different bodies that merely happen to share a triangle count.
    if (!partner || partner.d > MIRROR_PAIR_TOL_MM) continue;
    used.add(a.i);
    used.add(partner.o.i);
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
    src.c.verts = srcVerts;
    dst.c.verts = srcVerts.map(flip);
    dst.c.tris = src.c.tris.map((t) => [t[0], t[2], t[1]]);
    moved.push(dist3(src.b.mid, target), dist3(dst.b.mid, flip(target)));
  }
  return { pairs: moved.length / 2, maxShiftMm: moved.length ? Math.max(...moved) : 0 };
}

const MIRROR_PAIR_TOL_MM = 5;
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

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
 */
const COVER_HIDDEN_FRACTION = 0.85;
/**
 * Target area (mm²) of one classification sample. The chair's CAD faces arrive as coarse fans —
 * ten triangles carry 68% of the left wheel mount's 37,443mm², the largest 8,430mm² — so a
 * per-triangle verdict cannot draw a shadow edge at all. Converged: 100 down to 3mm² moves every
 * zone under 1.5%, while a per-triangle verdict is 7% high on the flanks and 7% high on `front`.
 * 25mm² is a ~5mm boundary resolution against the 20mm bleed, at 67k samples for the whole chair.
 */
const COVER_SAMPLE_MM2 = 25;
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
 * The classifier is piecewise-constant on COVER_SAMPLE_MM2 patches, so its boundary is a staircase
 * about one patch tall (a 25mm² triangle is 6.6mm on the long side), and the bleed's miter joins
 * turn every step of it into a spike. The closing fills the notches, the opening takes the spikes
 * and slivers off; both are Round, so the structuring element is a real disc.
 *
 * 5mm is where the zone-level component histogram separates (2026-08-30 sweep). Raw, each zone is a
 * continuum — the left flank runs 12,348 / 708 / 668 / 666 / 277 / 256 / 142 / … mm². At 5mm every
 * zone is one large patch and exactly one straggler, with nothing between: left 12,620 + 316, right
 * 13,886 + 460, front 13,489 + 334, seat 20,792 + 313. Smaller does not separate them; larger only
 * costs area, and does not buy symmetry — at 7 and 9mm the left flank still ends with nothing on
 * its fender chart while the right keeps ~600mm².
 *
 * It is also what clears the slivers the owner marked on the Front sheet: 138 / 154 / 912 /
 * 1,068mm² in the four marked boxes before any of this work, and 0 / 0 / 1 / 9 after.
 */
const DEAD_SMOOTH_MM = 5;

const CELL_MM = 8;

// Cell hash. Collisions merge two cells' triangle lists, which only ever adds candidates a ray
// then rejects exactly — a hit can't be lost, so the hash needs no perfectness.
const cellKey = (i, j, k) => (i * 73856093) ^ (j * 19349663) ^ (k * 83492791);

/**
 * Every cover body's triangles in ONE 8mm cell grid, flattened to a Float64Array. One grid rather
 * than one per body because the question is only ever "does any cover block this ray", so a single
 * walk answers it; `seen` stamps a triangle per ray, since a triangle sits in every cell its bbox
 * spans. Measured 67x faster than the per-body sampled march it replaces, over 16,031 chair zone
 * triangles, with zero verdicts changed.
 */
function coverIndex(covers) {
  const pts = [];
  for (const c of covers)
    for (const t of c.tris) pts.push(c.verts[t[0]], c.verts[t[1]], c.verts[t[2]]);
  const count = pts.length / 3;
  const xyz = new Float64Array(pts.length * 3);
  pts.forEach((v, i) => xyz.set(v, i * 3));
  const cells = new Map();
  for (let t = 0; t < count; t++) {
    const o = t * 9;
    for (
      let i = Math.floor(Math.min(xyz[o], xyz[o + 3], xyz[o + 6]) / CELL_MM);
      i <= Math.floor(Math.max(xyz[o], xyz[o + 3], xyz[o + 6]) / CELL_MM);
      i++
    )
      for (
        let j = Math.floor(Math.min(xyz[o + 1], xyz[o + 4], xyz[o + 7]) / CELL_MM);
        j <= Math.floor(Math.max(xyz[o + 1], xyz[o + 4], xyz[o + 7]) / CELL_MM);
        j++
      )
        for (
          let k = Math.floor(Math.min(xyz[o + 2], xyz[o + 5], xyz[o + 8]) / CELL_MM);
          k <= Math.floor(Math.max(xyz[o + 2], xyz[o + 5], xyz[o + 8]) / CELL_MM);
          k++
        ) {
          const key = cellKey(i, j, k);
          let cell = cells.get(key);
          if (!cell) cells.set(key, (cell = []));
          cell.push(t);
        }
  }
  return { xyz, cells, seen: new Int32Array(count).fill(-1), ray: 0 };
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
 * Whether any cover blocks the ray from `p` along `dir` within `maxMm`, by walking the grid cell
 * by cell (3D DDA). Each cell is entered once, so no de-duplication beyond the per-ray triangle
 * stamp is needed.
 */
function coverOccludes(index, p, dir, maxMm = COVER_RAY_MM) {
  index.ray++;
  const { xyz, cells, seen } = index;
  let ix = Math.floor(p[0] / CELL_MM),
    iy = Math.floor(p[1] / CELL_MM),
    iz = Math.floor(p[2] / CELL_MM);
  const sx = dir[0] > 0 ? 1 : -1,
    sy = dir[1] > 0 ? 1 : -1,
    sz = dir[2] > 0 ? 1 : -1;
  const bound = (i, s, k) => (s > 0 ? (i + 1) * CELL_MM : i * CELL_MM) - p[k];
  let tx = dir[0] !== 0 ? bound(ix, sx, 0) / dir[0] : Infinity;
  let ty = dir[1] !== 0 ? bound(iy, sy, 1) / dir[1] : Infinity;
  let tz = dir[2] !== 0 ? bound(iz, sz, 2) / dir[2] : Infinity;
  const dx = dir[0] !== 0 ? Math.abs(CELL_MM / dir[0]) : Infinity;
  const dy = dir[1] !== 0 ? Math.abs(CELL_MM / dir[1]) : Infinity;
  const dz = dir[2] !== 0 ? Math.abs(CELL_MM / dir[2]) : Infinity;
  for (let entry = 0; entry <= maxMm;) {
    const cell = cells.get(cellKey(ix, iy, iz));
    if (cell)
      for (let a = 0; a < cell.length; a++) {
        const t = cell[a];
        if (seen[t] === index.ray) continue;
        seen[t] = index.ray;
        if (rayTriDist(xyz, t, p[0], p[1], p[2], dir[0], dir[1], dir[2]) <= maxMm) return true;
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
  return false;
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
 */
function hemisphereBlocked(index, p, n) {
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
    if (!coverOccludes(index, p, w) && ++escaped > HEMI_ESCAPE_BUDGET) return false;
  }
  return true;
}

/**
 * Barycentric sub-triangles of one triangle, `k` to a side. Cached: the same handful of `k` values
 * covers a whole bake, and rebuilding the 24x24 case per triangle would cost more than the rays.
 */
const SUB_CELLS = new Map();
/** 24 to a side is 576 samples, which the chair's largest triangle (8,430mm²) already sits under. */
const SUB_CELLS_MAX = 24;
function subCells(k) {
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
 * Closing FIRST, which is the order that matters. The bleed erodes 20mm in from every visible
 * sample, which pinches a shadow that is physically one piece into lobes joined by necks a few
 * millimetres wide. Opening first severs those necks, and whether a given neck survives is a
 * coin-flip on where the sample cells happened to land: with the covers snapped to the mirror
 * plane the two flanks classify within 0.4% of each other (7,450 against 7,477mm² of covered wing
 * surface) and open-then-close still split them 12,814 against 14,007mm², because the left flank's
 * neck onto its fender was severed and the right flank's was not. Closing first restores the necks
 * the bleed pinched before anything can cut them, and the same two zones come out 15,032 against
 * 15,291mm², 1.7% apart.
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
  const keep = regions.filter(
    (r) =>
      Math.abs(loopArea(r.outer)) - r.holes.reduce((s, h) => s + Math.abs(loopArea(h)), 0) >=
      minAreaMm2,
  );
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
  const seams = (zone.seams || [])
    .map(
      (line) =>
        `  <polyline points="${line.map((p) => pt(p).join(',')).join(' ')}" fill="none" ` +
        `stroke="${ACCENT}" stroke-width="0.6" stroke-dasharray="2 3"/>`,
    )
    .join('\n');
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
    zone.seams?.length ? 'dashed = printed-part seam' : '',
    partLabels ? 'labels name the printed part' : '',
    deadD ? 'hatched = hidden once assembled' : '',
  ]
    .filter(Boolean)
    .join('; ');
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
  const coverIdx = config.covers ? coverIndex(opts.covers) : null;
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
      .filter((pts) => pts.length >= 3);
    if (!loops.length) throw new Error(`zone "${zoneCfg.id}": no boundary loop found`);
    // A zone is one connected island of triangles, but its UV footprint need not be one disk: where
    // two lobes meet at a pinch vertex, splitAtRepeats hands back a separate simple loop for each.
    // Classify by containment rather than assuming "largest loop is the outline, rest are holes" —
    // on the chair's left flank that assumption made the second-largest LOBE a hole of the first,
    // leaving `boundary` enclosing 22,944mm² of a 124,500mm² zone with 17 of its 18 "holes" lying
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
    // regions do sum to the whole zone (left: 124,797mm² across its 4 parts, against a 22,944mm²
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
    const triRing = (zt) => zt.map((z) => uvOf(z));
    let deadCS = null;
    if (coverIdx) {
      const coveredRings = [];
      const visibleRings = [];
      zoneTris.forEach((ti, k) => {
        const p3 = weld.tris[ti].v.map((g) => weld.verts[g]);
        const q = triRing(zTris[k]);
        const uvArea =
          Math.abs(
            (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (q[1][1] - q[0][1]),
          ) / 2;
        const n = triGeom[ti].normal;
        for (const cell of subCells(
          Math.max(1, Math.min(SUB_CELLS_MAX, Math.ceil(Math.sqrt(uvArea / COVER_SAMPLE_MM2)))),
        )) {
          const a = (cell[0][0] + cell[1][0] + cell[2][0]) / 3;
          const b = (cell[0][1] + cell[1][1] + cell[2][1]) / 3;
          const at = (v0, v1, v2, s, t) => v0.map((x, i) => x + (v1[i] - x) * s + (v2[i] - x) * t);
          const s3 = at(p3[0], p3[1], p3[2], a, b);
          // Contact first: it is one ray against the hemisphere's 32, and it is the cheap answer
          // for everything the cushions actually touch.
          const hidden =
            coverOccludes(coverIdx, s3, n, COVER_CONTACT_MM) || hemisphereBlocked(coverIdx, s3, n);
          (hidden ? coveredRings : visibleRings).push(
            cell.map(([s, t]) => at(q[0], q[1], q[2], s, t)),
          );
        }
      });
      if (coveredRings.length) {
        const wasm = opts.wasm;
        const covCS = new wasm.CrossSection(coveredRings, 'NonZero');
        const visible = new wasm.CrossSection(visibleRings, 'NonZero');
        // Miter, though Round is the truer dilation-by-a-disc: a miter join over-reaches past a
        // convex corner, and on the staircase boundary the samples leave that is every corner.
        // Tried Round and measured it worse where it counts — the marked slivers in the front
        // sheet's top corners went from 27mm² back to 146mm², past even the 138mm² they had
        // before this change, in exchange for tidier spikes around the seat's two through-holes.
        const grown = visible.offset(config.covers.bleedMm, 'Miter', 2, 16);
        const rough = covCS.subtract(grown);
        deadCS = smoothDead(rough);
        rough.delete();
        for (const cs of [covCS, visible, grown]) cs.delete();
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
            .filter((r) => Math.abs(loopArea(r.outer)) >= MIN_DEAD_AREA_MM2)
            .map((r) => ({
              outer: roundLoop(simplifyLoop(r.outer, simplifyTol)),
              holes: r.holes
                .filter((h) => Math.abs(loopArea(h)) >= minHoleArea)
                .map((h) => roundLoop(simplifyLoop(h, simplifyTol))),
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
    zones.push(zone);
    templates.push({
      file: zone.templateFile,
      svg: zoneTemplateSVG(zone, config.kindId, { maxU, maxV }),
    });
    const deadArea = coverIdx
      ? charts.reduce(
          (s, c) =>
            s +
            (c.deadRegions ?? []).reduce(
              (t, r) =>
                t +
                Math.abs(loopArea(r.outer)) -
                r.holes.reduce((h, l) => h + Math.abs(loopArea(l)), 0),
              0,
            ),
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

  const meshes = {};
  config.parts.forEach((p, pi) => {
    meshes[p.libraryPartId] = meshFingerprint(parts[pi]);
  });
  // Sidecar schema 3 (charts may carry `deadRegions` beside `subRegions`); independent of the
  // zone *config* schema checked in validateConfig, which is still 1. Must match SIDECAR_SCHEMA
  // in src/geometry/zoneCharts.ts.
  return { sidecar: { schema: 3, kindId: config.kindId, meshes, zones }, templates, warnings };
}
