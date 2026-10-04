import type { SVGShape } from '../types';
import type { ManifoldAPI } from './manifold';

/**
 * A closed 2D outline for the hubcap's disc, so the part can take a logo's shape. Points are (x,
 * z): the native frame is Y-up, Y is thickness. No geometry builder: a silhouette is cut FLAT, a
 * plain 3mm prism (`extrudeRegionToSoup`, src/geometry/manifold.ts); lofting a 1mm chamfer needed
 * band booleans, nested-ring resolution and height tagging, all dropped with the square edge. What
 * is left is what the *checks* measure.
 */
export interface OutlinePt {
  x: number;
  z: number;
}
export type OutlineRing = OutlinePt[];

/** Rings of one outline: outer boundary(ies) and holes together, in mm, centred on the axis. */
export type Outline = OutlineRing[];

/**
 * Where the artwork lands, in the cut's own terms: the *same* numbers as `DesignPlacement`
 * (src/geometry/zones.ts), with `placeArtworkPoint` the same arithmetic as its `placer`, because
 * part and picture are one object only under one shared transform. Two meant to agree didn't: the
 * outline fit its traced *content* bbox while the artwork scaled off the *canvas*, so a padded PNG
 * (a 300x450 subject on a 512x512 sheet) printed about 12% smaller than its shape, and offset; an
 * SVG with a physical size disagreed by that size.
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
 * Scale an outline by `k` about a fixed point. The caller shrinks about the mounting axis, where
 * the outline is centred, which equals building it with `mmPerUnit * k` (the centre is the one
 * point scale doesn't move), so the same `k` can go to the artwork. With the offset derived (see
 * hubcapShapeFromState), every point's reach scales by exactly k, so the cap is one ratio and the
 * old bisecting `fitFactorForRadius` is gone.
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
 * Enclosed area, holes subtracted. Nesting by containment (odd depth = hole), not winding: neither
 * the tracer nor Manifold's 2D engine promises a hole runs opposite its boundary (as in
 * `shapeToFeature`), and summing signed areas reads a donut as disc PLUS hole.
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
 * Fraction of the clips' bonding annulus (HUBCAP_CLIP_FACE_*_R_MM) backed by disc, sampled on a
 * polar grid: the outline is a traced polygon with holes, and the question is "how much". Area, not
 * a rim probe: one 1-in-64 nick at the extreme radius refused a real silhouette. What must be
 * caught is a clip over a HOLE or off the shape.
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
 * Area (mm²) of the outline in features narrower than `widthMm`: a morphological *opening* (erode
 * by half, dilate back); what fails to return was too narrow. Erosion alone only catches a pinch
 * into more pieces: a tapered limb just shortens, and a silhouette scaled to 60mm reported nothing
 * under 3mm while 33mm wide overall. PRINTABILITY, not bad geometry: a 0.5mm spike is a valid
 * solid, one nozzle wide and 3mm tall, hence a notice, not a refusal.
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
 * The silhouette of loaded artwork, every shape merged into one outline, read off the loaded
 * artwork rather than a second upload. Each shape's loops go even-odd, then shapes union: one
 * even-odd pass over everything punches a hole wherever two colours overlap, which in layered
 * artwork is most of it.
 *
 * Points arrive via `placeArtworkPoint`, the cut's own numbers. Both axes normally negate: Y as
 * artwork space is y-down (SVG and the raster decoder), X as the +Y design face is *seen from
 * above*. Either wrong looks plausible alone and wrong only beside the printed picture; both were
 * caught from screenshots, "upside down" then "mirrored".
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
