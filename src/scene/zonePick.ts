import * as THREE from 'three';
import { state } from '../state/store';
import { activeArtworkInstance, setArtworkZone } from '../state/artwork';
import { asmPartTransformGroup } from '../geometry/assembly';
import { scheduleRebuild } from '../app/scheduler';
import { addSceneOverlay, getCamera, getDomElement, getModelGroup, pointerToNDC } from './viewport';
import { isGizmoDragging, refreshGizmo } from './designGizmo';
import { renderArtworkList } from '../ui/artworkListPanel';
import { refreshFitInputsFromState } from '../ui/fitPanel';
import { track } from '../analytics/track';

/** Pointer movement (px) below which a pointerdown→pointerup pair reads as a click, not a drag. */
const CLICK_MOVE_TOLERANCE_PX = 5;

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

function pick(e: PointerEvent): PickTarget | null {
  if (!targets.length) return null;
  raycaster.setFromCamera(pointerToNDC(e), getCamera());
  const hits = raycaster.intersectObjects(
    targets.map((t) => t.mesh),
    false,
  );
  if (!hits.length) return null;
  return targets.find((t) => t.mesh === hits[0].object) ?? null;
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
  // pickRoot is a scene-level sibling of modelGroup, not a child, so it needs the same grid-lift
  // offset applied manually — see restAssemblyOnGrid() in rebuild.ts.
  pickRoot.position.copy(getModelGroup().position);

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
      mesh.visible = false; // picking target only — never rendered
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
