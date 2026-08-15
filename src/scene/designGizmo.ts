import * as THREE from 'three';
import { state } from '../state/store';
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

/**
 * Read a design token as a three.js colour.
 *
 * The gizmo is chrome drawn into the viewport, so its colours are the app's, not the scene's —
 * taking them from the same custom properties the panels use means there is one value, not a hex
 * copied into TypeScript that drifts when the palette moves. Falls back when there is no
 * stylesheet (jsdom), where nothing is rendered anyway.
 */
function tokenColor(name: string, fallback: number): number {
  const raw =
    typeof getComputedStyle === 'function'
      ? getComputedStyle(document.documentElement).getPropertyValue(name).trim()
      : '';
  return raw ? new THREE.Color(raw).getHex() : fallback;
}

/**
 * Selection is a light outline, in no accent hue at all — convention 19 of
 * docs/ui-conventions.md. The frame used to be accent blue, over artwork that is frequently also
 * blue, so "this is selected" and "this region prints blue" were the same signal in an app whose
 * entire subject is which colour goes where.
 *
 * **A dark/light pair was tried first and measured worse.** The idea was `--text` line against
 * `--bg` corner handles, on the reasoning that no filament is both at once so one half would
 * always have contrast. It does not hold, because the two are not over the same thing: the line
 * crosses the artwork, while the handles sit at the design's corners, which for a fitted design
 * are usually just *off* the part and over the viewport. Sampled from the rendered frames, `--bg`
 * handles against the `#05070d` stage measured **1.06:1** — less visible than the system's own
 * disabled state, on a live drag target. Light throughout is worse nowhere and much better there.
 *
 * What that leaves open, and it is real: `--text` over the default body `#b9c0c6` is **1.50:1**,
 * so the frame is faint where it crosses a light part or a light design. Convention 19 offers
 * three mechanisms and this uses one of them; the one that would fix this case is "contrast
 * against dimmed surroundings", which is a change to the model's materials rather than the
 * gizmo's. Written up in docs/tech-debt.md rather than guessed at here.
 *
 * The rotate handle keeps a hue of its own. That is not selection — it is one control among
 * several, and convention 14 wants the manipulation affordances telling themselves apart. It was
 * `0x54d98c`, a green matching no token; `--accent-2` is the real one nearest it.
 */
let FRAME_COLOR = 0xf5f7fb;
let HANDLE_COLOR = 0xf5f7fb;
let ROTATE_COLOR = 0x5eead4;
/**
 * Frame colour once the design center has left the surface — see FaceFrame.offSurfaceMM. Amber
 * rather than a muted grey: the parts render grey, so a desaturated "inactive" frame is the one
 * thing that cannot be seen against them, and this state is a warning, not a de-emphasis.
 */
const OFF_SURFACE_COLOR = 0xe0a33a;
/**
 * How far off the surface the design center may sit before the frame is drawn as off-surface. The
 * in-chart value is 0 to within float noise, and a legitimate design center can sit a couple of mm
 * outside inside a small hole, so this only has to clear rounding.
 */
const OFF_SURFACE_TOL_MM = 5;

