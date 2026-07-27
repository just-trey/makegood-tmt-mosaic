import * as THREE from 'three';
import { state } from '../state/store';
import { scheduleRebuild, isRebuildLikelySlow } from '../app/scheduler';
import {
  addSceneOverlay,
  getCamera,
  getControls,
  getDomElement,
  pointerToNDC,
  setInteracting,
} from './viewport';
import { computeFaceFrame, type FaceFrame } from './faceFrame';
import { track } from '../analytics/track';

// Scale is a clamped slider pair (25–400%) — keep gizmo drags inside the same range so the thumb
// and the value never disagree.
const SCALE_MIN = 25;
const SCALE_MAX = 400;

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
// Last computed face frame, kept so the camera-facing visibility check can run on orbit (which
// fires no rebuild) without recomputing the whole frame every mouse-move.
let currentFrame: FaceFrame | null = null;

const FRAME_COLOR = 0x4ea1ff;
const HANDLE_COLOR = 0x4ea1ff;
const ROTATE_COLOR = 0x54d98c;

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
  overlay = new THREE.Group();
  overlay.renderOrder = 999; // draw on top of the model
  overlay.visible = false;

  frameLine = new THREE.LineLoop(overlayGeometry(4), overlayMaterial(FRAME_COLOR));
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

  // The overlay moves every redraw and we update position buffers in place; skip frustum culling
  // so a stale bounding volume can never wrongly cull it.
  overlay.traverse((o) => {
    o.frustumCulled = false;
  });

  addSceneOverlay(overlay);

  const dom = getDomElement();
  dom.addEventListener('pointerdown', onPointerDown);
  dom.addEventListener('pointermove', onPointerMove);
  dom.addEventListener('pointerup', onPointerUp);
  dom.addEventListener('pointercancel', onPointerUp);
  // Orbiting fires no rebuild, so re-evaluate which way the face points on every camera change to
  // hide the gizmo when the design face turns away from the viewer.
  getControls().addEventListener('change', updateFacing);

  refreshGizmo();
}

/**
 * Whether a gizmo drag is currently in progress — checked by zonePick.ts so a drag that starts on
 * the gizmo (move/scale/rotate the active artwork) never also gets read as a zone-pick click. Only
 * meaningful when checked synchronously within the same pointerdown tick this module's own
 * handler ran in (registration order in main.ts puts this module's listener first).
 */
export function isGizmoDragging(): boolean {
  return !!drag;
}

/**
 * Rebuild the gizmo overlay from current state. Called after every rebuild and whenever the fit
 * controls change; a no-op mid-drag so it doesn't fight the pointer.
 */
export function refreshGizmo(): void {
  if (!overlay || drag) return;
  currentFrame = computeFaceFrame();
  if (!currentFrame) {
    overlay.visible = false;
    return;
  }
  drawOverlay(
    currentFrame.origin,
    currentFrame.uAxis,
    currentFrame.vAxis,
    currentFrame.halfW,
    currentFrame.halfH,
    currentFrame.rotationDeg,
  );
  updateFacing();
}

/**
 * Show the gizmo only when the design face points toward the camera. The overlay draws with
 * depthTest off (so it's never occluded by the part on the near side), which without this check
 * would also let it draw — and be grabbed — through the part when the face is turned away. The
 * shared pointerdown guard (`!overlay.visible`) then hands those clicks back to OrbitControls.
 */
function updateFacing(): void {
  if (!overlay || drag || !currentFrame) return;
  const toCam = getCamera().position.clone().sub(currentFrame.origin);
  overlay.visible = toCam.dot(currentFrame.normal) > 0;
}

/** Local (u,v) corner offset for sign su,sv in {−1,+1}, rotated by rotationDeg. */
function rotUV(
  su: number,
  sv: number,
  halfW: number,
  halfH: number,
  rotDeg: number,
): [number, number] {
  const r = (rotDeg * Math.PI) / 180,
    c = Math.cos(r),
    s = Math.sin(r);
  const lu = su * halfW,
    lv = sv * halfH;
  return [lu * c - lv * s, lu * s + lv * c];
}

