import * as THREE from 'three';
import { SCALE_MAX_PCT, SCALE_MIN_PCT, state } from '../state/store';
import { scheduleRebuild, isRebuildLikelySlow } from '../app/scheduler';
import {
  addSceneOverlay,
  getCamera,
  getControls,
  getDomElement,
  invalidate,
  pointerToNDC,
  setInteracting,
} from './viewport';
import { computeFaceFrame, type FaceFrame } from './faceFrame';
import { track } from '../analytics/track';

type DragMode = 'move' | 'scale' | 'rotate';

interface DragState {
  mode: DragMode;
  plane: THREE.Plane;
  frame: FaceFrame;
  grabU: number;
  grabV: number;
  startOffsetX: number;
  startOffsetY: number;
  startScalePct: number;
  startRotationDeg: number;
  startDist: number;
  startAng: number;
  pointerId: number;
}

let overlay: THREE.Group | null = null;
let frameLine: THREE.LineLoop;
let rotateArm: THREE.Line;
const cornerHandles: THREE.Mesh[] = [];
let rotateHandle: THREE.Mesh;
const raycaster = new THREE.Raycaster();
let drag: DragState | null = null;
// Cached so the facing check can run on orbit (no rebuild) without recomputing every mouse-move.
let currentFrame: FaceFrame | null = null;

/**
 * A design token as a three.js colour: the gizmo is app chrome, so one value, not a drifting hex
 * copy. Falls back with no stylesheet (jsdom), where nothing renders.
 */
export function tokenColor(name: string, fallback: number): number {
  const raw =
    typeof getComputedStyle === 'function'
      ? getComputedStyle(document.documentElement).getPropertyValue(name).trim()
      : '';
  return raw ? new THREE.Color(raw).getHex() : fallback;
}

/**
 * Selection is a light outline in no accent hue (docs/ui-conventions.md convention 19): accent
 * blue over blue artwork read as "prints blue". A `--text` line / `--bg` handles pair measured
 * worse: handles sit just off the part, at **1.06:1** against the `#05070d` stage.
 *
 * Known gap: `--text` over the default body `#b9c0c6` is **1.50:1**, faint on light parts. The fix
 * (dimming surroundings) changes model materials and risks convention 20's grey collision — a
 * decision, not a tweak. Convention 21 is also unmet: OFF_SURFACE_COLOR differs by hue alone.
 * The rotate handle is a control, not selection, so it keeps a hue (convention 14): `--accent-2`,
 * nearest the old untokened `0x54d98c`.
 */
let FRAME_COLOR = 0xf5f7fb;
let HANDLE_COLOR = 0xf5f7fb;
let ROTATE_COLOR = 0x5eead4;
/** Off-surface frame (FaceFrame.offSurfaceMM): amber, a warning; a muted grey vanishes on grey parts. */
const OFF_SURFACE_COLOR = 0xe0a33a;
/**
 * Off-surface threshold: in-chart is 0 to float noise, and a legitimate center can sit a couple of
 * mm out inside a small hole, so this only has to clear rounding.
 */
const OFF_SURFACE_TOL_MM = 5;

/**
 * Samples per surface-traced edge: 16 keeps the chair's flank smooth at 64 queries per redraw, a
 * lookup that already runs per cutter vertex in a build.
 */
const EDGE_SAMPLES = 16;
const OUTLINE_POINTS = EDGE_SAMPLES * 4;

/** Frame corners in local (pre-rotation) half-extent units, counter-clockwise from (−u, −v). */
const CORNER_SIGNS: [number, number][] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

function overlayMaterial(color: number): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color,
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });
}
function handleMaterial(color: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });
}

/** A BufferGeometry with a fixed-size position attribute we rewrite in place each redraw. */
function overlayGeometry(pointCount: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pointCount * 3), 3));
  return g;
}

