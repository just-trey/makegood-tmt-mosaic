import * as THREE from 'three';
import * as turf from '@turf/turf';
import type { AssemblyPart, PolyFeature } from '../types';
import { extrudeRegionToSoup, type ManifoldAPI } from './manifold';
import { EDGE_TOUCH_TOL_MM, erodeBoundary, splitAtBoundary } from './edgeRegions';
import { shapeToFeature } from './regions';

/** How far each cutter pokes above the face so the pocket opens cleanly at the surface. */
export const OVERSHOOT_MM = 0.5;

export function rotatePointY(
  x: number,
  z: number,
  pivotX: number,
  pivotZ: number,
  angleDeg: number,
): [number, number] {
  const r = (angleDeg * Math.PI) / 180,
    c = Math.cos(r),
    s = Math.sin(r);
  const dx = x - pivotX,
    dz = z - pivotZ;
  return [pivotX + dx * c - dz * s, pivotZ + dx * s + dz * c];
}

export function asmPartFaceNormal(part: AssemblyPart, parts: AssemblyPart[]): number[] | null {
  if (part.patchNormal) return part.patchNormal;
  if (part.isDuplicateOf) {
    const src = parts.find((p) => p.id === part.isDuplicateOf);
    if (src && src.patchNormal) return src.patchNormal;
  }
  return null;
}

/**
 * X/Z bounding box (mm) of a part's design face: its outline loop, which `boundaryLoops` puts
 * first. Deliberately just that one. Holes lie inside it and would not move it, and a second,
 * smaller island would stretch it across the gap between the two, which is not a face extent
 * anything wants to centre or scale a design on. Null when there is no loop to measure.
 */
export function faceXZBBox(
  loops: number[][][] | null | undefined,
): { cx: number; cz: number; w: number; h: number } | null {
  const loop = loops && loops[0];
  if (!loop || !loop.length) return null;
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const p of loop) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[2] < minZ) minZ = p[2];
    if (p[2] > maxZ) maxZ = p[2];
  }
  return { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, w: maxX - minX, h: maxZ - minZ };
}

/**
 * The design-placement parameters shared across every zone in one build — how an SVG point maps
 * into the zone's 2D design space (mm). Distinct from the zone's own geometry (which face, which
 * way it points): a mapper owns the geometry, `placer(placement)` folds these in to produce the
 * actual SVG→2D function.
 */
export interface DesignPlacement {
  /** the design's anchor circle (real <circle> or the artwork-bbox pseudo-circle) */
  svgC: { cx: number; cy: number; r: number };
  /** mm per SVG user unit at the current scale */
  mmPerUnit: number;
  /** user horizontal mirror: -1 when flipX, else 1 */
  xFlip: number;
  /** vertical multiplier: 1 when flipY, else -1 (base SVG y-down → viewport correction) */
  zMul: number;
  offX: number;
  offZ: number;
  /** design rotation about its center, in degrees */
  rotationDeg: number;
}

/**
 * The rectangle a fill-mode artwork must cover, in the zone's own 2D design space (mm). Distinct
 * from `boundary()`, which is the clip target and is deliberately null on a cut-through zone: a
 * fill still needs to know how far to tile even when nothing clips it.
 */
export interface FillExtent {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Per-cut knobs a fill needs and a sticker doesn't (both conformal-only; the flat mapper's cutter
 * is a straight extrusion with nothing to tune). A fill spans the whole zone rather than a
 * sticker-sized patch, so it refines more coarsely to keep the triangle count workable — see
 * FILL_REFINE_MM in conformal.ts. The snap tolerance is deliberately not a knob here: it covers a
 * bake artifact neither mode escapes, so both take CHART_SNAP_MM (see its comment).
 */
export interface CutterOptions {
  refineMM?: number;
}

/**
 * One slice of a color's region and the depth it is cut at. `edge` marks a slice that took a
 * part's edge-cut-through depth instead of the setting, so the caller can say which colors that
 * happened to without re-deriving the rule.
 */
