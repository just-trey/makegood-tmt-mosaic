import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

let renderer: THREE.WebGLRenderer;
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let controls: OrbitControls;
let modelGroup = new THREE.Group();
let basePixelRatio = 1;

// Re-frame the camera to fit the current model only when content actually changes (new SVG,
// parts added, shape switched) — so tweaking a depth slider doesn't yank the user's orbit/zoom
// around on every rebuild. `preferredViewDir`, when set, forces the starting view direction
// (assembly mode points it at the design face so the wheel doesn't open showing its blank
// back); otherwise the user's current view direction is kept.
let pendingFrame = true;
let preferredViewDir: THREE.Vector3 | null = null;

/**
 * Whether the next animation frame has anything new to draw. The render loop is on-demand: an
 * always-on `renderer.render()` costs a full frame of work forever, which on a software renderer
 * (headless CI, or any machine without working GPU acceleration) is expensive enough to starve the
 * main thread the boolean rebuilds run on.
 *
 * Every mutation that changes what is on screen must set this. The ones that come through this
 * module set it *inside* the mutator below rather than at each call site, so a new caller in
 * rebuild.ts can't forget to — the failure mode is a viewport that silently keeps showing the
 * previous frame, which no unit test catches. Camera motion is handled separately, by
 * `cameraMovedThisFrame()` in the loop.
 */
let needsRender = true;

/** Mark the scene as changed, so the next animation frame draws it. */
export function invalidate(): void {
  needsRender = true;
}

/**
 * Camera pose as of the previous animation frame, for deciding whether the camera is still moving.
 *
 * Deliberately not `OrbitControls.update()`'s return value: its position and quaternion tests are
 * epsilon-gated, but the target test is an exact `distanceToSquared(...) > 0`, and with damping on
 * `panOffset` decays geometrically (×0.95 per update) without reaching zero. So after a *pan* it
 * keeps reporting movement long after the motion stops being visible. Comparing the pose here
 * against one epsilon covers rotate and pan alike, and keeps this independent of three's internals
 * across upgrades.
 *
 * Note this does not cut OrbitControls' damping tail short — while damping is still easing the
 * camera by a visible amount, those frames genuinely need drawing. The tail is per-update, not
 * per-second, so where a frame is slow (software rendering: ~300ms/frame here, which caps rAF at
 * ~3fps) it stretches out in wall-clock accordingly. That is pre-existing OrbitControls behaviour
 * and not something this loop introduced — the previous always-on loop simply paid it forever,
 * everywhere, whether or not the camera was moving.
 */
const prevCamPos = new THREE.Vector3();
const prevCamQuat = new THREE.Quaternion();
const prevTarget = new THREE.Vector3();
/** Same magnitude as OrbitControls' own EPS. Scene units are mm, so this is far below a pixel. */
const CAM_EPS = 1e-6;

function cameraMovedThisFrame(): boolean {
  return (
    prevCamPos.distanceToSquared(camera.position) > CAM_EPS ||
    8 * (1 - Math.abs(prevCamQuat.dot(camera.quaternion))) > CAM_EPS ||
    prevTarget.distanceToSquared(controls.target) > CAM_EPS
  );
}

function recordCameraPose(): void {
  prevCamPos.copy(camera.position);
  prevCamQuat.copy(camera.quaternion);
  prevTarget.copy(controls.target);
}

/**
 * OrbitControls decays its damping by `dampingFactor` once per `update()` call, i.e. per frame —
 * so the glide after releasing the pointer lasts a fixed number of FRAMES, not a fixed time. At
 * 60fps that is three's intended ~1s. Where frames are slow it stretches out in proportion: on a
 * software renderer here (~300ms/frame, which itself caps rAF near 2.5fps) the same glide was
 * measured still running 221 seconds after release, holding the main thread at ~90% throughout.
 *
 * So rescale the factor to the real frame time, giving the same per-SECOND decay at any rate.
 * At 60fps this returns 0.05 exactly, leaving the feel on fast hardware untouched.
 */
const BASE_DAMPING = 0.05; // three's default, tuned for 60fps
const BASE_HZ = 60;
const MAX_FRAME_DT = 0.25;

function dampingForFrame(dt: number): number {
  return Math.min(1, 1 - Math.pow(1 - BASE_DAMPING, dt * BASE_HZ));
}

/**
 * Ground plane span. The grid doubles as a ruler, so the cell stays a round 20mm and the span is
 * sized to the largest assembly the (fixed, closed) part library contains: the chair's footprint is
 * 380 × 658mm, which the old 600mm stage — sized for the 280mm wheel — overhung at both ends.
 * `tests/display-frame.test.ts` measures every kind in `ASSEMBLY_KINDS` against this constant, so a
 * new part outsizing the stage fails there rather than silently overhanging in the viewport.
 */
