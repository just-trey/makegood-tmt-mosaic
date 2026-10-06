import { CUT_FLOOR_MM, MIN_CUT_DEPTH_MM, depthDiffers } from './depth';
import * as THREE from 'three';
import * as turf from '@turf/turf';
import type { AssemblyPart, PolyFeature } from '../types';
import type { ArtworkBuildInput } from './assembly';
import { extrudeRegionToSoup, type ManifoldAPI } from './manifold';
import { EDGE_TOUCH_TOL_MM, erodeBoundary, splitAtBoundary } from './edgeRegions';
import { shapeToFeature } from './regions';
import { buildWallField, minWallUnder, type WallField } from './wall';

/** How far each cutter pokes above the face so the pocket opens cleanly at the surface. */
export const OVERSHOOT_MM = 0.5;

/** The flat cut's axis. Read-only: clone it before writing. */
const UP = new THREE.Vector3(0, 1, 0);

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
 * X/Z bbox (mm) of a part's design face: the outline loop (`boundaryLoops[0]`) only. Holes would
 * not move it, and a second island would stretch it across the gap. Null with no loop.
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
 * A patch of one zone's 2D design space that another sheet of the net owns, ready to clip against.
 * `bbox` is turf's [minX, minY, maxX, maxY], so a placed region that comes nowhere near it costs
 * no boolean at all — the common case, since most zones yield nothing.
 */
export interface NetExclusion {
  /** the owning zone's display name, for the notice that says where the ink went instead */
  toName: string;
  /**
   * Null when the baked loops would not build a polygon: unclippable, not absent, so a design
   * reaching it is cut here and on `toName` and must be reported. `bbox` stays usable, so a design
   * nowhere near the patch still costs and says nothing.
   */
  region: PolyFeature | null;
  bbox: number[];
  /**
   * False when the two sheets only abut along the stretch this patch lies on, so a design reaching
   * across it is cut in two halves `tearMm` apart on the real part. Undefined where the bake
   * surveyed no boundary here, which says nothing rather than "they join".
   */
  joins?: boolean;
  /** the measured tear, in mm; carried only alongside `joins: false` */
  tearMm?: number;
}

/** Which half of a self-mirrored zone a design keeps: 'right' is u at or past the zone's bbox centre. */
export type KeepSide = 'right' | 'left';

export const oppositeSide = (side: KeepSide): KeepSide => (side === 'right' ? 'left' : 'right');

/**
 * The placement that cuts `a` reflected across a zone's mirror: the same design bound to `zoneId`,
 * with the offset, rotation and flip that put every point at the reflection of where `a` puts it.
 *
 * From ConformalZoneMapper.placer, u = R(θ)·diag(f,1)·(p − c)·mm + off + centre. Reflecting u
 * about the zone's bbox centre is M = diag(−1, 1) on (u − centre), and
 * M·R(θ)·diag(f,1) = R(−θ)·diag(−f,1) with M·off = (−offX, offZ): the reflection is the same
 * placer with the rotation negated, the horizontal flip toggled and offX negated. It holds across
 * a twin pair because each twin anchors on its own bbox centre and the bake orients both as seen
 * from outside (tests/mirror-design.test.ts checks it against a mirrored chart pair).
 *
 * A design keeping one half of a self-mirrored zone hands the other half to its reflection.
 */
export function mirroredBuildInput(a: ArtworkBuildInput, zoneId: string | null): ArtworkBuildInput {
  return {
    ...a,
    zoneId,
    offX: -a.offX,
    rotationDeg: -a.rotationDeg,
    flipX: !a.flipX,
    keepSide: a.keepSide && oppositeSide(a.keepSide),
    reflected: true,
  };
}

/**
 * The zone id an artwork binds to when it is placed on the whole part at once, across every sheet
 * of the baked net rather than one zone. Reserved: no bake may emit a zone with this id, so it
 * travels through `ZoneRef`, persistence and the dropdown as an ordinary id, and is expanded into
 * one ordinary per-zone placement before any geometry sees it.
 */
