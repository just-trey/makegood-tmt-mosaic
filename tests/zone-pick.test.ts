// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

/**
 * The viewport owns the renderer, so it is stubbed — but with a real camera, a real canvas and a
 * real scene-overlay group, so raycasting, transforms and geometry disposal are the genuine
 * three.js ones. Only WebGL is missing, and picking never touches it.
 */
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
const sceneOverlays: THREE.Object3D[] = [];
let ndc = new THREE.Vector2(0, 0);
/** Replaced per test — initZonePicking() adds listeners, and they would otherwise accumulate. */
let domElement = document.createElement('canvas');
/** The visible model. Empty unless a test puts a solid in front of (or behind) the chart. */
let modelGroup = new THREE.Group();

vi.mock('../src/scene/viewport', () => ({
  addSceneOverlay: vi.fn((o: THREE.Object3D) => {
    sceneOverlays.push(o);
  }),
  getCamera: vi.fn(() => camera),
  getDomElement: vi.fn(() => domElement),
  getModelGroup: vi.fn(() => modelGroup),
  pointerToNDC: vi.fn(() => ndc),
  syncToModelGroup: vi.fn(),
  requestFrame: vi.fn(),
}));
vi.mock('../src/scene/designGizmo', () => ({
  isGizmoDragging: vi.fn(() => false),
  refreshGizmo: vi.fn(),
}));
vi.mock('../src/app/scheduler', () => ({ scheduleRebuild: vi.fn() }));
vi.mock('../src/ui/artworkListPanel', () => ({ renderArtworkList: vi.fn() }));
vi.mock('../src/ui/fitPanel', () => ({ refreshFitInputsFromState: vi.fn() }));
vi.mock('../src/analytics/track', () => ({ track: vi.fn() }));

import { initZonePicking, refreshZonePickMeshes, zoneIdAtNdc } from '../src/scene/zonePick';
import { isGizmoDragging } from '../src/scene/designGizmo';
import { scheduleRebuild } from '../src/app/scheduler';
import { track } from '../src/analytics/track';
import { state } from '../src/state/store';
import type { AssemblyPart, DesignZone } from '../src/types';
import type { ConformalChart } from '../src/geometry/conformal';

/** A 40×40mm square centred on the origin in the z=0 plane, facing the camera. */
function squareChart(): ConformalChart {
  return {
    positions3: new Float32Array([-20, -20, 0, 20, -20, 0, 20, 20, 0, -20, 20, 0]),
    uv: new Float32Array([0, 0, 40, 0, 40, 40, 0, 40]),
    triangles: new Uint32Array([0, 1, 2, 0, 2, 3]),
    normalSign: 1,
    boundary: [
      [0, 0],
      [40, 0],
      [40, 40],
      [0, 40],
    ],
  };
}

const zone = (id: string): DesignZone => ({ id, name: id, chart: squareChart() });

function part(over: Partial<AssemblyPart> = {}): AssemblyPart {
  return {
    id: 1,
    name: 'p',
    roleId: 'r',
    positions: new Float32Array([0, 0, 0]),
    patches: null,
    patchIdx: 0,
    boundaryLoops: null,
    topZ: 0,
    baseDepth: 3,
    isDuplicateOf: null,
    pivotX: 0,
    pivotZ: 0,
    angleDeg: 0,
    loaded: true,
    cutThrough: false,
    zones: [zone('front')],
    ...over,
  } as unknown as AssemblyPart;
}

const down = (over: Partial<PointerEvent> = {}) =>
  new PointerEvent('pointerdown', { button: 0, pointerId: 1, clientX: 0, clientY: 0, ...over });
const up = (over: Partial<PointerEvent> = {}) =>
  new PointerEvent('pointerup', { button: 0, pointerId: 1, clientX: 0, clientY: 0, ...over });

/** A press-and-release pair at the given screen positions. */
function clickAt(fromX = 0, fromY = 0, toX = fromX, toY = fromY, pointerId = 1): void {
  domElement.dispatchEvent(down({ clientX: fromX, clientY: fromY, pointerId }));
  domElement.dispatchEvent(up({ clientX: toX, clientY: toY, pointerId }));
}

const boundZone = (): string | null => state.artworks[0]?.zone?.zoneId ?? null;

/**
 * Put a 60x60mm slab into the visible model at `z`, spanning the chart in x/y. The camera looks
 * down -Z from z = +100, so a positive z is between the eye and the chart at z = 0.
 */
function solidAt(z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  );
  mesh.position.z = z;
  modelGroup.add(mesh);
  modelGroup.updateMatrixWorld(true);
  return mesh;
}

beforeEach(() => {
  domElement = document.createElement('canvas');
  modelGroup = new THREE.Group();
  sceneOverlays.length = 0;
  ndc = new THREE.Vector2(0, 0);
  camera.position.set(0, 0, 100);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  state.shapeKind = 'assembly';
  state.assembly.kindId = 'chair-body';
  state.assembly.parts = [part()];
  state.artworks = [
    { id: 'a1', sourceId: 's1', zone: null } as unknown as (typeof state.artworks)[number],
  ];
  state.activeArtworkId = 'a1';

  vi.mocked(isGizmoDragging).mockReturnValue(false);
  vi.mocked(scheduleRebuild).mockClear();
  vi.mocked(track).mockClear();
});