export const GRID_SPAN_MM = 800;
const GRID_CELL_MM = 20;

export function initViewport(host: HTMLElement): void {
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  basePixelRatio = Math.min(devicePixelRatio, 2);
  renderer.setPixelRatio(basePixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070a13);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose(); // only frees the generator's scratch render targets — the output texture stays valid

  camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
  camera.position.set(90, -140, 110);
  camera.up.set(0, 0, 1);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 2);
  controls.enableDamping = true;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x33383d, 0.4)); // envmap supplies most ambient
  const dl = new THREE.DirectionalLight(0xffffff, 1.0);
  dl.position.set(80, -60, 120);
  dl.castShadow = true;
  dl.shadow.mapSize.set(2048, 2048);
  dl.shadow.camera.left = -200;
  dl.shadow.camera.right = 200;
  dl.shadow.camera.top = 200;
  dl.shadow.camera.bottom = -200;
  dl.shadow.camera.near = 1;
  dl.shadow.camera.far = 600;
  dl.shadow.normalBias = 0.5; // scene units are mm; avoids acne on large flat faces
  scene.add(dl);
  const dl2 = new THREE.DirectionalLight(0xffffff, 0.4);
  dl2.position.set(-60, 80, 40);
  scene.add(dl2);

  const grid = new THREE.GridHelper(GRID_SPAN_MM, GRID_SPAN_MM / GRID_CELL_MM, 0x2b3457, 0x1c2440);
  grid.rotation.x = Math.PI / 2;
  scene.add(grid);
  const shadowCatcher = new THREE.Mesh(
    new THREE.PlaneGeometry(GRID_SPAN_MM, GRID_SPAN_MM),
    new THREE.ShadowMaterial({ opacity: 0.3 }),
  );
  shadowCatcher.position.z = -0.05; // just under the grid plane so coplanar model bottoms don't z-fight
  shadowCatcher.receiveShadow = true;
  scene.add(shadowCatcher);

  scene.add(modelGroup);

  function resize(): void {
    const w = host.clientWidth,
      h = host.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    invalidate();
  }
  new ResizeObserver(resize).observe(host);
  resize();

  let lastFrameMs = performance.now();

  function animate(): void {
    requestAnimationFrame(animate);
    const now = performance.now();
    // Clamped so a backgrounded tab resuming doesn't count its whole absence as one frame.
    const dt = Math.min((now - lastFrameMs) / 1000, MAX_FRAME_DT);
    lastFrameMs = now;
    controls.dampingFactor = dampingForFrame(dt);
    // update() has to run every tick regardless of whether we draw: with damping on it is what
    // keeps easing the camera after the pointer is released. Whether that easing is still worth
    // drawing is decided by cameraMovedThisFrame(), not update()'s return value — see note there.
    controls.update();
    const moved = cameraMovedThisFrame();
    recordCameraPose();
    if (!needsRender && !moved) return;
    needsRender = false;
    renderer.render(scene, camera);
  }
  animate();
}

/**
 * Set shadow flags on every mesh currently in the model group. modelGroup is rebuilt from
 * several code paths — call this once after each one populates it, rather than every frame.
 * Transparent ghosts don't cast shadows.
 */
export function refreshModelShadows(): void {
  modelGroup.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = !(mesh.material as THREE.Material).transparent;
      mesh.receiveShadow = true;
    }
  });
  invalidate();
}

/**
 * Discard the current model group and return a fresh one already in the scene, disposing the
 * GPU geometry/material buffers of everything it held — rebuilds fire on every debounced slider
 * tick, so without this VRAM grows for the whole session. `keep`, if given (the persistent STL
 * reference ghost, which rebuild.ts re-adds to every new group), is skipped so it survives.
 */
export function newModelGroup(keep?: THREE.Object3D | null): THREE.Group {
  scene.remove(modelGroup);
  const materials = new Set<THREE.Material>();
  modelGroup.traverse((o) => {
    if (keep && (o === keep || keep.getObjectById(o.id))) return;
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    if (Array.isArray(mesh.material)) mesh.material.forEach((m) => materials.add(m));
    else materials.add(mesh.material);
  });
  materials.forEach((m) => m.dispose());
  modelGroup = new THREE.Group();
  scene.add(modelGroup);
  // Not just belt-and-braces with refreshModelShadows(): rebuildScene() bails out between the two
  // when there is nothing to build (no base params, no built result), leaving the scene cleared —
  // that emptying still has to reach the screen.
  invalidate();
  return modelGroup;
}

export function getModelGroup(): THREE.Group {
  return modelGroup;
}