export function initDesignGizmo(): void {
  // Not at module scope: the stylesheet must be applied first.
  FRAME_COLOR = tokenColor('--text', FRAME_COLOR);
  HANDLE_COLOR = tokenColor('--text', HANDLE_COLOR);
  ROTATE_COLOR = tokenColor('--accent-2', ROTATE_COLOR);

  overlay = new THREE.Group();
  overlay.renderOrder = 999; // draw on top of the model
  overlay.visible = false;

  frameLine = new THREE.LineLoop(overlayGeometry(OUTLINE_POINTS), overlayMaterial(FRAME_COLOR));
  frameLine.renderOrder = 999;
  overlay.add(frameLine);

  rotateArm = new THREE.Line(overlayGeometry(2), overlayMaterial(ROTATE_COLOR));
  rotateArm.renderOrder = 999;
  overlay.add(rotateArm);

  const box = new THREE.BoxGeometry(1, 1, 1);
  for (let i = 0; i < 4; i++) {
    const h = new THREE.Mesh(box, handleMaterial(HANDLE_COLOR));
    h.renderOrder = 1000;
    h.userData.kind = 'scale';
    cornerHandles.push(h);
    overlay.add(h);
  }
  rotateHandle = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), handleMaterial(ROTATE_COLOR));
  rotateHandle.renderOrder = 1000;
  rotateHandle.userData.kind = 'rotate';
  overlay.add(rotateHandle);

  // Buffers are rewritten in place, so a stale bounding volume could wrongly cull it.
  overlay.traverse((o) => {
    o.frustumCulled = false;
  });

  addSceneOverlay(overlay);

  const dom = getDomElement();
  dom.addEventListener('pointerdown', onPointerDown);
  dom.addEventListener('pointermove', onPointerMove);
  dom.addEventListener('pointerup', onPointerUp);
  dom.addEventListener('pointercancel', onPointerUp);
  // Orbiting fires no rebuild, so re-check facing on every camera change.
  getControls().addEventListener('change', updateFacing);

  refreshGizmo();
}

/**
 * Read by zonePick.ts so a gizmo drag isn't also a zone pick. Valid only synchronously in the same
 * pointerdown tick (main.ts registers this module's listener first).
 */
export function isGizmoDragging(): boolean {
  return !!drag;
}

/** Redraw from state after a rebuild or fit change; a no-op mid-drag so it doesn't fight the pointer. */
export function refreshGizmo(): void {
  if (!overlay || drag) return;
  currentFrame = computeFaceFrame();
  if (!currentFrame) {
    overlay.visible = false;
    invalidate(); // hiding the gizmo is itself a visible change
    return;
  }
  drawOverlay(currentFrame, restPose(currentFrame));
  updateFacing();
}

/**
 * Show only when the face points at the camera: with depthTest off it would otherwise draw, and be
 * grabbed, through the part. Hidden, pointerdown's `!overlay.visible` guard hands clicks to orbit.
 */
function updateFacing(): void {
  if (!overlay || drag || !currentFrame) return;
  const toCam = getCamera().position.clone().sub(currentFrame.origin);
  const facing = toCam.dot(currentFrame.normal) > 0;
  // Invalidate only on a flip: 'change' keeps firing after a pan (prevCamPos in viewport.ts), so
  // always invalidating would pin the render loop on.
  if (facing === overlay.visible) return;
  overlay.visible = facing;
  invalidate();
}

/** Where the design sits relative to the frame's own center, and how big it is drawn. */
interface OverlayPose {
  /** design-center displacement from `frame`'s center, in on-face mm (non-zero only mid-move) */
  dU: number;
  dV: number;
  halfW: number;
  halfH: number;
  rotDeg: number;
}

/** The pose a frame is drawn at when nothing is being dragged. */
function restPose(frame: FaceFrame): OverlayPose {
  return { dU: 0, dV: 0, halfW: frame.halfW, halfH: frame.halfH, rotDeg: frame.rotationDeg };
}

/** Surface point for a local, pre-rotation on-face offset within `pose`. */
function poseSampler(
  frame: FaceFrame,
  pose: OverlayPose,
): (lu: number, lv: number) => THREE.Vector3 {
  const r = (pose.rotDeg * Math.PI) / 180,
    c = Math.cos(r),
    s = Math.sin(r);
  return (lu, lv) => frame.pointAt(pose.dU + lu * c - lv * s, pose.dV + lu * s + lv * c);
}

/**
 * The world-space outline: index `i * EDGE_SAMPLES` is corner `i`. Each point is a surface query —
 * the frame's real shape — so the renderer and the move hit-test both use it.
 */
function outlinePoints(frame: FaceFrame, pose: OverlayPose): THREE.Vector3[] {
  const at = poseSampler(frame, pose);
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < 4; i++) {
    const [su, sv] = CORNER_SIGNS[i];
    const [nu, nv] = CORNER_SIGNS[(i + 1) % 4];
    for (let k = 0; k < EDGE_SAMPLES; k++) {
      const t = k / EDGE_SAMPLES;
      pts.push(at((su + (nu - su) * t) * pose.halfW, (sv + (nv - sv) * t) * pose.halfH));
    }
  }
  return pts;
}

