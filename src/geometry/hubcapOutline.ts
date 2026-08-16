import type { SVGShape } from '../types';
import type { ManifoldAPI } from './manifold';

/**
 * A closed 2D outline for the hubcap's disc: what lets the part be the shape of a logo or
 * character instead of a circle.
 *
 * Points are (x, z). The part's native frame is Y-up, so an outline lives in the ground plane and
 * Y is thickness.
 *
 * Deliberately no geometry builder here. A silhouette disc is cut FLAT, square edges and no
 * chamfer, making it a plain 3mm prism on the outline, which `extrudeRegionToSoup`
 * (src/geometry/manifold.ts) already builds from a turf feature in this frame. An earlier version
 * lofted a chamfer between the outline and a 1mm erosion of it; it worked but needed the boolean's
 * band, nested-ring resolution and per-vertex height tagging. All of it went when the edge became
 * square. What is left is the measurement the *checks* need, which no existing module answers.
 */
export interface OutlinePt {
  x: number;
  z: number;
}
export type OutlineRing = OutlinePt[];

/** Rings of one outline: outer boundary(ies) and holes together, in mm, centred on the axis. */
export type Outline = OutlineRing[];

/**
 * Where the artwork lands on the part, in the terms the cut already uses.
 *
 * Deliberately the *same* numbers `DesignPlacement` (src/geometry/zones.ts) carries, and
 * `placeArtworkPoint` below is deliberately the same arithmetic as that module's `placer`. The
 * feature rests on the part and the picture being one object, which only one shared transform can
 * guarantee, never two that are meant to agree.
 *
 * They did not agree before. The outline was fitted by its own traced *content* bbox while the
 * artwork was scaled off the document *canvas*, so a padded PNG (a 300x450 subject on a 512x512
 * sheet) printed the picture about 12% smaller than the shape cut for it, and offset. An SVG
 * declaring a physical size skipped the fit entirely and disagreed by whatever that size was.
 */
export interface OutlinePlacement {
  /** SVG-space anchor the design centres on: `designAnchor`'s cx/cy. */
  cx: number;
  cy: number;
  /** SVG user units to mm, from `designMmPerUnit`. */
  mmPerUnit: number;
  /** ±1 on X, already folded with the +Y-face mirror; see `placer`'s `xMul`. */
  xMul: number;
  /** ±1 on Z: -1 for SVG's y-down, +1 when the user flips vertically. */
  zMul: number;
  rotationDeg: number;
  /** millimetre nudge, applied after scale and rotation exactly as the cut applies it */
  offX: number;
  offZ: number;
}

/** One artwork point (SVG space) to the part's own (x, z) millimetres. */
export function placeArtworkPoint(x: number, y: number, pl: OutlinePlacement): OutlinePt {
  let px = (x - pl.cx) * pl.mmPerUnit * pl.xMul;
  let pz = (y - pl.cy) * pl.mmPerUnit * pl.zMul;
  if (pl.rotationDeg) {
    const r = (pl.rotationDeg * Math.PI) / 180;
    const c = Math.cos(r),
      s = Math.sin(r);
    const nx = px * c - pz * s;
    pz = px * s + pz * c;
    px = nx;
  }
  return { x: px + pl.offX, z: pz + pl.offZ };
}

/** Furthest any part of the outline reaches from the mounting axis at (0, 0). */
export function outlineReach(rings: Outline): number {
  let far = 0;
  for (const r of rings)
    for (const p of r) {
      const d = Math.hypot(p.x, p.z);
      if (d > far) far = d;
    }
  return far;
}

/**
 * Scale an outline by `k` about a fixed point.
 *
 * The caller shrinks about the mounting axis, where the outline is already centred, which keeps
 * this equivalent to having built it with `mmPerUnit * k`: placement scales before the translation
 * that centred it, so the centre is the one point that doesn't move when mmPerUnit changes. That
 * equivalence is why the same `k` can go to the artwork and still match the shape.
 *
 * A bisecting `fitFactorForRadius` used to live here, needed because a user-set offset made the
 * reach `|off + k(p - off)|`, convex in k rather than a division. It went when the offset became
 * derived rather than chosen (see hubcapShapeFromState): about the axis every point's distance
 * scales by exactly k, so the caller's cap is one ratio.
 */
