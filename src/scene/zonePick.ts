import * as THREE from 'three';
import { state } from '../state/store';
import { activeArtworkInstance, setArtworkZone } from '../state/artwork';
import { asmPartTransformGroup } from '../geometry/assembly';
import { scheduleRebuild } from '../app/scheduler';
import {
  addSceneOverlay,
  getCamera,
  getDomElement,
  getModelGroup,
  pointerToNDC,
  syncToModelGroup,
} from './viewport';
import { isGizmoDragging, refreshGizmo } from './designGizmo';
import { renderArtworkList } from '../ui/artworkListPanel';
import { refreshFitInputsFromState } from '../ui/fitPanel';
import { track } from '../analytics/track';

/** Pointer movement (px) below which a pointerdown→pointerup pair reads as a click, not a drag. */
const CLICK_MOVE_TOLERANCE_PX = 5;

/**
 * How far in front of a zone chart a solid surface has to be before it counts as covering it.
 *
 * A chart's `positions3` are copied straight out of its part's own vertex buffer
 * ([zoneCharts.ts](../geometry/zoneCharts.ts)), so before any cut the chart triangles and the
 * body triangles under them are the same float32 values through the same world matrix — they tie
 * exactly. After a cut they are Manifold's output for the same surface, which moves a vertex by
 * at most that engine's own tolerance (~1e-4 mm on a part this size). 0.05 mm covers both with
 * room to spare and is an eighth of a nozzle width, so it cannot hide an overlap anyone could
 * print, let alone see.
 */
const OCCLUSION_TOL_MM = 0.05;

interface PickTarget {
  mesh: THREE.Mesh;
  zoneId: string;
}

// Kept outside modelGroup (a persistent scene-level overlay, like the design gizmo) rather than
// as modelGroup children: modelGroup is disposed and rebuilt on every rebuild, and its bounding
// box, shadow flags, and triangle-count stat are all derived by traversing it — invisible pick
// geometry sitting exactly on top of the real surface wouldn't change any of those, but it's one
// less thing to reason about by living somewhere those traversals never look.
let pickRoot: THREE.Group | null = null;
let pickMaterial: THREE.Material | null = null;
let targets: PickTarget[] = [];

const raycaster = new THREE.Raycaster();
let downPos: { x: number; y: number } | null = null;
let downPointerId: number | null = null;
let downSuppressed = false;

function pickAtNdc(ndc: THREE.Vector2): PickTarget | null {
  if (!targets.length) return null;
  raycaster.setFromCamera(ndc, getCamera());
  const hits = raycaster.intersectObjects(
    targets.map((t) => t.mesh),
    false,
  );
  if (!hits.length) return null;
  // Convention 12, "picking hits what is visible": the chart meshes above are invisible and the
  // real bodies are not in that list, so on their own they answer "is there a zone anywhere along
  // this ray", not "is there a zone under the cursor". Anything solid in front of the nearest
  // chart hit means the user clicked that instead. Only the nearest chart needs testing — every
  // other hit is farther, so whatever covers this one covers those too.
  const limit = hits[0].distance - OCCLUSION_TOL_MM;
  if (limit > 0) {
    // Capping `far` at the chart is not just an early-out: it lets three's per-mesh bounding-sphere
    // test discard whole parts sitting behind the click, which on the chair is most of them.
    //
    // What that costs, since onPointerMove runs this on every hover. Measured on the chair
    // (368,330 tris, no artwork), 400 random points, MOSAIC_GPU=1: median 0.30ms either way — the
    // cast below only runs where a chart was hit at all, 81 of the 400 — and p95 0.80 -> 5.5ms,
    // worst 1.3 -> 9.5ms. The worst case is inside one 60fps frame, so this stayed a plain raycast
    // rather than acquiring a BVH. Re-measure before adding a part with more triangles than the
    // chair.
    //
    // The raycaster is a module singleton, so the cap has to come off even if the cast throws —
    // otherwise every later pick silently finds nothing for the rest of the session.
    let covered: boolean;
    try {
      raycaster.far = limit;
      covered = raycaster.intersectObject(getModelGroup(), true).length > 0;
    } finally {
      raycaster.far = Infinity;
    }
    if (covered) return null;
  }
  return targets.find((t) => t.mesh === hits[0].object) ?? null;
}

function pick(e: PointerEvent): PickTarget | null {
  return pickAtNdc(pointerToNDC(e));
}