/**
 * Draw the frame traced ON the surface in the cut's (u, v) space, not a tangent rectangle: on the
 * chair's flank its corners leave the part by 110mm at 300mm across. Only the rotate handle sits
 * off the surface, deliberately, as a grab target beyond the edge.
 */
function drawOverlay(frame: FaceFrame, pose: OverlayPose): void {
  const { dU, dV, halfW, halfH, rotDeg } = pose;
  const handleSize = Math.min(Math.max(Math.max(halfW, halfH) * 0.08, 1.5), 8);
  const armLen = Math.max(Math.max(halfW, halfH) * 0.35, handleSize * 3);
  const at = poseSampler(frame, pose);

  const pts = outlinePoints(frame, pose);
  const framePos = frameLine.geometry.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pts.length; i++) framePos.setXYZ(i, pts[i].x, pts[i].y, pts[i].z);
  framePos.needsUpdate = true;
  for (let i = 0; i < 4; i++) {
    // each edge walk starts at its own corner, so that sample IS the corner
    cornerHandles[i].position.copy(pts[i * EDGE_SAMPLES]);
    cornerHandles[i].scale.setScalar(handleSize);
  }

  // Straight out along rotated +v from the top edge: via `at` it would wrap with the surface past
  // the frame, not a stable grab target.
  const topMid = at(0, halfH);
  const r = (rotDeg * Math.PI) / 180;
  const outward = frame.uAxis
    .clone()
    .multiplyScalar(-Math.sin(r))
    .addScaledVector(frame.vAxis, Math.cos(r))
    .normalize();
  const rotPos = topMid.clone().addScaledVector(outward, armLen);
  rotateHandle.position.copy(rotPos);
  rotateHandle.scale.setScalar(handleSize);
  const armPos = rotateArm.geometry.attributes.position as THREE.BufferAttribute;
  armPos.setXYZ(0, topMid.x, topMid.y, topMid.z);
  armPos.setXYZ(1, rotPos.x, rotPos.y, rotPos.z);
  armPos.needsUpdate = true;

  // Off the surface the frame snaps to a point the cut won't use, so warn. Ask the LIVE center:
  // `frame` is from pointerdown, so its own value stays silent while dragging off the part.
  // Budgeted at the tolerance, past which the distance changes nothing.
  const offMM =
    dU === 0 && dV === 0 ? frame.offSurfaceMM : frame.offSurfaceAt(dU, dV, OFF_SURFACE_TOL_MM);
  const off = offMM > OFF_SURFACE_TOL_MM;
  // Line and handles change together, so amber reads as one thing gone wrong.
  (frameLine.material as THREE.LineBasicMaterial).color.setHex(
    off ? OFF_SURFACE_COLOR : FRAME_COLOR,
  );
  for (const h of cornerHandles) {
    (h.material as THREE.MeshBasicMaterial).color.setHex(off ? OFF_SURFACE_COLOR : HANDLE_COLOR);
  }

  // Direct buffer writes bypass viewport.ts's dirty marking, and a heavy-model drag doesn't rebuild
  // until release, so without this the frame freezes under the pointer.
  invalidate();
}

/**
 * Inside the frame as *drawn*, not the tangent rectangle (up to 110mm apart at 300mm across on the
 * chair's flank). Screen-space point-in-polygon: with depthTest off and only while facing, this is
 * exactly what the user sees, with no convexity or depth assumption.
 */