export interface CutRegion {
  feat: PolyFeature;
  depth: number;
  edge?: boolean;
}

/** What `resolveCutRegions` needs to know about the region it is being handed. */
export interface CutRegionOptions {
  /** names the color in any warning the split raises */
  label?: string;
  /**
   * Whether `feat` really was clipped to this zone's boundary. False when the clipper failed and
   * the caller is passing the region through unclipped — in which case "reaches past the boundary"
   * stops meaning "stands on the part's outer wall" and the edge rule must not fire. Defaults to
   * true, which is what every non-clipping caller (and every test) is entitled to assume.
   */
  clipped?: boolean;
}

/** World-space frame of a zone at a given in-plane (u, v), for the on-face gizmo. */
export interface ZoneFrame {
  /** design-center position in the part's native model space (before the model-group grid lift) */
  origin: THREE.Vector3;
  /** unit vector the +u (offsetX) axis moves along */
  uAxis: THREE.Vector3;
  /** unit vector the +v (offsetY) axis moves along */
  vAxis: THREE.Vector3;
  /** unit plane normal */
  normal: THREE.Vector3;
  /**
   * How far the queried (u, v) fell outside the surface this mapper covers, in mm — 0 when it
   * landed on it. A flat face is unbounded in its own plane, so it is always 0; a conformal chart
   * covers only part of its UV rectangle and answers an outside query with the nearest triangle it
   * has, which can be a long way off on unrelated geometry. Reported so the gizmo can say so
   * instead of drawing a frame there as if it were on the design surface.
   */
  offChartMM: number;
}

/**
 * The seam between "how artwork maps onto a surface" and the rest of the assembly build. A
 * FlatZoneMapper reproduces the original single-flat-patch behavior exactly; a future
 * ConformalZoneMapper (chair body) will implement the same interface over a warped UV chart, so
 * `buildAssemblyGeometry` and the gizmo don't need to know which surface they're cutting.
 */
export interface ZoneMapper {
  /**
   * Which baked design zone this maps, matching `DesignZone.id` — what an artwork instance binds
   * to when the user targets one surface of a multi-zone part. `null` is the implicit flat zone a
   * part with no sidecar gets, which unbound artwork lands on.
   */
  readonly zoneId: string | null;
  /** detected face normal (native frame), or null when the part has none */
  readonly faceNormal: number[] | null;
  /** which way the face points along Y: +1 or -1 */
  readonly nsign: number;
  /** SVG-space → zone 2D design space (mm), folding in the shared placement */
  placer(placement: DesignPlacement): (pt: number[]) => number[];
  /** clip target polygon in the zone's 2D design space, or null to skip clipping */
  boundary(): PolyFeature | null;
  /** area a fill-mode artwork tiles across, in the zone's 2D design space; null when unknown */
  fillExtent(): FillExtent | null;
  /**
   * How a color's placed, already-clipped region actually gets cut: one entry per depth the zone
   * wants used, each carrying the slice of the region cut at it. Usually a single pass-through
   * entry; a cut-through zone replaces the depth, and a zone with an edge rule splits the region
   * into the polygons standing on its outer wall and the rest.
   *
   * The mapper answers with regions rather than a bare depth so nothing upstream has to know which
   * kind of zone it is holding — the caller extrudes whatever it is handed. Returning an empty
   * array is not a thing any mapper does: a region always gets cut somehow.
   */
  resolveCutRegions(feat: PolyFeature, depthSetting: number, opts?: CutRegionOptions): CutRegion[];
  /** build the cutter geometry from a placed+clipped 2D feature */
  buildCutter(
    feat: PolyFeature,
    depth: number,
    overshoot: number,
    opts?: CutterOptions,
  ): Float32Array | null;
  /**
   * World-space face frame at the given in-plane (u, v), for the gizmo. `giveUpMM` caps how far a
   * mapper will search for the nearest surface before reporting the query as off-chart — an
   * optimisation for callers making many queries that only need "on it, or not" (see
   * ConformalZoneMapper.lookup). Ignored by mappers whose surface is unbounded in-plane.
   */
  frameAt(u: number, v: number, giveUpMM?: number): ZoneFrame;
}