export function scaleOutlineAbout(rings: Outline, ox: number, oz: number, k: number): Outline {
  return rings.map((r) => r.map((p) => ({ x: ox + (p.x - ox) * k, z: oz + (p.z - oz) * k })));
}

/** Signed area of one ring. Summed over an outline's rings, holes cancel against their boundary. */
export function ringArea(r: OutlineRing): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j].x * r[i].z - r[i].x * r[j].z;
  return a / 2;
}

/**
 * Enclosed area of an outline, holes subtracted.
 *
 * Nesting is decided by containment, not winding: a ring inside an odd number of others is a hole
 * and comes off, whatever direction it runs. The rings come from the tracer and Manifold's 2D
 * engine, neither of which promises a hole runs opposite its boundary, the same reason
 * `shapeToFeature` resolves SVG fill rules by depth. Summing signed areas instead reads a donut as
 * its outer disc PLUS its hole.
 */
export function outlineArea(rings: Outline): number {
  const usable = rings.filter((r) => r.length >= 3);
  let total = 0;
  for (const r of usable) {
    // a vertex can lie exactly on another ring, so probe an edge midpoint instead
    const mid = { x: (r[0].x + r[1].x) / 2, z: (r[0].z + r[1].z) / 2 };
    let depth = 0;
    for (const other of usable) if (other !== r && outlineContains([other], mid.x, mid.z)) depth++;
    total += (depth % 2 === 0 ? 1 : -1) * Math.abs(ringArea(r));
  }
  return Math.max(0, total);
}

/** Bounding box of an outline, as [minX, minZ, maxX, maxZ]. */
export function outlineBounds(rings: Outline): [number, number, number, number] {
  let minX = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxZ = -Infinity;
  for (const r of rings)
    for (const p of r) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
  return [minX, minZ, maxX, maxZ];
}

/**
 * Whether a point is inside the outline, by even-odd crossing: a point in a hole is outside.
 * Even-odd rather than winding, because the rings come from the tracer and the boolean engine,
 * neither of which promises consistent orientation between a boundary and its holes.
 */
export function outlineContains(rings: Outline, x: number, z: number): boolean {
  let inside = false;
  for (const r of rings)
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const zi = r[i].z,
        zj = r[j].z;
      if (zi > z !== zj > z && x < ((r[j].x - r[i].x) * (z - zi)) / (zj - zi) + r[i].x)
        inside = !inside;
    }
  return inside;
}

/**
 * How much of the clips' bonding face lands on material, as a fraction of its area.
 *
 * The clips present an annulus (their top faces, see HUBCAP_CLIP_FACE_*_R_MM), and what decides
 * whether they hold is how much of it is backed by disc. Sampled on a polar grid rather than
 * tested analytically: the outline is a traced polygon with holes, and the question is "how much",
 * not "does any edge cross".
 *
 * Measures area rather than probing the outer rim, which this did first and got wrong in the
 * direction that matters: a single 1-in-64 nick at the extreme radius refused a real silhouette
 * whose clips were otherwise fully supported. What must be caught is a clip over a HOLE or off the
 * shape, a large loss, not a shape grazing the rim.
 */
export function clipCoverage(rings: Outline, innerR: number, outerR: number): number {
  const RINGS = 12;
  const STEPS = 96;
  let on = 0;
  let total = 0;
  for (let i = 0; i < RINGS; i++) {
    // area-weighted: an outer ring covers more of the annulus than an inner one
    const r = innerR + ((i + 0.5) / RINGS) * (outerR - innerR);
    for (let j = 0; j < STEPS; j++) {
      const t = (j / STEPS) * Math.PI * 2;
      total += r;
      if (outlineContains(rings, r * Math.cos(t), r * Math.sin(t))) on += r;
    }
  }
  return total > 0 ? on / total : 0;
}