function insideFrame(frame: FaceFrame, ndc: THREE.Vector2): boolean {
  const cam = getCamera();
  const pts = outlinePoints(frame, restPose(frame));
  const poly: THREE.Vector2[] = [];
  const scratch = new THREE.Vector3();
  for (const p of pts) {
    // Behind the eye projects mirrored; no facing view puts one there, so call it a miss.
    if (scratch.copy(p).applyMatrix4(cam.matrixWorldInverse).z > -cam.near) return false;
    const q = scratch.copy(p).project(cam);
    poly.push(new THREE.Vector2(q.x, q.y));
  }
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (a.y > ndc.y !== b.y > ndc.y && ndc.x < ((b.x - a.x) * (ndc.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function onPointerDown(e: PointerEvent): void {
  if (!overlay || !overlay.visible || e.button !== 0) return;
  const f = computeFaceFrame();
  if (!f) return;

  raycaster.setFromCamera(pointerToNDC(e), getCamera());

  let mode: DragMode | null = null;
  if (raycaster.intersectObject(rotateHandle, false).length) mode = 'rotate';
  else if (raycaster.intersectObjects(cornerHandles, false).length) mode = 'scale';

  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(f.normal, f.origin);
  const hit = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
  if (!hit) return;
  const du = hit.clone().sub(f.origin).dot(f.uAxis);
  const dv = hit.clone().sub(f.origin).dot(f.vAxis);

  // No handle hit — treat as a move only if the click landed inside the frame as drawn.
  if (!mode && insideFrame(f, pointerToNDC(e))) mode = 'move';
  if (!mode) return; // let OrbitControls handle the orbit

  drag = {
    mode,
    plane,
    frame: f,
    grabU: du,
    grabV: dv,
    startOffsetX: state.offsetX,
    startOffsetY: state.offsetY,
    startScalePct: state.scalePct,
    startRotationDeg: state.rotationDeg,
    startDist: Math.hypot(du, dv),
    startAng: Math.atan2(dv, du),
    pointerId: e.pointerId,
  };
  getControls().enabled = false;
  setInteracting(true);
  getDomElement().setPointerCapture(e.pointerId);
  e.preventDefault();
}

function onPointerMove(e: PointerEvent): void {
  if (!drag || e.pointerId !== drag.pointerId) return;
  raycaster.setFromCamera(pointerToNDC(e), getCamera());
  const hit = raycaster.ray.intersectPlane(drag.plane, new THREE.Vector3());
  if (!hit) return;
  const f = drag.frame;
  const du = hit.clone().sub(f.origin).dot(f.uAxis);
  const dv = hit.clone().sub(f.origin).dot(f.vAxis);

  const pose = { dU: 0, dV: 0, halfW: f.halfW, halfH: f.halfH, rotDeg: state.rotationDeg };
  if (drag.mode === 'move') {
    state.offsetX = drag.startOffsetX + (du - drag.grabU);
    state.offsetY = drag.startOffsetY + (dv - drag.grabV);
    // `at` re-queries the surface, so the outline follows the part, not the starting plane.
    pose.dU = state.offsetX - f.offsetX;
    pose.dV = state.offsetY - f.offsetY;
  } else if (drag.mode === 'scale') {
    const dist = Math.hypot(du, dv);
    const ratio = drag.startDist > 1e-3 ? dist / drag.startDist : 1;
    state.scalePct = Math.min(Math.max(drag.startScalePct * ratio, SCALE_MIN_PCT), SCALE_MAX_PCT);
    const k = state.scalePct / f.scalePct;
    pose.halfW = f.halfW * k;
    pose.halfH = f.halfH * k;
  } else {
    const ang = Math.atan2(dv, du);
    let deg = drag.startRotationDeg + ((ang - drag.startAng) * 180) / Math.PI;
    deg = ((deg % 360) + 360) % 360; // [0, 360)
    if (deg > 180) deg -= 360; // wrap to (−180, 180] — keeps +180 as +180, not −180
    state.rotationDeg = deg;
    pose.rotDeg = deg;
  }
  drawOverlay(f, pose);

  syncFitInputs();
  // Light models can recut live; heavy ones (all assemblies) wait for release below.
  if (!isRebuildLikelySlow()) scheduleRebuild();
}

function onPointerUp(e: PointerEvent): void {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const dom = getDomElement();
  if (dom.hasPointerCapture(e.pointerId)) dom.releasePointerCapture(e.pointerId);
  const field = drag.mode;
  drag = null;
  getControls().enabled = true;
  setInteracting(false);
  syncFitInputs();
  scheduleRebuild();
  track('fit_adjust', { via: 'drag', field });
}

/**
 * Mirror drag values into the fit inputs, snapped to each step (scale/rotation 1, offset 0.5) so
 * range and number field can't disagree. A missing control is a no-op.
 */
function syncFitInputs(): void {
  const scale = Math.round(state.scalePct);
  setInput('p-scale', scale);
  setInput('p-scale-num', scale);
  const ox = roundTo(state.offsetX, 0.5);
  setInput('p-offset-x', ox);
  setInput('p-offset-x-slider', ox);
  const oy = roundTo(state.offsetY, 0.5);
  setInput('p-offset-y', oy);
  setInput('p-offset-y-slider', oy);
  const rot = Math.round(state.rotationDeg);
  setInput('p-rot', rot);
  setInput('p-rot-num', rot);
}

function setInput(id: string, value: number): void {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (el) el.value = String(value);
}

function roundTo(v: number, step: number): number {
  return Math.round(v / step) * step;
}