/**
 * The implicit single-zone mapper every part gets today: the chosen flat patch, projected
 * straight down its (near-vertical) Y normal. Encapsulates exactly the per-part surface geometry
 * `buildAssemblyGeometry` used to compute inline — face direction, face-plane Y, boundary clip,
 * cut-through depth, placement, and the gizmo frame — so behavior is unchanged.
 */
export class FlatZoneMapper implements ZoneMapper {
  readonly zoneId = null;
  readonly faceNormal: number[] | null;
  readonly nsign: number;
  private readonly faceY: number;
  private readonly faceCx: number;
  private readonly faceCz: number;
  private boundaryComputed = false;
  private boundaryPoly: PolyFeature | null = null;
  private throughDepthCache: number | null = null;
  private fillExtentCache: FillExtent | null | undefined;

  constructor(
    private readonly part: AssemblyPart,
    parts: AssemblyPart[],
    isRect: boolean,
    // Only the edge-region split needs it, and only the build path takes that route — the gizmo
    // builds mappers to read frameAt() and passes null, exactly as ConformalZoneMapper allows.
    private readonly wasm: ManifoldAPI | null = null,
  ) {
    const nrm = asmPartFaceNormal(part, parts);
    this.faceNormal = nrm;
    // Which way the face points along Y, and the actual Y of the face plane. topZ is the plane
    // offset (= nrm.y * faceY), so a face pointing -Y (e.g. the BACK of the wheel) needs the
    // pocket cut in the opposite direction — otherwise the inlay lands on the wrong side.
    this.nsign = nrm && nrm[1] < 0 ? -1 : 1;
    this.faceY = nrm && Math.abs(nrm[1]) > 0.1 ? part.topZ / nrm[1] : part.topZ;

    // Rect parts center the design on the detected face (its native X/Z bbox center); wheel parts
    // anchor on the hub at the origin.
    const faceBB = isRect ? faceXZBBox(part.boundaryLoops) : null;
    this.faceCx = faceBB ? faceBB.cx : 0;
    this.faceCz = faceBB ? faceBB.cz : 0;
  }

  // Boundary and through-depth are computed lazily and cached: the gizmo path builds a mapper only
  // to read frameAt(), so the boundary nesting and the vertical-extent scan must not run
  // eagerly on every refresh.
  boundary(): PolyFeature | null {
    if (this.boundaryComputed) return this.boundaryPoly;
    this.boundaryComputed = true;
    const part = this.part;
    // Face boundary as a turf polygon in native X/Z, to clip regions to the actual face. A
    // cut-through part (e.g. a domed cap) has a design meant to span the whole curved surface,
    // not just the small flat patch used to place it, so skip the clip — the boolean subtract
    // against the real mesh is what actually bounds the cut.
    if (!part.cutThrough && part.boundaryLoops) {
      // Every loop, nested by `shapeToFeature`'s containment-depth rule rather than clipped to the
      // outline alone: the face of a holed silhouette is a polygon with holes, and eroding that is
      // what makes each hole's rim an edge for the cut-through rule. Reused rather than
      // re-derived, the same round-trip `erodeBoundary` already makes.
      const rings = part.boundaryLoops.map((l) => l.map((p) => ({ x: p[0], y: p[2] })));
      this.boundaryPoly = shapeToFeature({ fill: '', order: 0, loops: rings });
      // `null` from shapeToFeature means the loops enclose no X/Z area, which happens when the
      // chosen patch faces sideways (a model exported Z-up, dropped on a part). Returning it would
      // mean "no clip" and let the cut run unbounded at an arbitrary plane. A zero-area polygon
      // clips every region away instead, which is what this path has always done.
      if (!this.boundaryPoly && rings[0] && rings[0].length >= 3) {
        const ring = rings[0].map((p) => [p.x, p.y]);
        ring.push(ring[0]);
        try {
          this.boundaryPoly = turf.polygon([ring]) as PolyFeature;
        } catch {
          this.boundaryPoly = null;
        }
      }
    }
    return this.boundaryPoly;
  }