/**
 * Map a point from model space — part-native coordinates, before the grid lift and before any
 * display-frame rotation — into world space.
 *
 * The model group carries a full transform, not just a translation: assembly kinds that author a
 * `displayFrame` are rotated for display as well as lifted onto the grid. Anything living OUTSIDE
 * modelGroup that must stay attached to what the user sees — the on-face design gizmo and the
 * zone-pick meshes, both scene-level siblings so they survive newModelGroup() — has to apply that
 * same transform by hand. Reading only `.position` silently detaches them the moment a kind poses
 * itself, with nothing to catch it but the gizmo landing somewhere wrong.
 *
 * Mutates and returns `v`, per three's vector convention.
 */
export function modelToWorldPoint(v: THREE.Vector3): THREE.Vector3 {
  return v.applyMatrix4(modelWorldMatrix());
}

/**
 * The model group's world matrix, brought up to date — for a caller transforming *many* points at
 * once. `updateMatrixWorld()` walks the group's whole subtree, which is every loaded part mesh, so
 * paying it per point (as calling `modelToWorldPoint` in a loop does) costs far more than the
 * transform itself. Take it once, then apply it. Valid only until something moves the group, which
 * for the gizmo means the next rebuild — where its frame is recomputed anyway.
 */
export function modelWorldMatrix(): THREE.Matrix4 {
  modelGroup.updateMatrixWorld();
  return modelGroup.matrixWorld;
}

/** Direction-only counterpart of `modelToWorldPoint` — rotation without the translation. */
export function modelToWorldDir(v: THREE.Vector3): THREE.Vector3 {
  return v.applyQuaternion(modelGroup.quaternion);
}

/** Give a scene-level sibling the model group's full transform. */
export function syncToModelGroup(obj: THREE.Object3D): void {
  obj.position.copy(modelGroup.position);
  obj.quaternion.copy(modelGroup.quaternion);
  obj.scale.copy(modelGroup.scale);
}

export function getCamera(): THREE.PerspectiveCamera {
  return camera;
}

export function getControls(): OrbitControls {
  return controls;
}

export function getDomElement(): HTMLCanvasElement {
  return renderer.domElement;
}

/** Pointer position in normalized device coords (−1..1), for raycasting — shared by the design
 * gizmo and zone picking, the two viewport features that hit-test against the pointer. */
export function pointerToNDC(e: PointerEvent): THREE.Vector2 {
  const rect = renderer.domElement.getBoundingClientRect();
  return new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  );
}

/**
 * Add an object that lives directly in the scene, outside modelGroup — so it survives
 * newModelGroup()'s dispose-and-replace on every rebuild. Used by the on-face design gizmo,
 * whose overlay is a persistent singleton that must outlive each recut of the geometry underneath.
 */
export function addSceneOverlay(obj: THREE.Object3D): void {
  scene.add(obj);
  invalidate();
}

/**
 * Drop render quality for the duration of a viewport drag (gizmo manipulation), then restore it.
 * Cuts pixel ratio to 1 and disables shadow rendering. The user accepted degraded quality while
 * dragging; the restore on release has to be drawn, hence the invalidate.
 */
export function setInteracting(on: boolean): void {
  if (!renderer) return;
  renderer.setPixelRatio(on ? 1 : basePixelRatio);
  renderer.shadowMap.enabled = !on;
  invalidate();
}

export function requestFrame(): void {
  pendingFrame = true;
}

export function setPreferredViewDir(v: THREE.Vector3 | null): void {
  preferredViewDir = v;
}

/**
 * The current model's extent in normalized device coordinates — |x| and |y| at or under 1 mean it
 * is inside the canvas. Exposed for driven checks (window.__mosaic.modelNdcExtent) because the
 * alternative is reading pixels, and the scene's 800mm grid reaches every edge of the frame no
 * matter how the model is fitted: a border-pixel test would report "something is drawn there"
 * whether or not the part overflows. This asserts the framing itself.
 */
export function modelNdcExtent(): { x: number; y: number } | null {
  const box = new THREE.Box3().setFromObject(modelGroup);
  if (box.isEmpty()) return null;
  camera.updateMatrixWorld();
  const v = new THREE.Vector3();
  let x = 0,
    y = 0;
  for (let i = 0; i < 8; i++) {
    v.set(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z,
    ).project(camera);
    x = Math.max(x, Math.abs(v.x));
    y = Math.max(y, Math.abs(v.y));
  }
  return { x, y };
}

/**
 * How much of the frame the fitted model fills, as a fraction of the tighter half-axis. 0.9 leaves
 * a tenth of the frame as breathing room on the binding axis.
 */
export const FIT_FILL = 0.9;
/** Smallest model half-size the fit will honor, so a tiny part isn't framed from inside itself. */
const FIT_MIN_MM = 10;

