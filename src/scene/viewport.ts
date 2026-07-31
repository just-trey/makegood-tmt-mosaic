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

  const grid = new THREE.GridHelper(600, 30, 0x2b3457, 0x1c2440); // 600mm span — fits the wheel assembly
  grid.rotation.x = Math.PI / 2;
  scene.add(grid);
  const shadowCatcher = new THREE.Mesh(
    new THREE.PlaneGeometry(600, 600),
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
  }
  new ResizeObserver(resize).observe(host);
  resize();

  function animate(): void {
    requestAnimationFrame(animate);
    controls.update();
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
  modelGroup.updateMatrixWorld();
  return v.applyMatrix4(modelGroup.matrixWorld);
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
}

/**
 * Drop render quality for the duration of a viewport drag (gizmo manipulation), then restore it.
 * Cuts pixel ratio to 1 and disables shadow rendering — both take effect on the next frame of the
 * always-on render loop, no re-schedule needed. The user accepted degraded quality while dragging.
 */
export function setInteracting(on: boolean): void {
  if (!renderer) return;
  renderer.setPixelRatio(on ? 1 : basePixelRatio);
  renderer.shadowMap.enabled = !on;
}

export function requestFrame(): void {
  pendingFrame = true;
}

export function setPreferredViewDir(v: THREE.Vector3 | null): void {
  preferredViewDir = v;
}

export function frameModelIfPending(): void {
  if (!pendingFrame) return;
  const box = new THREE.Box3().setFromObject(modelGroup);
  if (box.isEmpty()) return; // nothing built yet — try again next rebuild
  pendingFrame = false;
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);
  const radius = Math.max(size.x, size.y, size.z, 20) * 0.5;
  const dist = (radius / Math.sin((camera.fov * Math.PI) / 180 / 2)) * 1.25;
  const dir = preferredViewDir
    ? preferredViewDir.clone()
    : new THREE.Vector3().subVectors(camera.position, controls.target);
  if (dir.lengthSq() < 1e-6) dir.set(0.5, -0.85, 0.6);
  dir.normalize();
  controls.target.copy(center);
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.near = Math.max(0.1, dist / 500);
  camera.far = dist * 50;
  camera.updateProjectionMatrix();
  controls.update();
}