export const WHOLE_CHAIR_ZONE = '*whole';

/** A rectangle's centre, which is what both a zone chart and the net anchor placement on. */
export function boundsCentre(b: {
  minU: number;
  minV: number;
  maxU: number;
  maxV: number;
}): [number, number] {
  return [(b.minU + b.maxU) / 2, (b.minV + b.maxV) / 2];
}

/**
 * A net-space offset (mm from the net's anchor centre) read in one zone's own offset space.
 *
 * The net places that zone at `p_net = R(θ)·p_zone + t`, and both spaces anchor placement on their
 * own bbox centre, so an offset `o` from the net centre is `R(−θ)·(o + netC − t) − zoneC` from the
 * zone's. Everything that has to agree about where a whole-part design lands — the build inputs,
 * the gizmo frame — goes through this one function.
 */
export function netOffsetToZone(
  off: readonly [number, number],
  place: { rotationDeg: number; offsetU: number; offsetV: number },
  netCentre: readonly [number, number],
  zoneCentre: readonly [number, number],
): [number, number] {
  const r = (-place.rotationDeg * Math.PI) / 180;
  const c = Math.cos(r),
    s = Math.sin(r);
  const dx = off[0] + netCentre[0] - place.offsetU;
  const dy = off[1] + netCentre[1] - place.offsetV;
  return [c * dx - s * dy - zoneCentre[0], s * dx + c * dy - zoneCentre[1]];
}

/**
 * The placement that cuts `a` onto one zone of the net: the same design bound to `zoneId`, moved
 * and turned so every point lands where the net puts it.
 *
 * From ConformalZoneMapper.placer, a zone reads `p = R(rot)·D·s + off + centre`. Composing that
 * with the net's own `R(θ)·p + t` and matching it to the net-space placement gives
 * `rot − θ` and `netOffsetToZone`. Flips are untouched: `D` sits inside the rotation in both, and
 * the net transform carries no reflection, so nothing swaps handedness across it.
 */
export function netToZoneBuildInput(
  a: ArtworkBuildInput,
  zoneId: string,
  place: { rotationDeg: number; offsetU: number; offsetV: number },
  netCentre: readonly [number, number],
  zoneCentre: readonly [number, number],
): ArtworkBuildInput {
  const [offX, offZ] = netOffsetToZone([a.offX, a.offZ], place, netCentre, zoneCentre);
  return {
    ...a,
    zoneId,
    offX,
    offZ,
    rotationDeg: a.rotationDeg - place.rotationDeg,
    netBound: true,
  };
}

/**
 * What the on-face gizmo asks of a surface: which way it faces, where a placed SVG point lands in
 * its 2D design space, and the world frame at an in-plane offset. Every ZoneMapper is one; a
 * whole-part binding is served by `netGizmoMapper`, which is only these four things and could not
 * honestly answer the rest (its clip regions are one zone's, its placement space the net's).
 */
export type GizmoMapper = Pick<ZoneMapper, 'zoneId' | 'faceNormal' | 'placer' | 'frameAt'>;

/**
 * One zone's surface queried in NET coordinates, for a design placed on the whole part.
 *
 * Both directions go through `netOffsetToZone` rather than restating the placer against the net's
 * centre, so the frame the gizmo draws and the cut `netToZoneBuildInput` makes are one piece of
 * algebra. The placer's answer is pushed back out to net mm, so this mapper's 2D design space is
 * the net's throughout.
 */