/**
 * The zone a click at this normalized-device-coordinate point would select, by the same path the
 * click itself takes. Exposed on `window.__mosaic` for
 * [scripts/check-zone-occlusion.mjs](../../scripts/check-zone-occlusion.mjs): a real click also
 * binds artwork and schedules a rebuild, so asking the question through one costs a rebuild per
 * sample and the check needs hundreds. That script drives real clicks too, on the two named cases,
 * so the two paths are checked against each other rather than this one being trusted alone.
 */
export function zoneIdAtNdc(x: number, y: number): string | null {
  return pickAtNdc(new THREE.Vector2(x, y))?.zoneId ?? null;
}

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  downPos = { x: e.clientX, y: e.clientY };
  downPointerId = e.pointerId;
  // Captured now, not re-checked at pointerup: the design gizmo's own pointerup handler (which
  // runs before this one, same registration-order reasoning) clears its drag state before this
  // handler would otherwise see it.
  downSuppressed = isGizmoDragging();
}

function onPointerUp(e: PointerEvent): void {
  if (!downPos || e.pointerId !== downPointerId) return;
  const dx = e.clientX - downPos.x,
    dy = e.clientY - downPos.y;
  const moved = Math.hypot(dx, dy) > CLICK_MOVE_TOLERANCE_PX;
  const suppressed = downSuppressed;
  downPos = null;
  downPointerId = null;
  downSuppressed = false;
  // A real drag (camera orbit or a gizmo grab) isn't a zone-pick click, whether or not it moved
  // the pointer far enough to register as "moved" — the gizmo already consumed it.
  if (moved || suppressed) return;

  const target = pick(e);
  if (!target) return;
  // Nothing loaded to (re)target — picking a zone in the viewport binds whichever artwork is
  // currently active, so there has to be one; the artwork list panel is where a design starts.
  const active = activeArtworkInstance();
  if (!active) return;

  setArtworkZone(active.id, target.zoneId);
  renderArtworkList();
  refreshFitInputsFromState();
  refreshGizmo();
  scheduleRebuild();
  track('zone_selected', { zone: target.zoneId });
}

function onPointerMove(e: PointerEvent): void {
  // Only hint clickability at rest — during any drag (orbit, gizmo) a raycast here would just be
  // wasted work, and the cursor is already communicating something else (grabbing/orbiting).
  if (e.buttons !== 0) return;
  getDomElement().style.cursor = pick(e) ? 'pointer' : '';
}

/**
 * Rebuild the pickable zone surfaces from the current assembly parts — one mesh per baked
 * conformal zone, built directly from its chart (the same triangles/positions the cut pipeline
 * uses), invisible and non-recursive so raycasting stays cheap. Called after every rebuild; a
 * no-op outside assembly mode or before any part carries zones (single-zone parts like the wheel
 * have nothing to pick between).
 */
export function refreshZonePickMeshes(): void {
  if (!pickRoot) return; // initZonePicking() hasn't run yet
  targets.forEach((t) => t.mesh.geometry.dispose());
  targets = [];
  pickRoot.clear();
  if (state.shapeKind !== 'assembly') return;
  // pickRoot is a scene-level sibling of modelGroup, not a child, so it needs the model group's
  // transform applied manually — the grid lift AND the kind's display rotation. Copying position
  // alone would leave every pick target un-rotated behind a posed chair, so clicks would select a
  // zone by where it used to be. See poseAssemblyForDisplay() in rebuild.ts.
  syncToModelGroup(pickRoot);

  for (const part of state.assembly.parts) {
    if (!part.loaded || !part.zones?.length) continue;
    const xf = asmPartTransformGroup(part);
    let any = false;
    for (const zone of part.zones) {
      if (!zone.chart) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(zone.chart.positions3, 3));
      geo.setIndex(new THREE.BufferAttribute(zone.chart.triangles, 1));
      const mesh = new THREE.Mesh(geo, pickMaterial!);
      // Picking target only — never rendered. It stays hittable because three.js 0.160's
      // intersectObject ignores `visible`; that is what makes this work at all, and also why
      // pickAtNdc has to ask the model group separately whether anything is in front of it.
      mesh.visible = false;
      xf.add(mesh);
      targets.push({ mesh, zoneId: zone.id });
      any = true;
    }
    if (any) pickRoot.add(xf.outer);
  }
}

export function initZonePicking(): void {
  pickRoot = new THREE.Group();
  addSceneOverlay(pickRoot);
  pickMaterial = new THREE.MeshBasicMaterial();
  const dom = getDomElement();
  dom.addEventListener('pointerdown', onPointerDown);
  dom.addEventListener('pointerup', onPointerUp);
  dom.addEventListener('pointermove', onPointerMove);
}
