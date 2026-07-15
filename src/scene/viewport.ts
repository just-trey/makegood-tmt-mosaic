import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

let renderer: THREE.WebGLRenderer;
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let controls: OrbitControls;
let modelGroup = new THREE.Group();

// Re-frame the camera to fit the current model only when content actually changes (new SVG,
// parts added, shape switched) — so tweaking a depth slider doesn't yank the user's orbit/zoom
// around on every rebuild. `preferredViewDir`, when set, forces the starting view direction
// (assembly mode points it at the design face so the wheel doesn't open showing its blank
// back); otherwise the user's current view direction is kept.
let pendingFrame = true;
let preferredViewDir: THREE.Vector3 | null = null;

export function initViewport(host: HTMLElement): void {
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070a13);
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(
    new RoomEnvironment(),
    0.04,
  ).texture;

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
    // modelGroup is rebuilt from several code paths — flagging every frame catches them all
    // (object count is small). Transparent ghosts don't cast shadows.
    modelGroup.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = !(mesh.material as THREE.Material).transparent;
        mesh.receiveShadow = true;
      }
    });
    controls.update();
    renderer.render(scene, camera);
  }
  animate();
}

/** Discard the current model group and return a fresh one already in the scene. */
export function newModelGroup(): THREE.Group {
  scene.remove(modelGroup);
  modelGroup = new THREE.Group();
  scene.add(modelGroup);
  return modelGroup;
}

export function getModelGroup(): THREE.Group {
  return modelGroup;
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