  /**
   * The region a fill tiles over, in native X/Z. Deliberately not derived from `boundary()`, for
   * both of the reasons that method is unusual: a cut-through part has no clip boundary at all,
   * and its design is meant to span the whole curved surface rather than the small flat patch used
   * to place it — so it measures the part's whole X/Z footprint, while an ordinary part measures
   * the design face it actually cuts into.
   */
  fillExtent(): FillExtent | null {
    if (this.fillExtentCache !== undefined) return this.fillExtentCache;
    let bb: { cx: number; cz: number; w: number; h: number } | null = null;
    if (this.part.cutThrough && this.part.positions) {
      const pos = this.part.positions;
      let minX = Infinity,
        maxX = -Infinity,
        minZ = Infinity,
        maxZ = -Infinity;
      for (let i = 0; i < pos.length; i += 3) {
        if (pos[i] < minX) minX = pos[i];
        if (pos[i] > maxX) maxX = pos[i];
        if (pos[i + 2] < minZ) minZ = pos[i + 2];
        if (pos[i + 2] > maxZ) maxZ = pos[i + 2];
      }
      if (maxX > minX)
        bb = { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, w: maxX - minX, h: maxZ - minZ };
    } else {
      bb = faceXZBBox(this.part.boundaryLoops);
    }
    if (!bb || !(bb.w > 0) || !(bb.h > 0)) return (this.fillExtentCache = null);
    return (this.fillExtentCache = {
      minX: bb.cx - bb.w / 2,
      minY: bb.cz - bb.h / 2,
      maxX: bb.cx + bb.w / 2,
      maxY: bb.cz + bb.h / 2,
    });
  }

  private throughDepth(): number {
    if (this.throughDepthCache != null) return this.throughDepthCache;
    const part = this.part;
    // A cut-through part ignores the normal depth setting: either it cuts a fixed mm depth
    // straight down from the face (e.g. the cap's 3mm shell above its mounting boss — deeper
    // would breach it), or, with no configured depth, pierces the part's whole vertical extent
    // (plus overshoot past the far surface) regardless of local curvature/thickness.
    let depth = 0;
    if (part.cutThrough && part.positions) {
      if (part.cutThroughDepth != null) {
        depth = part.cutThroughDepth;
      } else {
        let yMin = Infinity,
          yMax = -Infinity;
        for (let i = 1; i < part.positions.length; i += 3) {
          const y = part.positions[i];
          if (y < yMin) yMin = y;
          if (y > yMax) yMax = y;
        }
        depth = (this.nsign > 0 ? this.faceY - yMin : yMax - this.faceY) + OVERSHOOT_MM;
      }
    }
    this.throughDepthCache = depth;
    return depth;
  }

  /**
   * The eroded design face, computed once per part and shared by every color on it — the erosion
   * is a Manifold offset over the whole boundary and would otherwise run per color per artwork.
   * `null` is a real answer (a face thinner than the tolerance); `undefined` is "not asked yet".
   */
  private erodedCache: PolyFeature | null | undefined;

  private eroded(boundary: PolyFeature): PolyFeature | null {
    if (this.erodedCache !== undefined) return this.erodedCache;
    return (this.erodedCache = this.wasm
      ? erodeBoundary(this.wasm, boundary, EDGE_TOUCH_TOL_MM)
      : null);
  }