/**
 * How much of the outline sits in features narrower than `widthMm`, in mm².
 *
 * A morphological *opening*: erode by half the width, dilate back by the same. Anything wider is
 * restored exactly; anything narrower has no material left at its centreline to grow back from and
 * stays gone. The area that fails to return is the area in too-narrow features.
 *
 * Erosion alone is not enough, and the mistake is easy: it only catches a feature that pinches the
 * shape into more pieces. A tapered limb just gets shorter with the ring count unchanged, and a
 * silhouette scaled to 60mm reported nothing under 3mm while being 33mm wide overall. The
 * dilate-back turns "did the topology change" into "how much of this is too thin".
 *
 * About PRINTABILITY, not wrong geometry: a 0.5mm spike still extrudes into a valid solid, it is
 * just one nozzle-width of plastic standing 3mm tall. Hence a notice, not a refusal.
 */
export function narrowFeatureArea(wasm: ManifoldAPI, rings: Outline, widthMm: number): number {
  const cs = new wasm.CrossSection(
    rings.map((r) => r.map((p) => [p.x, p.z] as [number, number])),
    'EvenOdd',
  );
  try {
    const before = cs.area();
    const eroded = cs.offset(-widthMm / 2, 'Miter', 2, 16);
    try {
      if (eroded.isEmpty()) return before; // nothing at all is as wide as the threshold
      const opened = eroded.offset(widthMm / 2, 'Miter', 2, 16);
      try {
        return Math.max(0, before - opened.area());
      } finally {
        opened.delete();
      }
    } finally {
      eroded.delete();
    }
  } finally {
    cs.delete();
  }
}

/**
 * The silhouette of loaded artwork: every shape merged into one outline.
 *
 * What makes the hubcap the shape of the picture on it. Artwork and part are the same object, so
 * the outline is read off the artwork already loaded rather than uploaded a second time and kept
 * in sync with it.
 *
 * Shape by shape then unioned, never every loop at once: a shape's own loops are outer-and-holes
 * and only read correctly under even-odd, while two *different* overlapping shapes must merge
 * rather than cancel. One even-odd pass over the lot punches a hole wherever two colours overlap,
 * which in artwork drawn as stacked layers is most of it.
 *
 * Points arrive in the part's frame via `placeArtworkPoint`, with scale, mirrors, rotation and
 * offset applied from the same numbers the cut uses. Both axes normally negate. Y flips because
 * artwork space is y-down (SVG's convention and the raster decoder's) and the ground plane is not.
 * X flips because the design face points +Y and is *seen from above*, and a surface's own frame
 * reads mirrored from the side you look at it. Either one wrong produces a shape that looks
 * plausible alone and is only wrong beside the picture printed on it; both were caught one at a
 * time from screenshots, as "upside down" and then "mirrored".
 */
export function silhouetteFromShapes(
  wasm: ManifoldAPI,
  shapes: SVGShape[],
  pl: OutlinePlacement,
): Outline {
  const regions = shapes
    .map((s) => s.loops.filter((l) => l.length >= 3))
    .filter((loops) => loops.length)
    .map(
      (loops) =>
        new wasm.CrossSection(
          loops.map((l) =>
            l.map((p) => {
              const q = placeArtworkPoint(p.x, p.y, pl);
              return [q.x, q.z] as [number, number];
            }),
          ),
          'EvenOdd',
        ),
    );
  if (!regions.length) return [];
  try {
    let merged = regions[0];
    const intermediates: (typeof merged)[] = [];
    for (let i = 1; i < regions.length; i++) {
      merged = merged.add(regions[i]);
      intermediates.push(merged);
    }
    const rings = merged.toPolygons().map((r) => r.map(([x, z]) => ({ x, z })));
    intermediates.forEach((m) => m.delete());
    return rings;
  } finally {
    regions.forEach((r) => r.delete());
  }
}