/**
 * Camera distance along `dir` (target → camera) that puts every corner of `box` inside the
 * frustum, solved rather than approximated.
 *
 * The obvious cheap version — half the largest extent, or the bounding sphere's radius, over
 * sin(fov/2) — is wrong in opposite directions, and the app shipped one and then the other:
 *
 *   - Half the largest extent UNDER-shoots: it is the right radius only for a shape whose widest
 *     span is also its diagonal. On the chair (≈600 × 700 × 700 mm) it read 350 against a true
 *     578, putting the camera 1.65x too close — past the margin — so the wings and caster mounts
 *     rendered off the bottom of the canvas. The wheel and footrest hid it, their largest extent
 *     being their diameter.
 *   - The bounding sphere OVER-shoots by however much the model isn't a ball. Measured on the
 *     wheel, a flat disc whose sphere is far bigger than its silhouette: it filled 0.61 of the
 *     frame where the old formula gave 0.88 — trading a cropped chair for three parts too small.
 *
 * So project each corner onto the view basis instead and take the distance the worst one needs.
 * Exact for any shape and any aspect, in one pass, with no iteration to converge or tune.
 */
export function fitDistance(
  box: THREE.Box3,
  center: THREE.Vector3,
  dir: THREE.Vector3,
  fovDeg: number,
  aspect: number,
  worldUp: THREE.Vector3,
): number {
  const vFov = (fovDeg * Math.PI) / 180;
  const tanV = Math.tan(vFov / 2);
  // camera.fov is the *vertical* one; the horizontal half-angle is narrower whenever the canvas is
  // taller than it is wide, so fitting to fov alone crops a portrait window. Measured at the 900px
  // minimum width the app renders at (styles.css hides #app below it): every kind overflowed
  // sideways, 1.18-1.30 in NDC, until this term was included.
  const tanH = tanV * aspect;
  // The view basis, in three's own convention (Matrix4.lookAt: x = up × z, y = z × x, z = dir) —
  // it has to be the basis the camera will actually adopt, or the fit is solved for a frame the
  // render doesn't use. Where dir is parallel to up the cross product vanishes and lookAt breaks
  // the tie by nudging the view axis; do the same, rather than picking an arbitrary fallback that
  // disagrees with it. Measured: an arbitrary +X fallback cropped a 300x4x4 box to 2.1 in NDC.
  //
  // The test is lookAt's own exact zero, deliberately not an epsilon: a merely NEAR-parallel dir
  // gives a tiny cross product that still normalizes to the exact right direction, and it is the
  // direction lookAt will use. Taking the nudge there instead lands on a basis rotated 90° from
  // the camera's, which is worse than no fallback — measured at 1.31 in NDC on a 4x300x4 box
  // viewed from (0, 1e-7, 1), a direction OrbitControls' own polar clamp (EPS = 1e-6) can produce.
  const right = new THREE.Vector3().crossVectors(worldUp, dir);
  if (right.lengthSq() === 0) {
    const nudged = dir.clone();
    if (Math.abs(worldUp.z) === 1) nudged.x += 1e-4;
    else nudged.z += 1e-4;
    right.crossVectors(worldUp, nudged.normalize());
  }
  right.normalize();
  const up = new THREE.Vector3().crossVectors(dir, right).normalize();

  const v = new THREE.Vector3();
  let dist = 0;
  for (let i = 0; i < 8; i++) {
    v.set(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z,
    ).sub(center);
    // Depth along the view axis is (dist - v·dir), so a corner is inside when
    // |v·right| <= tanH * (dist - v·dir) and likewise vertically — solve each for dist.
    const need = Math.max(Math.abs(v.dot(right)) / tanH, Math.abs(v.dot(up)) / tanV);
    dist = Math.max(dist, v.dot(dir) + need / FIT_FILL);
  }
  return Math.max(dist, FIT_MIN_MM / Math.min(tanH, tanV));
}

export function frameModelIfPending(): void {
  if (!pendingFrame) return;
  const box = new THREE.Box3().setFromObject(modelGroup);
  if (box.isEmpty()) return; // nothing built yet — try again next rebuild
  pendingFrame = false;
  const center = box.getCenter(new THREE.Vector3());
  const dir = preferredViewDir
    ? preferredViewDir.clone()
    : new THREE.Vector3().subVectors(camera.position, controls.target);
  if (dir.lengthSq() < 1e-6) dir.set(0.5, -0.85, 0.6);
  dir.normalize();
  const dist = fitDistance(box, center, dir, camera.fov, camera.aspect, camera.up);
  controls.target.copy(center);
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.near = Math.max(0.1, dist / 500);
  camera.far = dist * 50;
  camera.updateProjectionMatrix();
  // This update() runs outside the render loop, so its "camera moved" return value goes nowhere —
  // say so explicitly rather than relying on the next loop tick still reporting the move.
  controls.update();
  invalidate();
}
