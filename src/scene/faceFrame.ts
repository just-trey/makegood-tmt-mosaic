import * as THREE from 'three';
import { state } from '../state/store';
import { currentBaseParams } from '../state/store';
import { currentAssemblyKind } from '../assembly/kinds';
import { implicitZoneFor } from '../geometry/zones';
import { getModelGroup } from './viewport';

/**
 * Everything the on-face design gizmo needs to translate between the viewport and the placement
 * parameters (offsetX/offsetY/scalePct/rotationDeg). It describes the design's current pose on the
 * face in *world* space, plus the in-plane axes those two offsets move along.
 *
 * The axes are deliberately read off the SAME conventions the geometry build uses so a drag maps
 * 1:1 to what the recut produces: in both modes `offsetX` moves the design along world +X; in flat
 * mode `offsetY` is world +Y (plate top), in assembly mode it is world +Z (the part stands up along
 * Y and its design face is a Y-plane). The origin folds in `getModelGroup().position`, since the
 * assembly is lifted to rest on the grid after each rebuild.
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
  const mg = getModelGroup().position;
  return {
    origin: new THREE.Vector3(state.offsetX + mg.x, state.offsetY + mg.y, bp.thickness + mg.z),
    uAxis: new THREE.Vector3(1, 0, 0),
    vAxis: new THREE.Vector3(0, 1, 0),
    normal: new THREE.Vector3(0, 0, 1),
    halfW: (svgW * scale) / 2,
    halfH: (svgH * scale) / 2,
    offsetX: state.offsetX,
    offsetY: state.offsetY,
    scalePct: state.scalePct,
    rotationDeg: state.rotationDeg,
  };
}

function assemblyFrame(): FaceFrame | null {
  const parts = state.assembly.parts;
  const primary = parts.find((p) => p.loaded && !p.isDuplicateOf && p.boundaryLoop && p.positions);
  if (!primary) return null;

  const isRect = currentAssemblyKind()?.designFit === 'rect';
  // The same mapper the build uses — its frameAt() carries the face direction, face-plane Y, and
  // (for rect) the face-center anchor, so the gizmo and the cut can't drift apart.
  const mapper = implicitZoneFor(primary, parts, isRect);
  if (!mapper.faceNormal) return null;

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

  // frameAt returns the design center in the part's native space; the assembly is lifted to rest
  // on the grid after each rebuild, so fold in the model-group offset here.
  const frame = mapper.frameAt(state.offsetX, state.offsetY);
  const mg = getModelGroup().position;
  return {
    origin: frame.origin.add(mg),
    uAxis: frame.uAxis,
    vAxis: frame.vAxis,
    normal: frame.normal,
    halfW: (svgW * mmPerUnit) / 2,
    halfH: (svgH * mmPerUnit) / 2,
    offsetX: state.offsetX,
    offsetY: state.offsetY,
    scalePct: state.scalePct,
    rotationDeg: state.rotationDeg,
  };
}