  resolveCutRegions(feat: PolyFeature, depthSetting: number, opts?: CutRegionOptions): CutRegion[] {
    // A cut-through part takes its hole the whole way through for every color, so there is no
    // edge to distinguish — and it has no clip boundary to measure one against either. Not
    // flagged `edge`: that flag drives a notice about the *edge rule*, and saying it here would
    // announce a new behavior on the wheel cap, which has cut this way since it shipped.
    if (this.part.cutThrough) return [{ feat, depth: this.throughDepth() }];
    const edgeDepth = this.part.edgeCutThroughDepth;
    const boundary = this.boundary();
    if (edgeDepth == null || !boundary) return [{ feat, depth: depthSetting }];
    // An unclipped region (the caller's clip failed) reaches past the boundary everywhere, which
    // this rule would read as "all of it stands on the outer wall" and cut the whole color through
    // — a hole where the old behavior was merely an oversized recess. Recess is the safe
    // direction, and it is what the part did before this rule existed.
    if (opts?.clipped === false) return [{ feat, depth: depthSetting }];
    // No wasm means no erosion, and erodeBoundary's own null means the face vanished under the
    // tolerance. The first should treat everything as interior (the gizmo path, which never cuts);
    // the second should treat everything as edge. eroded() returns null for both, so guard the
    // wasm case here rather than conflating them inside splitAtBoundary.
    if (!this.wasm) return [{ feat, depth: depthSetting }];
    const { edge, interior } = splitAtBoundary(feat, this.eroded(boundary), opts?.label);
    const out: CutRegion[] = [];
    if (edge) out.push({ feat: edge, depth: edgeDepth, edge: true });
    if (interior) out.push({ feat: interior, depth: depthSetting });
    // Both null means the split lost the region outright, which it has no way to do — every
    // polygon lands in exactly one bucket. Falling back to the unsplit region keeps a bug here
    // from silently deleting a color from the part.
    return out.length ? out : [{ feat, depth: depthSetting }];
  }

  buildCutter(feat: PolyFeature, depth: number, overshoot: number): Float32Array | null {
    return extrudeRegionToSoup(feat, this.faceY, depth, overshoot, this.nsign);
  }

  /**
   * SVG-space → part-native X/Z (mm). A +Y-facing design is viewed from the +Y side, which reads
   * the artwork mirrored left-to-right, so negate X on those faces to keep it right-reading by
   * default; a -Y face is viewed from -Y and already reads correctly. Rotated copies get the
   * inverse of their assembly rotation, so the design slice that lands on the copy is baked into
   * the part's native (unrotated) print orientation.
   */
  placer(p: DesignPlacement): (pt: number[]) => number[] {
    const { part, nsign, faceCx, faceCz } = this;
    return (pt: number[]): number[] => {
      const xMul = p.xFlip * (nsign > 0 ? -1 : 1);
      // center+scale+mirror in the face frame, then rotate about the design center (before the
      // offset+faceCenter translation), so rotation spins the artwork in place rather than
      // sweeping it around the face.
      let x = (pt[0] - p.svgC.cx) * p.mmPerUnit * xMul;
      let z = (pt[1] - p.svgC.cy) * p.mmPerUnit * p.zMul;
      if (p.rotationDeg) {
        const rr = rotatePointY(x, z, 0, 0, p.rotationDeg);
        x = rr[0];
        z = rr[1];
      }
      x += p.offX + faceCx;
      z += p.offZ + faceCz;
      if (part.isDuplicateOf) {
        const r = rotatePointY(x, z, part.pivotX, part.pivotZ, -part.angleDeg);
        x = r[0];
        z = r[1];
      }
      return [x, z];
    };
  }

  frameAt(u: number, v: number): ZoneFrame {
    return {
      origin: new THREE.Vector3(u + this.faceCx, this.faceY, v + this.faceCz),
      uAxis: new THREE.Vector3(1, 0, 0),
      vAxis: new THREE.Vector3(0, 0, 1),
      normal: new THREE.Vector3(0, this.nsign, 0),
      offChartMM: 0,
    };
  }
}

/**
 * The mapper for a part that declares no baked zones: one implicit flat zone from its chosen
 * design patch. Parts with baked zones (the chair body, Phase 4+) will dispatch to a
 * ConformalZoneMapper here instead.
 */
export function implicitZoneFor(
  part: AssemblyPart,
  parts: AssemblyPart[],
  isRect: boolean,
  wasm: ManifoldAPI | null = null,
): ZoneMapper {
  return new FlatZoneMapper(part, parts, isRect, wasm);
}
