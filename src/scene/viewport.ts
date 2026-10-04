import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

let renderer: THREE.WebGLRenderer;
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let controls: OrbitControls;
let modelGroup = new THREE.Group();
let basePixelRatio = 1;

// Re-frame only when content changes, so a depth slider doesn't yank the orbit. `preferredViewDir`
// forces the start direction (the design face, not the wheel's blank back); else the view is kept.
let pendingFrame = true;
let preferredViewDir: THREE.Vector3 | null = null;

/**
 * On-demand rendering: always-on render starves the boolean rebuilds on a software renderer
 * (headless CI, no GPU). Every on-screen mutation must set this; this module's mutators do it
 * inside, since a missed one silently shows the previous frame. Camera: cameraMovedThisFrame().
 */
let needsRender = true;

/** Mark the scene as changed, so the next animation frame draws it. */
export function invalidate(): void {
  needsRender = true;
}

/**
 * Last frame's camera pose. Not `OrbitControls.update()`'s return: its target test is an exact
 * `> 0` while damped `panOffset` decays ×0.95 per update without reaching zero, so after a *pan*
 * it reports movement forever. One epsilon here covers rotate and pan, independent of three.
 * Visible damping frames still draw (~300ms/frame software rendering, rAF ~3fps).
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
 * Damping decays per FRAME, so the glide is ~1s at 60fps but on a software renderer (~300ms/frame,
 * rAF near 2.5fps) was measured still running 221 seconds after release, main thread ~90%.
 * Rescaled to the real frame time for per-SECOND decay; at 60fps this returns 0.05 exactly.
 */
const BASE_DAMPING = 0.05; // three's default, tuned for 60fps
const BASE_HZ = 60;
const MAX_FRAME_DT = 0.25;

function dampingForFrame(dt: number): number {
  return Math.min(1, 1 - Math.pow(1 - BASE_DAMPING, dt * BASE_HZ));
}

/**
 * Grid span; the grid is a ruler, so cells stay 20mm. Sized for the chair's 380 × 658mm footprint,
 * which overhung the old 600mm stage (sized for the 280mm wheel). tests/display-frame.test.ts
 * fails any kind that outsizes it.
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
    // Every tick, drawn or not: it drives damping. Whether to draw is cameraMovedThisFrame()'s.
    controls.update();
    const moved = cameraMovedThisFrame();
    recordCameraPose();
    if (!needsRender && !moved) return;
    needsRender = false;
    renderer.render(scene, camera);
  }
  animate();
}

/** Shadow flags for the model group; call once after each path populates it. Ghosts cast none. */
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

/** Replace the model group, disposing its GPU buffers: rebuilds run per slider tick, so VRAM grows. */
export function newModelGroup(): THREE.Group {
  scene.remove(modelGroup);
  const materials = new Set<THREE.Material>();
  modelGroup.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    if (Array.isArray(mesh.material)) mesh.material.forEach((m) => materials.add(m));
    else materials.add(mesh.material);
  });
  materials.forEach((m) => m.dispose());
  modelGroup = new THREE.Group();
  scene.add(modelGroup);
  // A rebuild with nothing to build bails before refreshModelShadows(); the clear must still draw.
  invalidate();
  return modelGroup;
}

export function getModelGroup(): THREE.Group {
  return modelGroup;
}

/**
 * Part-native point to world (mutates `v`). The model group also rotates for a `displayFrame`, so
 * siblings outside it (gizmo, zone-pick meshes) need the full transform: `.position` alone
 * silently detaches them once a kind poses itself.
 */
export function modelToWorldPoint(v: THREE.Vector3): THREE.Vector3 {
  return v.applyMatrix4(modelWorldMatrix());
}

/**
 * The updated world matrix, for transforming *many* points: `updateMatrixWorld()` walks every part
 * mesh, so per point it dwarfs the transform. Valid until the group moves (the next rebuild).
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

/** Pointer in normalized device coords (−1..1), for raycasting. */
export function pointerToNDC(e: PointerEvent): THREE.Vector2 {
  const rect = renderer.domElement.getBoundingClientRect();
  return new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  );
}

/** Add to the scene outside modelGroup, so it survives newModelGroup() on every rebuild. */
export function addSceneOverlay(obj: THREE.Object3D): void {
  scene.add(obj);
  invalidate();
}

/** Lower render quality during a gizmo drag (accepted by the user); the restore must be drawn. */
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
 * The model's NDC extent (≤ 1 is inside the canvas), for driven checks (window.__mosaic): the
 * 800mm grid reaches every frame edge, so a border-pixel test can't detect an overflowing part.
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

/** Fraction of the tighter half-axis the fitted model fills. */
export const FIT_FILL = 0.9;
/** Smallest model half-size the fit will honor, so a tiny part isn't framed from inside itself. */
const FIT_MIN_MM = 10;

/**
 * Camera distance along `dir` fitting every corner of `box`, solved per corner. Both shortcuts
 * shipped and failed: half the largest extent under-shoots (chair ≈600 × 700 × 700 mm: 350 vs a
 * true 578, 1.65x too close, wings off-canvas); the bounding sphere over-shoots (the flat wheel
 * filled 0.61 of the frame vs 0.88).
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
  // camera.fov is *vertical*: without this, at the 900px minimum width (styles.css) every kind
  // overflowed sideways, 1.18-1.30 in NDC.
  const tanH = tanV * aspect;
  // The basis the camera will adopt (Matrix4.lookAt: x = up × z, y = z × x, z = dir). Parallel to
  // up, nudge like lookAt does: an arbitrary +X fallback cropped a 300x4x4 box to 2.1 in NDC.
  // Exact zero, not an epsilon, matching lookAt: nudging a NEAR-parallel dir rotates the basis 90°
  // (1.31 in NDC, 4x300x4 box from (0, 1e-7, 1), reachable under OrbitControls' EPS = 1e-6).
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
    // Inside when |v·right| <= tanH * (dist - v·dir), likewise vertically; solved for dist.
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
  // Outside the loop, so invalidate rather than trust the next tick to notice the move.
  controls.update();
  invalidate();
}
