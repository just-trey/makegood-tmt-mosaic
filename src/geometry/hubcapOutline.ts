import type { SVGShape } from '../types';
import type { ManifoldAPI } from './manifold';

/**
 * A closed 2D outline for the hubcap's disc — what lets the part be the shape of a logo or a
 * character instead of a circle.
 *
 * Points are (x, z): the part's native frame is Y-up, so an outline lives in the ground plane and
 * Y is thickness.
 *
 * There is deliberately no geometry builder here. A silhouette disc is cut FLAT — square edges,
 * no chamfer — which makes it a plain 3mm prism on the outline, and `extrudeRegionToSoup`
 * (src/geometry/manifold.ts) already builds exactly that from a turf feature in this same frame.
 * An earlier version of this file lofted a chamfer between the outline and a 1mm erosion of it,
 * which worked but needed the boolean's band, nested-ring resolution and per-vertex height
 * tagging to get right; all of it went when the edge became square. What is left is the
 * measurement the *checks* need, which no existing module answers.
 */
export interface OutlinePt {
  x: number;
  z: number;
}
export type OutlineRing = OutlinePt[];

/** Rings of one outline: outer boundary(ies) and holes together, in mm, centred on the axis. */
export type Outline = OutlineRing[];

/**
 * Scale an outline so its longest side measures `sizeMm`, and centre it on the axis.
 *
 * Longest side rather than width or area: it is the number the user set and the one they can
 * predict from looking at the picture. A tall character asked for at 220mm comes out 220mm tall
 * and narrower than that — which also keeps it inside the wheel, since the wheel is round and
 * 280mm across, so any outline whose longest side clears that clears it in every direction.
 */
export function fitOutline(rings: Outline, sizeMm: number): Outline {
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
  const span = Math.max(maxX - minX, maxZ - minZ);
  if (!(span > 0)) return rings;
  const s = sizeMm / span;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  return rings.map((r) => r.map((p) => ({ x: (p.x - cx) * s, z: (p.z - cz) * s })));
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
 * Nesting is decided by containment, not by winding: a ring inside an odd number of others is a
 * hole and comes off, whatever direction it happens to run. The rings here come from the tracer
 * and from Manifold's 2D engine, neither of which promises a hole runs opposite to its boundary —
 * which is the same reason `shapeToFeature` resolves the SVG fill rules by depth rather than by
 * orientation. Summing signed areas instead reads a donut as its outer disc PLUS its hole.
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
 * Whether a point is inside the outline, by even-odd crossing — a point in a hole is outside.
 *
 * Even-odd rather than winding because the rings come from the tracer and the boolean engine,
 * neither of which promises a consistent orientation between a boundary and its holes.
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
 * Whether the outline fully covers a disc of `radiusMm` centred on the axis — which is the
 * question "will the mounting clips actually bond to this?"
 *
 * Sampled on a ring at that radius plus the centre, rather than tested analytically: the clips
 * present an annulus, and what matters is that no part of it falls in a hole or outside the
 * shape. 64 samples puts them ~1.6mm apart at the clip radius, finer than any feature a traced
 * silhouette holds at this scale.
 */
export function coversClipDisc(rings: Outline, radiusMm: number, samples = 64): boolean {
  if (!outlineContains(rings, 0, 0)) return false;
  for (let i = 0; i < samples; i++) {
    const t = (i / samples) * Math.PI * 2;
    if (!outlineContains(rings, radiusMm * Math.cos(t), radiusMm * Math.sin(t))) return false;
  }
  return true;
}

/**
 * How much of the outline sits in features narrower than `widthMm`, in mm².
 *
 * A morphological *opening* — erode by half the width, then dilate back by the same. Anything
 * wider than the width is restored exactly; anything narrower has no material left at its
 * centreline to grow back from, so it stays gone. The area that fails to return is the area in
 * features too narrow, which is the number worth telling someone.
 *
 * Erosion alone is not enough, and getting that wrong is easy: it only catches a feature that
 * pinches the shape into more pieces. A tapered limb just gets shorter, the ring count is
 * unchanged, and a whole silhouette scaled down to 60mm reported nothing under 3mm while being
 * 33mm wide overall. The dilate-back is what turns "did the topology change" into "how much of
 * this is too thin".
 *
 * This is about PRINTABILITY, not about the geometry being wrong: a 0.5mm spike still extrudes
 * into a valid solid, it is just one nozzle-width of plastic standing 3mm tall. Hence a notice
 * rather than a refusal.
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
 * This is what makes the hubcap the shape of the picture on it. The artwork and the part are the
 * same object — a character-shaped hubcap is that shape *because* the artwork is that character —
 * so the outline is read off the artwork already loaded rather than uploaded a second time and
 * kept in sync with it.
 *
 * Shape by shape, then unioned, rather than throwing every loop in at once: a shape's own loops
 * are outer-and-holes and only mean the right thing under an even-odd read, while two *different*
 * shapes overlapping have to merge rather than cancel. Handing the lot to one even-odd pass would
 * punch a hole wherever two colours overlap — which, in artwork drawn as stacked layers, is most
 * of it.
 *
 * **Both artwork axes are negated into the part's frame.** Artwork space is y-down (SVG's
 * convention, and the raster decoder's) and the part's ground plane is not, so Y flips —
 * `DesignPlacement.zMul` on the cut path is documented as "-1 (base SVG y-down -> viewport
 * correction)". X flips as well because the design face points +Y and is *seen from above*: a
 * surface's own frame reads mirrored from the side you look at it, which is what the cut path's
 * face basis (src/scene/faceFrame.ts) resolves and what this, building the part before any face
 * exists to ask, has to state as a constant. It is a constant safely: preferFaceNormal pins this
 * kind's design face to +Y.
 *
 * Getting either one wrong produces a shape that looks entirely plausible on its own and is
 * only wrong next to the picture printed on it — the two were caught one at a time, from
 * screenshots, as "upside down" and then as "mirrored".
 *
 * The caller scales and centres with `fitOutline`.
 */
export function silhouetteFromShapes(wasm: ManifoldAPI, shapes: SVGShape[]): Outline {
  const regions = shapes
    .map((s) => s.loops.filter((l) => l.length >= 3))
    .filter((loops) => loops.length)
    .map(
      (loops) =>
        new wasm.CrossSection(
          loops.map((l) => l.map((p) => [-p.x, -p.y] as [number, number])),
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