afterEach(() => {
  state.assembly.kindId = null;
  state.assembly.parts = [];
  state.artworks = [];
  state.shapeKind = 'disc';
});

describe('refreshZonePickMeshes', () => {
  it('does nothing before initZonePicking has run', () => {
    // no pickRoot yet — must not throw, and must not register anything
    expect(() => refreshZonePickMeshes()).not.toThrow();
    expect(sceneOverlays).toHaveLength(0);
  });

  it('builds one invisible pick mesh per charted zone', () => {
    initZonePicking();
    state.assembly.parts = [part({ zones: [zone('front'), zone('back')] })];

    refreshZonePickMeshes();

    const meshes: THREE.Mesh[] = [];
    sceneOverlays[0].traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    expect(meshes).toHaveLength(2);
    // never rendered — a picking target only
    expect(meshes.every((m) => m.visible === false)).toBe(true);
    expect(meshes[0].geometry.getAttribute('position').count).toBe(4);
  });

  it('skips parts that are not loaded, or carry no zones', () => {
    initZonePicking();
    state.assembly.parts = [
      part({ id: 1, loaded: false }),
      part({ id: 2, zones: [] }),
      part({ id: 3, zones: undefined }),
    ];

    refreshZonePickMeshes();

    let meshes = 0;
    sceneOverlays[0].traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes++;
    });
    expect(meshes).toBe(0);
  });

  it('skips a zone whose chart failed to reconstruct', () => {
    initZonePicking();
    state.assembly.parts = [part({ zones: [zone('front'), { id: 'broken', name: 'broken' }] })];

    refreshZonePickMeshes();

    let meshes = 0;
    sceneOverlays[0].traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes++;
    });
    expect(meshes).toBe(1);
  });

  it('clears out the previous targets rather than stacking them up', () => {
    initZonePicking();

    refreshZonePickMeshes();
    refreshZonePickMeshes();
    refreshZonePickMeshes();

    let meshes = 0;
    sceneOverlays[0].traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes++;
    });
    expect(meshes).toBe(1);
  });

  it('disposes the geometry it drops, so repeated rebuilds do not leak', () => {
    initZonePicking();
    refreshZonePickMeshes();
    let first: THREE.BufferGeometry | null = null;
    sceneOverlays[0].traverse((o) => {
      if ((o as THREE.Mesh).isMesh) first = (o as THREE.Mesh).geometry as THREE.BufferGeometry;
    });
    const disposed = vi.fn();
    first!.addEventListener('dispose', disposed);

    refreshZonePickMeshes();

    expect(disposed).toHaveBeenCalled();
  });

  it('registers nothing outside assembly mode', () => {
    initZonePicking();
    state.shapeKind = 'disc';

    refreshZonePickMeshes();

    let meshes = 0;
    sceneOverlays[0].traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes++;
    });
    expect(meshes).toBe(0);
  });
});

