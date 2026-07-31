import * as THREE from 'three';
import { state } from '../state/store';
import { currentBaseParams } from '../state/store';
import { currentAssemblyKind } from '../assembly/kinds';
import { primaryZoneMapper, zoneMappersFor } from '../geometry/zoneMappers';
import type { ZoneMapper } from '../geometry/zones';
import { activeArtworkInstance } from '../state/artwork';
import type { AssemblyPart } from '../types';
import { modelToWorldDir, modelToWorldPoint } from './viewport';

/**
 * Everything the on-face design gizmo needs to translate between the viewport and the placement
 * parameters (offsetX/offsetY/scalePct/rotationDeg). It describes the design's current pose on the
 * face in *world* space, plus the in-plane axes those two offsets move along.
 *
 * The axes are deliberately read off the SAME conventions the geometry build uses so a drag maps
 * 1:1 to what the recut produces. Everything here is in WORLD space: the mappers work in the
 * part's native frame, so both the origin and the axes are pushed through the model group's
 * transform (the grid lift, plus the display rotation for a kind that authors a display frame).
 */
export interface FaceFrame {
  /** world position of the design center (where the SVG anchor lands) */
  origin: THREE.Vector3;
  /** unit world vector the +offsetX slider moves the design along */
  uAxis: THREE.Vector3;
  /** unit world vector the +offsetY slider moves the design along */
  vAxis: THREE.Vector3;
  /** unit plane normal (for raycasting the face) */
  normal: THREE.Vector3;
  /** half the design's on-face width along u, in mm, at the current scale (pre-rotation) */
  halfW: number;
  /** half the design's on-face height along v, in mm, at the current scale (pre-rotation) */
  halfH: number;
  offsetX: number;
  offsetY: number;
  scalePct: number;
  rotationDeg: number;
}

/**
 * Build the face frame from current state, or null when there is nothing to manipulate (no
 * artwork, or an assembly with no loaded primary part). Recomputed on every gizmo refresh so it
 * tracks state edits, part changes, and the post-rebuild grid offset.
 */
export function computeFaceFrame(): FaceFrame | null {
  if (!state.parsed) return null;
  return state.shapeKind === 'assembly' ? assemblyFrame() : flatFrame();
}

function flatFrame(): FaceFrame | null {
  const bp = currentBaseParams();
  if (!bp) return null;
  const bbox = state.parsed!.bbox;
  const svgW = bbox.maxX - bbox.minX,
    svgH = bbox.maxY - bbox.minY;
  if (!(svgW > 0) || !(svgH > 0)) return null;
  const footW = state.shapeKind === 'disc' ? bp.diameter || 0 : bp.width || 0;
  const footH = state.shapeKind === 'disc' ? bp.diameter || 0 : bp.height || 0;
  // mirror fitTransform's auto-fit: margin shrinks the usable footprint on both sides
  const mW = footW * (1 - bp.marginPct / 50),
    mH = footH * (1 - bp.marginPct / 50);
  const autoScale = Math.min(mW / svgW, mH / svgH);
  const scale = autoScale * (state.scalePct / 100);
  // Flat mode never poses the model group, so this is the grid lift alone today — routed through
  // the same helpers as the assembly path so it stays right if that ever changes.
  return {
    origin: modelToWorldPoint(new THREE.Vector3(state.offsetX, state.offsetY, bp.thickness)),
    uAxis: modelToWorldDir(new THREE.Vector3(1, 0, 0)),
    vAxis: modelToWorldDir(new THREE.Vector3(0, 1, 0)),
    normal: modelToWorldDir(new THREE.Vector3(0, 0, 1)),
    halfW: (svgW * scale) / 2,
    halfH: (svgH * scale) / 2,
    offsetX: state.offsetX,
    offsetY: state.offsetY,
    scalePct: state.scalePct,
    rotationDeg: state.rotationDeg,
  };
}

/**
 * The mapper the gizmo sits on: the one that will actually cut the *active* artwork. On a multi-zone
 * part the zone the active instance is bound to is the only correct answer — falling back to the
 * part's first zone (as this used to) leaves the gizmo on an unrelated surface, where it reads as
 * stuck at an angle and every drag edits a face the user isn't looking at. Unbound artwork, and any
 * kind with no zone sidecar, still resolve through primaryZoneMapper unchanged.
 */
function gizmoMapper(parts: AssemblyPart[], isRect: boolean): ZoneMapper | null {
  const zoneId = activeArtworkInstance()?.zone?.zoneId;
  if (zoneId) {
    const owner = parts.find(
      (p) => p.loaded && !p.isDuplicateOf && p.zones?.some((z) => z.id === zoneId),
    );
    const bound = owner
      ? zoneMappersFor(owner, parts, isRect, null).find((m) => m.zoneId === zoneId)
      : undefined;
    if (bound) return bound;
  }
  // A part of a zoned kind only counts once its zones have resolved and at least one takes
  // artwork — a structural piece (no baked zone) has nothing for the gizmo to sit on.
  const primary = parts.find(
    (p) =>
      p.loaded && !p.isDuplicateOf && p.boundaryLoop && p.positions && (!p.zones || p.zones.length),
  );
  return primary ? primaryZoneMapper(primary, parts, isRect) : null;
}

function assemblyFrame(): FaceFrame | null {
  const parts = state.assembly.parts;
  const isRect = currentAssemblyKind()?.designFit === 'rect';
  // The same mapper the build uses — its frameAt() carries the face direction, face-plane Y or UV
  // chart, and (for rect) the face-center anchor, so the gizmo and the cut can't drift apart.
  const mapper = gizmoMapper(parts, isRect);
  if (!mapper || !mapper.faceNormal) return null;

  const bbox = state.parsed!.bbox;
  const svgW = bbox.maxX - bbox.minX,
    svgH = bbox.maxY - bbox.minY;
  if (!(svgW > 0) || !(svgH > 0)) return null;
  // Same mmPerUnit the build uses. The rect auto-fit-to-face fallback (userUnitMM null) is only
  // approximated here for frame *sizing*; the scale gesture is ratio-based so it stays correct
  // regardless, and the true size is restored on the next rebuild.
  const scaleMult = state.scalePct / 100;
  let mmPerUnit: number;
  if (isRect) {
    mmPerUnit = (state.parsed!.userUnitMM ?? 1) * scaleMult;
  } else {
    const svgR = state.parsed!.rawSVGCircle?.r ?? (Math.max(svgW, svgH) / 2 || 1);
    mmPerUnit = ((state.asmRadius || 138) / svgR) * scaleMult;
  }

  // frameAt returns the design center and axes in the part's NATIVE space; the model group is both
  // lifted onto the grid and (for a kind with a display frame) rotated, so the whole frame has to
  // come through that transform — the origin as a point, the axes as directions.
  const frame = mapper.frameAt(state.offsetX, state.offsetY);
  return {
    origin: modelToWorldPoint(frame.origin),
    uAxis: modelToWorldDir(frame.uAxis),
    vAxis: modelToWorldDir(frame.vAxis),
    normal: modelToWorldDir(frame.normal),
    halfW: (svgW * mmPerUnit) / 2,
    halfH: (svgH * mmPerUnit) / 2,
    offsetX: state.offsetX,
    offsetY: state.offsetY,
    scalePct: state.scalePct,
    rotationDeg: state.rotationDeg,
  };
}