export function netGizmoMapper(
  inner: ZoneMapper,
  place: { rotationDeg: number; offsetU: number; offsetV: number },
  netCentre: readonly [number, number],
  zoneCentre: readonly [number, number],
): GizmoMapper {
  const r = (place.rotationDeg * Math.PI) / 180;
  const c = Math.cos(r),
    s = Math.sin(r);
  const toNet = (p: number[]): number[] => [
    c * p[0] - s * p[1] + place.offsetU,
    s * p[0] + c * p[1] + place.offsetV,
  ];
  return {
    zoneId: inner.zoneId,
    faceNormal: inner.faceNormal,
    placer: (p: DesignPlacement) => {
      const [offX, offZ] = netOffsetToZone([p.offX, p.offZ], place, netCentre, zoneCentre);
      const zone = inner.placer({
        ...p,
        offX,
        offZ,
        rotationDeg: p.rotationDeg - place.rotationDeg,
      });
      return (pt: number[]) => toNet(zone(pt));
    },
    frameAt: (u, v, giveUpMM) => {
      const [zu, zv] = netOffsetToZone([u, v], place, netCentre, zoneCentre);
      const f = inner.frameAt(zu, zv, giveUpMM);
      // The net's +u is the zone's +u turned by θ, so the axes a drag runs along turn with it.
      return {
        ...f,
        uAxis: f.uAxis.clone().multiplyScalar(c).addScaledVector(f.vAxis, -s),
        vAxis: f.uAxis.clone().multiplyScalar(s).addScaledVector(f.vAxis, c),
      };
    },
  };
}

/**
 * Design placement shared across every zone in one build; a mapper owns the zone geometry, and
 * `placer(placement)` folds these in to give the SVG→2D (mm) function.
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
 * Per-cut knobs a fill needs and a sticker doesn't (conformal only). A fill spans the whole zone,
 * so it refines more coarsely (FILL_REFINE_MM, conformal.ts). Snap tolerance is deliberately no
 * knob: it covers a bake artifact neither mode escapes, so both take CHART_SNAP_MM.
 */
export interface CutterOptions {
  refineMM?: number;
}

/**
 * One slice of a color's region and the depth it is cut at. `edge` marks a slice that took a
 * part's edge-cut-through depth instead of the setting, and `wall` (the thinnest wall under it, mm)
 * one cut shallower than the setting because of that wall, so the caller can say which colors
 * either happened to without re-deriving the rule.
 */
export interface CutRegion {
  feat: PolyFeature;
  depth: number;
  edge?: boolean;
  wall?: number;
}

/** What `resolveCutRegions` needs to know about the region it is being handed. */
export interface CutRegionOptions {
  /** names the color in any warning the split raises */
  label?: string;
  /**
   * Whether `feat` really was clipped to this zone's boundary. False on a clipper failure, where
   * "reaches past the boundary" stops meaning "stands on the outer wall" and the edge rule must not
   * fire. Defaults to true.
   */
  clipped?: boolean;
}

