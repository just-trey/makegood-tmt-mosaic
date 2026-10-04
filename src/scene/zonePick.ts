import * as THREE from 'three';
import * as turf from '@turf/turf';
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
import type { ConformalChart } from '../geometry/conformal';
import { zoneMappersFor } from '../geometry/zoneMappers';
import { currentAssemblyKind } from '../assembly/kinds';
import { warn } from '../warnings';
import type { PolyFeature } from '../types';

/** Pointer movement (px) below which a pointerdown→pointerup pair reads as a click, not a drag. */
const CLICK_MOVE_TOLERANCE_PX = 5;

/**
 * How far in front of a chart a surface must be to cover it. Uncut, chart and body triangles tie
 * exactly (`positions3` is the part's own float32 buffer, zoneCharts.ts); cut, Manifold moves by
 * ~1e-4 mm. 0.05 mm covers both and is an eighth of a nozzle width, hiding nothing printable.
 *
 * Known limitation: a ray down a seam hits the far chart behind the near part's edge wall and is
 * rejected. Measured 2026-08-08 (`npm run check:zone-occlusion`, chair): one 3px-wide unpickable
 * sample at one of four viewpoints, back panel centreline. Widening past the seam clearance would
 * stop adjacent parts occluding; revisit if a seam clearance grows enough to show.
 */
const OCCLUSION_TOL_MM = 0.05;

interface PickTarget {
  mesh: THREE.Mesh;
  zoneId: string;
  /** This zone's hidden-surface region in chart UV (mm), or null when none/unbuildable. */
  deadArea: PolyFeature | null;
}

/**
 * `deadArea()` per chart (mapper memoization is per-instance, and a fresh mapper is built every
 * rebuild). A failure is warned, not cached: a cached `null` reads as "nothing hidden" forever,
 * the false through-pick this exists to close. A retry costs one mapper construction.
 */
const deadAreaCache = new WeakMap<ConformalChart, PolyFeature | null>();

/** `mappers`: one part's read-only zone mappers, built lazily so a fully-cached part never pays. */
function deadAreaFor(
  mappers: () => ReturnType<typeof zoneMappersFor>,
  zoneId: string,
  chart: ConformalChart,
): PolyFeature | null {
  const cached = deadAreaCache.get(chart);
  if (cached !== undefined) return cached;
  const fail = (): null => {
    warn(
      `Couldn't test "${zoneId}" for hidden surface. Zone picking may flag it as a through-pick. ` +
        `Please report this.`,
      `dead-area-${zoneId}`,
    );
    return null; // not cached — see the comment on deadAreaCache above
  };
  let mapper: ReturnType<typeof zoneMappersFor>[number] | undefined;
  try {
    mapper = mappers().find((m) => m.zoneId === zoneId);
  } catch {
    return fail();
  }
  // A miss is "can't answer", not "nothing hidden": the id came from `part.zones`, so it's a
  // dispatch bug that a cached `null` would hide.
  if (!mapper) return fail();
  let poly: PolyFeature | null;
  try {
    poly = mapper.deadArea();
  } catch {
    return fail();
  }
  deadAreaCache.set(chart, poly);
  return poly;
}

// A scene-level overlay outside modelGroup, which is rebuilt every pass and traversed for its
// bounds, shadows and triangle stat: one less thing to reason about there.
let pickRoot: THREE.Group | null = null;
let pickMaterial: THREE.Material | null = null;
let targets: PickTarget[] = [];

const raycaster = new THREE.Raycaster();
let downPos: { x: number; y: number } | null = null;
let downPointerId: number | null = null;
let downSuppressed = false;

/** A target plus where on its chart the ray landed — the UV a dead-region test needs. */
interface PickHit {
  target: PickTarget;
  uv: THREE.Vector2 | null;
}