function worldFromUV(
  origin: THREE.Vector3,
  uAxis: THREE.Vector3,
  vAxis: THREE.Vector3,
  u: number,
  v: number,
): THREE.Vector3 {
  return origin.clone().addScaledVector(uAxis, u).addScaledVector(vAxis, v);
}

function drawOverlay(
  origin: THREE.Vector3,
  uAxis: THREE.Vector3,
  vAxis: THREE.Vector3,
  halfW: number,
  halfH: number,
  rotDeg: number,
): void {
  const handleSize = Math.min(Math.max(Math.max(halfW, halfH) * 0.08, 1.5), 8);
  const armLen = Math.max(Math.max(halfW, halfH) * 0.35, handleSize * 3);

  const signs: [number, number][] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  const framePos = frameLine.geometry.attributes.position as THREE.BufferAttribute;
  const corners = signs.map(([su, sv]) => {
    const [u, v] = rotUV(su, sv, halfW, halfH, rotDeg);
    return worldFromUV(origin, uAxis, vAxis, u, v);
  });
  corners.forEach((c, i) => {
    framePos.setXYZ(i, c.x, c.y, c.z);
    cornerHandles[i].position.copy(c);
    cornerHandles[i].scale.setScalar(handleSize);
  });
  framePos.needsUpdate = true;

  // rotate handle sits off the top edge (mid of the +v side), along the rotated +v direction
  const [tu, tv] = rotUV(0, 1, halfW, halfH, rotDeg);
  const topMid = worldFromUV(origin, uAxis, vAxis, tu, tv);
  const [au, av] = rotUV(0, 1, halfW, halfH + armLen, rotDeg);
  const rotPos = worldFromUV(origin, uAxis, vAxis, au, av);
  rotateHandle.position.copy(rotPos);
  rotateHandle.scale.setScalar(handleSize);
  const armPos = rotateArm.geometry.attributes.position as THREE.BufferAttribute;
  armPos.setXYZ(0, topMid.x, topMid.y, topMid.z);
  armPos.setXYZ(1, rotPos.x, rotPos.y, rotPos.z);
  armPos.needsUpdate = true;
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

  if (!mode) {
    // No handle hit — treat as a move only if the click landed inside the (rotated) frame.
    const r = (-f.rotationDeg * Math.PI) / 180,
      c = Math.cos(r),
      s = Math.sin(r);
    const lu = du * c - dv * s,
      lv = du * s + dv * c;
    if (Math.abs(lu) <= f.halfW && Math.abs(lv) <= f.halfH) mode = 'move';
  }
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

  if (drag.mode === 'move') {
    state.offsetX = drag.startOffsetX + (du - drag.grabU);
    state.offsetY = drag.startOffsetY + (dv - drag.grabV);
    const origin = worldFromUV(
      f.origin,
      f.uAxis,
      f.vAxis,
      state.offsetX - f.offsetX,
      state.offsetY - f.offsetY,
    );
    drawOverlay(origin, f.uAxis, f.vAxis, f.halfW, f.halfH, state.rotationDeg);
  } else if (drag.mode === 'scale') {
    const dist = Math.hypot(du, dv);
    const ratio = drag.startDist > 1e-3 ? dist / drag.startDist : 1;
    state.scalePct = Math.min(Math.max(drag.startScalePct * ratio, SCALE_MIN), SCALE_MAX);
    const k = state.scalePct / f.scalePct;
    drawOverlay(f.origin, f.uAxis, f.vAxis, f.halfW * k, f.halfH * k, state.rotationDeg);
  } else {
    const ang = Math.atan2(dv, du);
    let deg = drag.startRotationDeg + ((ang - drag.startAng) * 180) / Math.PI;
    deg = ((deg % 360) + 360) % 360; // [0, 360)
    if (deg > 180) deg -= 360; // wrap to (−180, 180] — keeps +180 as +180, not −180
    state.rotationDeg = deg;
    drawOverlay(f.origin, f.uAxis, f.vAxis, f.halfW, f.halfH, deg);
  }

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
 * Push the live drag values into the fit-panel inputs so the sliders track the gizmo. Each value
 * is snapped to that control's step (scale/rotation 1, offset 0.5) and the same snapped value goes
 * to both the range thumb and the number field, so the range's own step-coercion can't leave the
 * pair disagreeing. Guarded by id lookups so a missing control is a no-op rather than a throw.
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