/** World-space frame of a zone at a given in-plane (u, v), for the on-face gizmo. */
export interface ZoneFrame {
  /** design-center position in the part's native model space (before the model-group grid lift) */
  origin: THREE.Vector3;
  /**
   * In-plane vector a drag is read against: (p - origin)·uAxis is the offsetX change that brings
   * the design center to p. Unit wherever the design space is the surface's own; a flat face
   * tilted off horizontal places by projection, and has it shorter.
   */
  uAxis: THREE.Vector3;
  /** the same for offsetY */
  vAxis: THREE.Vector3;
  /** unit plane normal */
  normal: THREE.Vector3;
  /**
   * How far the queried (u, v) fell outside this mapper's surface, mm (0 on it). A flat face: 0, or
   * Infinity for a face along the cut axis. A conformal chart answers outside queries with its
   * nearest triangle, possibly far off on unrelated geometry, so the gizmo can say so.
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
  /**
   * Clip target polygon in the zone's 2D design space. Three states, not two: a polygon clips,
   * `null` means "no clip at all" and cuts everywhere, and an **empty MultiPolygon admits
   * nothing** — every bit of surface this mapper owns is hidden once assembled. The two null-ish
   * answers are opposites, so a caller that folds them together cuts a whole hidden zone.
   */
  boundary(): PolyFeature | null;
  /**
   * Surface this mapper owns that another part hides once assembled, in the same 2D design space,
   * or null where nothing is. Already subtracted out of `boundary()`; exposed on its own so a
   * caller can tell "the design never reached the part" from "it reached only hidden surface".
   */
  deadArea(): PolyFeature | null;
  /**
   * The half of the zone a design keeps when it is mirrored across the zone's own centre line, in
   * the same 2D design space as `boundary()`. Null where the zone offers no such mirror: a flat
   * face has no baked centre, so nothing there is ever asked to keep a half.
   */
  sideClip(side: KeepSide): PolyFeature | null;
  /**
   * Where a WHOLE-PART design must not cut on this zone, because another sheet of the net owns
   * that canvas and cuts it there instead. Empty for every other binding and every kind with no
   * net. Kept out of `boundary()` on purpose: that clip is per zone, this one is per binding.
   */
  netExcluded(): NetExclusion[];
  /** area a fill-mode artwork tiles across, in the zone's 2D design space; null when unknown */
  fillExtent(): FillExtent | null;
  /**
   * How a placed, clipped region gets cut: one entry per depth, each with its slice. Usually one
   * pass-through; a cut-through zone replaces the depth, an edge rule splits off polygons on the
   * outer wall, and a region cuts shallower where the wall under it is thinner. Regions, not a bare
   * depth, so nothing upstream knows the zone kind. Never empty: a region always gets cut somehow.
   */
  resolveCutRegions(feat: PolyFeature, depthSetting: number, opts?: CutRegionOptions): CutRegion[];
  /**
   * The deepest setting worth handing this zone, or Infinity where it cannot say. Only the zone
   * knows its cut direction: a flat one measures behind its normal; a conformal one cuts along a
   * normal field and declines. **A bound on the part, not its wall**: resolveCutRegions' business,
   * on a flat zone only where this measured something, on a conformal one always.
   */
  maxCutDepth(): number;
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
 * The implicit single-zone mapper: the chosen flat patch, projected straight down its
 * (near-vertical) Y normal.
 */
export class FlatZoneMapper implements ZoneMapper {
  readonly zoneId = null;
  readonly faceNormal: number[] | null;
  readonly nsign: number;
  private readonly faceY: number;
  private readonly faceYKnown: boolean;
  private readonly frameNormal: THREE.Vector3;
  private readonly faceMidY: number;
  private readonly faceCx: number;
  private readonly faceCz: number;
  private boundaryComputed = false;
  private boundaryPoly: PolyFeature | null = null;
  private throughDepthCache: number | null = null;
  // Cached like every other per-part measurement here: it is asked once per colour per artwork
  // (16 scans of 53,904 vertices on a two-half wheel with an 8-colour palette) and cannot change.
  private maxCutDepthCache: number | null = null;
  private wallFieldCache: WallField | null = null;
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
    // Whether `faceY` is a real Y: the fallback is the raw plane offset, an X or Z distance on a
    // sideways face. Tested once here: maxCutDepth() checking its own result's *sign* measured the
    // footrest's side patches at 141.95mm and 169.95mm on a part 64mm tall.
    this.faceYKnown = !!nrm && Math.abs(nrm[1]) > 0.1;
    this.faceY = this.faceYKnown ? part.topZ / nrm![1] : part.topZ;
    this.frameNormal = nrm ? new THREE.Vector3(nrm[0], nrm[1], nrm[2]).normalize() : UP.clone();
    // Where on a sideways face to draw the frame, since faceY is no height there.
    const outline = part.boundaryLoops?.[0];
    let yLo = Infinity,
      yHi = -Infinity;
    if (!this.faceYKnown && outline)
      for (const pt of outline) {
        if (pt[1] < yLo) yLo = pt[1];
        if (pt[1] > yHi) yHi = pt[1];
      }
    this.faceMidY = yHi >= yLo ? (yLo + yHi) / 2 : 0;

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
      // Every loop, nested by `shapeToFeature`'s containment rule: a holed silhouette's face has
      // holes, and eroding that makes each hole's rim an edge for the cut-through rule.
      const rings = part.boundaryLoops.map((l) => l.map((p) => ({ x: p[0], y: p[2] })));
      this.boundaryPoly = shapeToFeature({ fill: '', order: 0, loops: rings });
      // `null` means no X/Z area (a sideways patch, e.g. a Z-up export), which would mean "no clip"
      // and an unbounded cut; a zero-area polygon clips every region away instead.
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

