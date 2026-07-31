import * as THREE from 'three';
import * as turf from '@turf/turf';
import type { AssemblyPart, PolyFeature } from '../types';
import { extrudeRegionToSoup } from './manifold';

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

/** X/Z bounding box (mm) of a part's flat-face boundary loop; null when the loop is empty. */
export function faceXZBBox(
  loop: number[][] | null | undefined,
): { cx: number; cz: number; w: number; h: number } | null {
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
 * FILL_REFINE_MM in conformal.ts. `snapMM` is left overridable for tests; the build passes the
 * same CHART_SNAP_MM in both modes, since that tolerance covers a bake artifact neither mode
 * escapes (see its comment).
 */
export interface CutterOptions {
  refineMM?: number;
  snapMM?: number;
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
  /** the actual cut depth for a color: pass-through, unless a cut-through zone overrides it */
  resolveCutDepth(depthSetting: number): number;
  /** build the cutter geometry from a placed+clipped 2D feature */
  buildCutter(
    feat: PolyFeature,
    depth: number,
    overshoot: number,
    opts?: CutterOptions,
  ): Float32Array | null;
  /** world-space face frame at the given in-plane (u, v), for the gizmo */
  frameAt(u: number, v: number): ZoneFrame;
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
    const faceBB = isRect ? faceXZBBox(part.boundaryLoop) : null;
    this.faceCx = faceBB ? faceBB.cx : 0;
    this.faceCz = faceBB ? faceBB.cz : 0;
  }

  // Boundary and through-depth are computed lazily and cached: the gizmo path builds a mapper only
  // to read frameAt(), so the turf.polygon clip loop and the vertical-extent scan must not run
  // eagerly on every refresh.
  boundary(): PolyFeature | null {
    if (this.boundaryComputed) return this.boundaryPoly;
    this.boundaryComputed = true;
    const part = this.part;
    // Face boundary as a turf polygon in native X/Z, to clip regions to the actual face. A
    // cut-through part (e.g. a domed cap) has a design meant to span the whole curved surface,
    // not just the small flat patch used to place it, so skip the clip — the boolean subtract
    // against the real mesh is what actually bounds the cut.
    if (!part.cutThrough && part.boundaryLoop) {
      const bRing = part.boundaryLoop.map((p) => [p[0], p[2]]);
      if (bRing.length >= 3) {
        if (
          bRing[0][0] !== bRing[bRing.length - 1][0] ||
          bRing[0][1] !== bRing[bRing.length - 1][1]
        )
          bRing.push(bRing[0]);
        try {
          this.boundaryPoly = turf.polygon([bRing]) as PolyFeature;
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
      bb = faceXZBBox(this.part.boundaryLoop);
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

  resolveCutDepth(depthSetting: number): number {
    return this.part.cutThrough ? this.throughDepth() : depthSetting;
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
): ZoneMapper {
  return new FlatZoneMapper(part, parts, isRect);
}