function pickHitAtNdc(ndc: THREE.Vector2): PickHit | null {
  if (!targets.length) return null;
  raycaster.setFromCamera(ndc, getCamera());
  const hits = raycaster.intersectObjects(
    targets.map((t) => t.mesh),
    false,
  );
  if (!hits.length) return null;
  // Convention 12, "picking hits what is visible": invisible charts alone answer "a zone anywhere
  // on this ray". Anything solid before the nearest chart hit was clicked instead; farther hits
  // are covered too.
  const limit = hits[0].distance - OCCLUSION_TOL_MM;
  if (limit > 0) {
    // Capping `far` lets bounding-sphere tests discard parts behind the click (most of the chair).
    // Hover cost on the chair (368,330 tris, no artwork), 400 random points, MOSAIC_GPU=1: median
    // 0.30ms either way (this runs only on chart hits, 81 of the 400), p95 0.80 -> 5.5ms, worst
    // 1.3 -> 9.5ms: inside one 60fps frame, so no BVH. Re-measure for a part bigger than the chair.
    // The raycaster is a singleton: an uncleared cap breaks every later pick silently.
    let covered: boolean;
    try {
      raycaster.far = limit;
      covered = raycaster.intersectObject(getModelGroup(), true).length > 0;
    } finally {
      raycaster.far = Infinity;
    }
    if (covered) return null;
  }
  const target = targets.find((t) => t.mesh === hits[0].object);
  return target ? { target, uv: hits[0].uv ?? null } : null;
}

function pickAtNdc(ndc: THREE.Vector2): PickTarget | null {
  return pickHitAtNdc(ndc)?.target ?? null;
}

function pick(e: PointerEvent): PickTarget | null {
  return pickAtNdc(pointerToNDC(e));
}

/**
 * The zone a click at this NDC point selects, by the click's path, and whether the hit is in its
 * hidden-surface region (`ConformalChart.deadRegions`); one raycast, so both are the same hit.
 * On `window.__mosaic` for scripts/check-zone-occlusion.mjs, which needs hundreds of samples
 * without a rebuild each, and cross-checks two named cases with real clicks.
 */
export function zonePickAtNdc(x: number, y: number): { zoneId: string | null; dead: boolean } {
  const hit = pickHitAtNdc(new THREE.Vector2(x, y));
  if (!hit) return { zoneId: null, dead: false };
  const dead = !!(
    hit.target.deadArea &&
    hit.uv &&
    turf.booleanPointInPolygon([hit.uv.x, hit.uv.y], hit.target.deadArea)
  );
  return { zoneId: hit.target.zoneId, dead };
}

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  downPos = { x: e.clientX, y: e.clientY };
  downPointerId = e.pointerId;
  // Captured now: the gizmo's pointerup runs first and clears its drag state.
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
  // A gizmo grab is no click even if it barely moved.
  if (moved || suppressed) return;

  const target = pick(e);
  if (!target) return;
  // A pick binds the active artwork, so there has to be one.
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
  // At rest only: mid-drag the raycast is wasted and the cursor says something else.
  if (e.buttons !== 0) return;
  getDomElement().style.cursor = pick(e) ? 'pointer' : '';
}

/**
 * One invisible pick mesh per baked zone, from its chart (the cut's own triangles). Runs after
 * every rebuild; a no-op until a part carries zones.
 */
export function refreshZonePickMeshes(): void {
  if (!pickRoot) return; // initZonePicking() hasn't run yet
  targets.forEach((t) => t.mesh.geometry.dispose());
  targets = [];
  pickRoot.clear();
  // A sibling of modelGroup, so it needs the grid lift AND the display rotation: position alone
  // picks zones where an unposed chair would have them (poseAssemblyForDisplay() in rebuild.ts).
  syncToModelGroup(pickRoot);
  const isRect = currentAssemblyKind()?.designFit === 'rect';

  for (const part of state.assembly.parts) {
    if (!part.loaded || !part.zones?.length) continue;
    const xf = asmPartTransformGroup(part);
    let any = false;
    // Lazy: a fully-cached part (every rebuild after the first) never builds mappers.
    let mappers: ReturnType<typeof zoneMappersFor> | null = null;
    const mappersOnce = () =>
      (mappers ??= zoneMappersFor(part, state.assembly.parts, isRect, null));
    for (const zone of part.zones) {
      if (!zone.chart) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(zone.chart.positions3, 3));
      // Parallel to `position`, so each hit carries an interpolated chart UV for zonePickAtNdc.
      geo.setAttribute('uv', new THREE.BufferAttribute(zone.chart.uv, 2));
      geo.setIndex(new THREE.BufferAttribute(zone.chart.triangles, 1));
      const mesh = new THREE.Mesh(geo, pickMaterial!);
      // Never rendered. Hittable only because three.js 0.160's intersectObject ignores `visible`,
      // which is also why pickAtNdc asks the model group what's in front.
      mesh.visible = false;
      xf.add(mesh);
      targets.push({
        mesh,
        zoneId: zone.id,
        deadArea: deadAreaFor(mappersOnce, zone.id, zone.chart),
      });
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