  /** A flat patch is the whole design face; nothing is hidden behind another part. */
  deadArea(): PolyFeature | null {
    return null;
  }

  sideClip(): PolyFeature | null {
    return null;
  }

  /** A flat face is the only sheet a kind with no net has; it yields nothing to anything. */
  netExcluded(): NetExclusion[] {
    return [];
  }

  /**
   * The region a fill tiles over, native X/Z. Not from `boundary()`: a cut-through part has no clip
   * and its design spans the whole curved surface, so it takes the part's X/Z footprint; an
   * ordinary part takes its design face.
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

  /**
   * Deepest recess this part holds: design face to far side along the cut axis, less CUT_FLOOR_MM.
   * **Along Y, because `buildCutter` extrudes down Y**: projecting onto `patchNormal` read 139.88mm
   * on wheel-half's -Z patch against 24.13mm of real material. The constructor's `nsign`/`faceY`
   * bound a duplicate with a borrowed normal like its source. Measured off the mesh, not
   * `AssemblyPart.baseDepth`: nothing has ever read that field, and adopting it would hand a
   * dormant user-editable field control of cut depth.
   * **A bound on the part, not its wall**: 8.12mm over the hubcap's 3mm shell
   * (scripts/measure-wall.ts), so resolveCutRegions bounds each region by its wall too.
   */
  maxCutDepth(): number {
    if (this.maxCutDepthCache != null) return this.maxCutDepthCache;
    const pos = this.part.positions;
    // Cached on the decline paths too, or the full-mesh scan below reruns per colour per artwork on
    // exactly the parts that decline, which is what the cache exists to stop.
    if (!pos || !this.faceYKnown) return (this.maxCutDepthCache = Infinity);
    let yMin = Infinity,
      yMax = -Infinity;
    for (let i = 1; i < pos.length; i += 3) {
      const y = pos[i];
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
    // Checked against the mesh, not the result's sign: `topZ / nrm.y` can land far outside a tilted
    // part (299.95mm on a box 10mm tall), and two sign-based guesses each fell to a fixture of the
    // other sign.
    if (this.faceY < yMin || this.faceY > yMax) return (this.maxCutDepthCache = Infinity);
    const extent = this.nsign > 0 ? this.faceY - yMin : yMax - this.faceY;
    const usable = extent - CUT_FLOOR_MM;
    // Declines rather than clamping when the answer isn't a printable recess ("doesn't apply", not
    // "0.2mm deep"):
    //   - A non-vertical face (the picker offers the top six patches unfiltered) gives a negative
    //     extent; clamping cut every colour at the minimum, called "deeper than the part goes".
    //   - A part too thin for the minimum: that is the geometry, not the user's number.
    if (!Number.isFinite(usable) || usable < MIN_CUT_DEPTH_MM)
      return (this.maxCutDepthCache = Infinity);
    return (this.maxCutDepthCache = usable);
  }

  resolveCutRegions(feat: PolyFeature, depthSetting: number, opts?: CutRegionOptions): CutRegion[] {
    // A cut-through part holes every color the whole way and has no clip: no edge to tell apart.
    // Not `edge`: that drives the edge-rule notice, announcing new behavior on the wheel cap.
    if (this.part.cutThrough) return [{ feat, depth: this.throughDepth() }];
    // Asked by flag, never by comparing depths: an edge slice deliberately cuts the full shell,
    // and on a 3mm shell a 3mm setting would read as equal to it.
    return this.splitAtEdge(feat, depthSetting, opts).map((r) =>
      r.edge ? r : this.boundByWall(r, opts),
    );
  }

  /**
   * Bounds a slice by the thinnest wall anywhere under it, less CUT_FLOOR_MM: a cutter is one
   * prism, so anything deeper cuts through at that spot. Only where maxCutDepth() measured
   * something, along the same axis, and only on a clipped region: an unclipped one reaches past the
   * face and would be measured against whatever lies beside it.
   *
   * A wall too thin for the minimum recess still clamps, to the minimum. Declining there let a
   * region touching one undercut edge cut the full setting through the 3mm plate beside it.
   */
  private boundByWall(r: CutRegion, opts?: CutRegionOptions): CutRegion {
    if (!Number.isFinite(this.maxCutDepth()) || opts?.clipped === false) return r;
    const pos = this.part.positions!;
    const field = (this.wallFieldCache ??= buildWallField(pos, this.faceY, this.nsign));
    const wall = minWallUnder(field, r.feat);
    if (!Number.isFinite(wall)) return r;
    const bound = Math.max(wall - CUT_FLOOR_MM, MIN_CUT_DEPTH_MM);
    if (r.depth <= bound || !depthDiffers(bound, r.depth)) return r;
    return { feat: r.feat, depth: bound, wall: Math.max(wall, 0) };
  }

  private splitAtEdge(
    feat: PolyFeature,
    depthSetting: number,
    opts?: CutRegionOptions,
  ): CutRegion[] {
    const edgeDepth = this.part.edgeCutThroughDepth;
    const boundary = this.boundary();
    if (edgeDepth == null || !boundary) return [{ feat, depth: depthSetting }];
    // An unclipped region (failed clip) reads as all-edge and would cut the color through; recess
    // is the safe direction.
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

  /**
   * The design is placed in native X/Z and cut straight down Y, so the frame is that X/Z point
   * lifted along Y onto the face. A horizontal face gets exactly (x, faceY, z) and the X/Z axes. A
   * face running along Y has no such lift, and gets a frame of its own, flagged off-surface.
   */
  frameAt(u: number, v: number): ZoneFrame {
    const x = u + this.faceCx,
      z = v + this.faceCz;
    const n = this.frameNormal;
    if (this.faceYKnown || !this.faceNormal) {
      // X and Z projected onto the face, not lifted: for any point p on it, (p - origin)·uAxis is
      // then exactly the X change that lifts onto p, so a drag keeps the design under the cursor.
      // Shorter than unit, and not square, on a tilted face.
      return {
        origin: new THREE.Vector3(x, this.faceY - (n.x * x + n.z * z) / n.y, z),
        uAxis: new THREE.Vector3(1, 0, 0).addScaledVector(n, -n.x),
        vAxis: new THREE.Vector3(0, 0, 1).addScaledVector(n, -n.z),
        normal: n.clone(),
        offChartMM: 0,
      };
    }
    // A face running along Y: no X/Z point lifts onto it, and the cut runs at `topZ` standing in for
    // a height, so the design does not land on this face. Drawn on it anyway, where the user picked,
    // and flagged as off it. The frame is the face's own 2D frame so a drag still follows the
    // cursor; the offset that moves a point along the face keeps its axis, the other gets up.
    const up = UP.clone().addScaledVector(n, -n.y).normalize();
    const across = new THREE.Vector3().crossVectors(up, n);
    const facesZ = Math.abs(n.z) >= Math.abs(n.x);
    if ((facesZ ? across.x : across.z) < 0) across.negate();
    const uAxis = facesZ ? across : up;
    const vAxis = facesZ ? up : across;
    const anchor = new THREE.Vector3(this.faceCx, this.faceMidY, this.faceCz);
    anchor.addScaledVector(n, this.part.topZ - n.dot(anchor));
    return {
      origin: anchor.addScaledVector(uAxis, u).addScaledVector(vAxis, v),
      uAxis,
      vAxis,
      normal: n.clone(),
      offChartMM: Infinity,
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