describe('picking a zone in the viewport', () => {
  beforeEach(() => {
    initZonePicking();
    refreshZonePickMeshes();
    // The pending-press state lives in the module, and a mismatched release deliberately leaves
    // one behind (see below). Retire it far from the square so it reads as a drag, not a click.
    domElement.dispatchEvent(up({ clientX: 9999, clientY: 9999 }));
  });

  it('binds the active artwork to the zone that was clicked', () => {
    clickAt(10, 10);

    expect(boundZone()).toBe('front');
    expect(scheduleRebuild).toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith('zone_selected', { zone: 'front' });
  });

  it('ignores a drag — the pointer moved too far for this to be a click', () => {
    clickAt(10, 10, 200, 120);

    expect(boundZone()).toBeNull();
    expect(track).not.toHaveBeenCalled();
  });

  it('still counts as a click when the pointer barely moved', () => {
    // 3px, inside the 5px tolerance
    clickAt(10, 10, 12, 12);

    expect(boundZone()).toBe('front');
  });

  it('ignores a press the gizmo had already claimed, even if it never moved', () => {
    vi.mocked(isGizmoDragging).mockReturnValue(true);

    clickAt(10, 10);

    expect(boundZone()).toBeNull();
    expect(track).not.toHaveBeenCalled();
  });

  it('reads the gizmo state at press time, not release time', () => {
    // the gizmo clears its own drag state on pointerup before this handler runs
    vi.mocked(isGizmoDragging).mockReturnValue(true);
    domElement.dispatchEvent(down());
    vi.mocked(isGizmoDragging).mockReturnValue(false);
    domElement.dispatchEvent(up());

    expect(boundZone()).toBeNull();
  });

  it('ignores a non-primary button', () => {
    domElement.dispatchEvent(down({ button: 2 }));
    domElement.dispatchEvent(up({ button: 2 }));

    expect(boundZone()).toBeNull();
  });

  it('ignores a release from a different pointer than the one that pressed', () => {
    domElement.dispatchEvent(down({ pointerId: 1 }));
    domElement.dispatchEvent(up({ pointerId: 7 }));

    expect(boundZone()).toBeNull();
  });

  it('leaves the original press pending when another pointer releases', () => {
    // Multi-touch: a second finger lifting must not cancel the first finger's press, so the
    // original pointer can still complete its click.
    domElement.dispatchEvent(down({ pointerId: 1 }));
    domElement.dispatchEvent(up({ pointerId: 7 }));
    expect(boundZone()).toBeNull();

    domElement.dispatchEvent(up({ pointerId: 1 }));

    expect(boundZone()).toBe('front');
  });

  it('ignores a release with no press before it', () => {
    domElement.dispatchEvent(up());

    expect(boundZone()).toBeNull();
  });

  it('does nothing when the click misses every zone', () => {
    ndc = new THREE.Vector2(0.95, 0.95); // off the 40mm square

    clickAt(10, 10);

    expect(boundZone()).toBeNull();
    expect(track).not.toHaveBeenCalled();
  });

  it('does nothing when there is no artwork to bind', () => {
    state.activeArtworkId = null;

    clickAt(10, 10);

    expect(boundZone()).toBeNull();
    expect(scheduleRebuild).not.toHaveBeenCalled();
  });

  // ui-conventions.md convention 12, "picking hits what is visible".
  it('ignores a zone hidden behind a part in front of it', () => {
    solidAt(50);

    clickAt(10, 10);

    expect(boundZone()).toBeNull();
    expect(track).not.toHaveBeenCalled();
  });

  it('still picks a zone whose own body is coincident with its chart', () => {
    // The normal case, and the one the tolerance exists for: every chart lies exactly on the
    // surface of the part it was baked from, so the two tie and the zone must survive.
    solidAt(0);

    clickAt(10, 10);

    expect(boundZone()).toBe('front');
  });

  it('is not fooled by solid geometry behind the zone', () => {
    solidAt(-50);

    clickAt(10, 10);

    expect(boundZone()).toBe('front');
  });

  it('picks the near zone rather than rejecting it when two zones stack', () => {
    // Two charts along the same ray with nothing solid in front: the nearer one wins, and the
    // farther one must not be mistaken for something covering it.
    const near = zone('front');
    const far = zone('back');
    for (let i = 2; i < far.chart!.positions3.length; i += 3) far.chart!.positions3[i] = -30;
    state.assembly.parts = [part({ zones: [near, far] })];
    refreshZonePickMeshes();

    clickAt(10, 10);

    expect(boundZone()).toBe('front');
  });

  it('retargets an artwork that is already bound elsewhere', () => {
    state.assembly.parts = [part({ zones: [zone('front')] })];
    refreshZonePickMeshes();
    clickAt(10, 10);
    expect(boundZone()).toBe('front');

    state.assembly.parts = [part({ zones: [zone('seat')] })];
    refreshZonePickMeshes();
    clickAt(10, 10);

    expect(boundZone()).toBe('seat');
  });
});

describe('zoneIdAtNdc', () => {
  // The hook scripts/check-zone-occlusion.mjs drives. It has to answer the same question a click
  // does, or that check is measuring something the user never touches.
  beforeEach(() => {
    initZonePicking();
    refreshZonePickMeshes();
  });

  it('answers with the zone a click at the same point would bind', () => {
    expect(zoneIdAtNdc(0, 0)).toBe('front');
  });

  it('answers null off the model', () => {
    expect(zoneIdAtNdc(0.95, 0.95)).toBeNull();
  });

  it('answers null where a part covers the zone, exactly as a click there does', () => {
    solidAt(50);

    expect(zoneIdAtNdc(0, 0)).toBeNull();
    clickAt(10, 10);
    expect(boundZone()).toBeNull();
  });
});

describe('the clickability cursor hint', () => {
  beforeEach(() => {
    initZonePicking();
    refreshZonePickMeshes();
    domElement.style.cursor = '';
  });

  it('shows a pointer when hovering a zone', () => {
    domElement.dispatchEvent(new PointerEvent('pointermove', { buttons: 0 }));

    expect(domElement.style.cursor).toBe('pointer');
  });

  it('offers no pointer over a zone that is covered by a part in front of it', () => {
    solidAt(50);

    domElement.dispatchEvent(new PointerEvent('pointermove', { buttons: 0 }));

    expect(domElement.style.cursor).toBe('');
  });

  it('clears when hovering nothing', () => {
    ndc = new THREE.Vector2(0.95, 0.95);

    domElement.dispatchEvent(new PointerEvent('pointermove', { buttons: 0 }));

    expect(domElement.style.cursor).toBe('');
  });

  it('stays out of the way mid-drag, where a raycast would be wasted work', () => {
    domElement.style.cursor = 'grabbing';

    domElement.dispatchEvent(new PointerEvent('pointermove', { buttons: 1 }));

    expect(domElement.style.cursor).toBe('grabbing');
  });
});