/**
 * Samples per frame edge. The outline is traced along the surface rather than drawn as a flat
 * rectangle, so each edge needs enough points to show the curvature: 16 keeps the chair's flank
 * smooth at 64 surface queries per redraw, against a lookup that already runs per cutter vertex
 * during a build.
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
  // Resolved here rather than at module scope so the stylesheet is certainly applied by the time
  // the custom properties are read.
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
    invalidate(); // hiding the gizmo is itself a visible change
    return;
  }
  drawOverlay(currentFrame, restPose(currentFrame));
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
  const facing = toCam.dot(currentFrame.normal) > 0;
  // Only the flip is a visible change. This runs on every OrbitControls 'change' event, and
  // those keep firing after a pan (see the note on prevCamPos in viewport.ts) — invalidating
  // unconditionally would pin the render loop on forever, which is the thing that loop exists
  // to avoid. refreshGizmo()'s own drawOverlay() invalidates for the redraw case.
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
 * The frame outline in world space, in draw order: each edge walked from its own corner toward the
 * next in EDGE_SAMPLES steps, so index `i * EDGE_SAMPLES` is corner `i` and consecutive edges share
 * their endpoints. Every point is its own surface query — this is the frame's real shape, which is
 * why both the renderer and the move hit-test go through it.
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
 * Draw the frame, its corner handles and the rotate arm.
 *
 * The outline is traced ON the surface — every point is its own `pointAt` query in the same (u, v)
 * space the cut is placed in — rather than being drawn as a flat rectangle spanned by the tangent
 * axes. On a curved zone those two are not close: on the chair's flank a tangent rectangle's
 * corners leave the part by 110mm at 300mm across, which is why the frame used to read as hanging
 * in space beside the chair rather than lying on it. The rotate handle is the one thing still
 * placed off the surface, since it is deliberately a grab target out beyond the edge.
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

  // Rotate handle sits off the top edge (mid of the +v side): from the surface point at that edge,
  // straight out along the rotated +v direction. Extending it through `at` instead would wrap it
  // around whatever the surface does past the frame, which is not a stable place to grab.
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

  // Off the surface the frame is drawn around a snapped-to-nearest point that isn't where the
  // artwork will be cut, so say so rather than showing it in the confident colour. Asked of the
  // design's LIVE center: `frame` is captured at pointerdown and keeps reporting where the design
  // started, so reading its own value would stay silent through the one gesture — dragging the
  // design off the part — that this warning exists for. Budgeted at the tolerance, since past that
  // the exact distance changes nothing.
  const offMM =
    dU === 0 && dV === 0 ? frame.offSurfaceMM : frame.offSurfaceAt(dU, dV, OFF_SURFACE_TOL_MM);
  const off = offMM > OFF_SURFACE_TOL_MM;
  // Line and handles move together, in both states: at rest they are both `--text` (see
  // FRAME_COLOR), and off-surface they both take amber — that is a warning rather than a
  // selection, and it wants to read as one thing gone wrong, not as a frame with a second colour
  // in it.
  (frameLine.material as THREE.LineBasicMaterial).color.setHex(
    off ? OFF_SURFACE_COLOR : FRAME_COLOR,
  );
  for (const h of cornerHandles) {
    (h.material as THREE.MeshBasicMaterial).color.setHex(off ? OFF_SURFACE_COLOR : HANDLE_COLOR);
  }

  // The overlay is written straight into its buffers here, bypassing everything in viewport.ts that
  // would otherwise mark the frame dirty. On a heavy model a drag deliberately does NOT rebuild
  // until release (see onPointerMove), so this is the only thing redrawing the gizmo for the whole
  // gesture — without it the frame freezes under the pointer.
  invalidate();
}

/**
 * Whether the pointer landed inside the frame as *drawn*, rather than inside the flat rectangle
 * spanned by the tangent axes. Since the outline is traced on the surface those two are not the
 * same region on a curved zone — on the chair's flank they diverge by up to 110mm at 300mm across,
 * which let clicks well outside the visible frame start a move, and made clicks inside it near a
 * receding edge orbit the camera instead.
 *
 * Tested in screen space against the projected outline: the overlay draws with depthTest off and
 * only while the face points at the camera, so the polygon the user sees is exactly this one, and
 * point-in-polygon needs no assumption about the surface being convex or single-valued in depth.
 */
function insideFrame(frame: FaceFrame, ndc: THREE.Vector2): boolean {
  const cam = getCamera();
  const pts = outlinePoints(frame, restPose(frame));
  const poly: THREE.Vector2[] = [];
  const scratch = new THREE.Vector3();
  for (const p of pts) {
    // A point behind the eye projects mirrored, which would corrupt the winding. No view that has
    // the frame facing the camera puts one there, so treat it as a miss rather than guess.
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
    // Shift the whole frame by the drag delta; `at` re-queries the surface, so the outline keeps
    // following the part as it travels rather than sliding along the plane it started on.
    pose.dU = state.offsetX - f.offsetX;
    pose.dV = state.offsetY - f.offsetY;
  } else if (drag.mode === 'scale') {
    const dist = Math.hypot(du, dv);
    const ratio = drag.startDist > 1e-3 ? dist / drag.startDist : 1;
    state.scalePct = Math.min(Math.max(drag.startScalePct * ratio, SCALE_MIN), SCALE_MAX);
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
