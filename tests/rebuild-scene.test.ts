// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

/**
 * Drives the real orchestration in rebuild.ts. Only the two expensive producers — buildGeometry
 * (2D extrude) and buildAssemblyGeometry (wasm CSG) — are stubbed; the scene graph, the transform
 * groups, the display pose and the DOM are all real, because those are what this module actually
 * decides. `npm run smoke` still covers the real producers end to end in a browser.
 */
let modelGroup = new THREE.Group();

vi.mock('../src/scene/viewport', () => ({
  // `keep` only exempts that object from geometry disposal in the real one — it is NOT re-added
  // to the fresh group. rebuildScene puts the STL reference back itself, and only in stl mode.
  newModelGroup: vi.fn(() => {
    modelGroup = new THREE.Group();
    return modelGroup;
  }),
  getModelGroup: vi.fn(() => modelGroup),
  setPreferredViewDir: vi.fn(),
  refreshModelShadows: vi.fn(),
  frameModelIfPending: vi.fn(),
  requestFrame: vi.fn(),
  syncToModelGroup: vi.fn(),
  addSceneOverlay: vi.fn(),
}));
vi.mock('../src/geometry/flat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/geometry/flat')>()),
  buildGeometry: vi.fn(),
}));
vi.mock('../src/geometry/assembly', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/geometry/assembly')>()),
  buildAssemblyGeometry: vi.fn(),
}));
vi.mock('../src/ui/colorList', () => ({ renderColorList: vi.fn() }));
vi.mock('../src/ui/partPanel', () => ({ renderBaseColorSwatches: vi.fn() }));
vi.mock('../src/ui/warningsView', () => ({ renderWarnings: vi.fn() }));
vi.mock('../src/state/persist', () => ({ schedulePersist: vi.fn() }));
vi.mock('../src/scene/designGizmo', () => ({
  refreshGizmo: vi.fn(),
  isGizmoDragging: () => false,
}));
vi.mock('../src/scene/zonePick', () => ({ refreshZonePickMeshes: vi.fn() }));
vi.mock('../src/assembly/parts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/assembly/parts')>()),
  asmRebuildGeneratedParts: vi.fn(async () => true),
}));
vi.mock('../src/ui/dom', () => ({ $: (sel: string) => document.querySelector(sel) }));

import { getLastAssemblyBuild, getLastBuild, rebuildCurrent } from '../src/app/rebuild';
import { buildGeometry } from '../src/geometry/flat';
import { buildAssemblyGeometry } from '../src/geometry/assembly';
import { renderColorList } from '../src/ui/colorList';
import { refreshGizmo } from '../src/scene/designGizmo';
import { refreshZonePickMeshes } from '../src/scene/zonePick';
import { schedulePersist } from '../src/state/persist';
import { setPreferredViewDir } from '../src/scene/viewport';
import { asmRebuildGeneratedParts } from '../src/assembly/parts';
import { WARNINGS, clearWarnings } from '../src/warnings';
import { state } from '../src/state/store';
import type { AssemblyBuild, AssemblyPart, ParsedSVG, SVGShape } from '../src/types';
import type { FlatBuild } from '../src/geometry/flat';

const triStat = () => document.querySelector('#stat-tris')!.textContent;
const exportDisabled = () => (document.querySelector('#btn-export') as HTMLButtonElement).disabled;

function parsedSquare(): ParsedSVG {
  return {
    shapes: [
      {
        fill: '#ff0000',
        order: 0,
        loops: [
          [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
            { x: 0, y: 10 },
          ],
        ],
      },
    ] as SVGShape[],
    bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    rawSVGCircle: null,
  } as ParsedSVG;
}

/** One triangle, as a soup — 9 floats = 1 triangle. */
const tri = (z = 0): Float32Array => new Float32Array([0, 0, z, 10, 0, z, 10, 10, z]);

function colorMesh(color: string, areaPct: number) {
  return {
    color,
    key: color,
    members: [color],
    isMergeGroup: false,
    depth: 1,
    mesh: new THREE.Mesh(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(tri(), 3)),
    ),
    area: 1,
    areaPct,
    isBackground: false,
  };
}

function flatBuild(over: Partial<FlatBuild> = {}): FlatBuild {
  return {
    baseGroup: new THREE.Group(),
    colorMeshes: [colorMesh('#ff0000', 60)],
    thickness: 4,
    footW: 80,
    footH: 80,
    detectedColors: [{ hex: '#ff0000', areaPct: 60 }],
    baseAssigned: null,
    ...over,
  } as FlatBuild;
}

function asmPart(over: Partial<AssemblyPart> = {}): AssemblyPart {
  return {
    id: 1,
    name: 'p',
    roleId: 'wheel-half',
    positions: tri(),
    patches: [{ normal: [0, 1, 0], offset: 0, area: 100, triIndices: [0] }],
    patchIdx: 0,
    boundaryLoop: null,
    topZ: 0,
    baseDepth: 3,
    isDuplicateOf: null,
    pivotX: 0,
    pivotZ: 0,
    angleDeg: 180,
    loaded: true,
    cutThrough: false,
    ...over,
  } as unknown as AssemblyPart;
}

function assemblyBuild(over: Partial<AssemblyBuild> = {}): AssemblyBuild {
  const part = asmPart();
  return {
    partOutputs: [{ part, bodySoup: tri(), inlaySoups: { 0: tri(1) } }],
    palette: [{ hex: '#ff0000', key: '#ff0000', members: ['#ff0000'], isMerge: false }],
    viewSign: 1,
    detectedColors: [{ hex: '#ff0000', areaPct: 60 }],
    baseAssigned: null,
    ...over,
  } as AssemblyBuild;
}

beforeEach(() => {
  document.body.innerHTML =
    '<span id="stat-tris"></span><button id="btn-export"></button><button id="btn-export-stl"></button>';
  modelGroup = new THREE.Group();
  clearWarnings();

  state.shapeKind = 'disc';
  state.parsed = null;
  state.stlRefMesh = null;
  state.disc = { diameter: 80, thickness: 4 };
  state.colorSettings = {};
  state.mergeGroups = [];
  state.baseColorKey = null;
  state.baseColorMembers = [];
  state.keptApart = [];
  state.assembly.kindId = null;
  state.assembly.parts = [];
  state.artworks = [];
  state.sources = [];
  state.activeArtworkId = null;

  vi.mocked(buildGeometry).mockReset().mockResolvedValue(flatBuild());
  vi.mocked(buildAssemblyGeometry).mockReset().mockResolvedValue(assemblyBuild());
  vi.mocked(renderColorList).mockClear();
  vi.mocked(refreshGizmo).mockClear();
  vi.mocked(refreshZonePickMeshes).mockClear();
  vi.mocked(schedulePersist).mockClear();
  vi.mocked(setPreferredViewDir).mockClear();
});

afterEach(() => {
  state.assembly.kindId = null;
  state.shapeKind = 'disc';
});

describe('rebuildCurrent: what every rebuild does regardless of mode', () => {
  it('refreshes the gizmo and zone picking, and keeps the autosave current', async () => {
    await rebuildCurrent();

    expect(refreshGizmo).toHaveBeenCalled();
    expect(refreshZonePickMeshes).toHaveBeenCalled();
    expect(schedulePersist).toHaveBeenCalled();
  });

  it('routes to the assembly path in assembly mode, and the flat path otherwise', async () => {
    state.shapeKind = 'assembly';
    state.assembly.kindId = 'wheel';
    state.parsed = parsedSquare();

    await rebuildCurrent();

    expect(buildAssemblyGeometry).toHaveBeenCalled();
    expect(buildGeometry).not.toHaveBeenCalled();
  });
});

describe('flat mode with no artwork yet', () => {
  it('still shows the bare plate, so picking a shape gives instant feedback', async () => {
    await rebuildCurrent();

    const meshes: THREE.Mesh[] = [];
    modelGroup.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    expect(meshes).toHaveLength(1);
    expect(buildGeometry).not.toHaveBeenCalled();
  });

  it('disables export and reports the plate’s triangle count', async () => {
    await rebuildCurrent();

    expect(exportDisabled()).toBe(true);
    expect(triStat()).toMatch(/^\d+ tris$/);
    expect(triStat()).not.toBe('0 tris');
  });

  it('clears the color list rather than leaving the previous design’s rows up', async () => {
    await rebuildCurrent();

    expect(renderColorList).toHaveBeenCalledWith(null);
  });

  it('adds the STL reference mesh only in stl mode', async () => {
    // needs real positions: the tri-count stat traverses every mesh in the group
    const refGeo = new THREE.BufferGeometry();
    refGeo.setAttribute('position', new THREE.BufferAttribute(tri(), 3));
    const ref = new THREE.Mesh(refGeo);
    state.stlRefMesh = ref;

    state.shapeKind = 'disc';
    await rebuildCurrent();
    expect(modelGroup.children).not.toContain(ref);

    state.shapeKind = 'stl';
    state.stlPlate = { width: 80, height: 60, thickness: 4, faceZ: 0 };
    await rebuildCurrent();
    expect(modelGroup.children).toContain(ref);
  });
});

describe('flat mode with artwork', () => {
  beforeEach(() => {
    state.parsed = parsedSquare();
  });

  it('hands the build the current shape, depth and color settings', async () => {
    state.globalDepth = 1.5;
    state.recessBg = true;

    await rebuildCurrent();

    expect(buildGeometry).toHaveBeenCalledWith(
      expect.objectContaining({
        parsed: state.parsed,
        shapeKind: 'disc',
        globalDepth: 1.5,
        recessBg: true,
      }),
    );
  });

  it('puts the built base and every color mesh in the scene, and enables export', async () => {
    await rebuildCurrent();

    const meshes: THREE.Mesh[] = [];
    modelGroup.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    expect(meshes).toHaveLength(1); // the one color mesh; baseGroup is empty in this fixture
    expect(exportDisabled()).toBe(false);
  });

  it('builds one color-list row per color mesh, with the raw detected count', async () => {
    vi.mocked(buildGeometry).mockResolvedValue(
      flatBuild({
        colorMeshes: [colorMesh('#ff0000', 60), colorMesh('#00ff00', 40)],
        detectedColors: [
          { hex: '#ff0000', areaPct: 60 },
          { hex: '#00ff00', areaPct: 30 },
          { hex: '#0000ff', areaPct: 10 },
        ],
      }),
    );

    await rebuildCurrent();

    const [entries, meta] = vi.mocked(renderColorList).mock.calls.at(-1)!;
    expect(entries!.map((e) => e.color)).toEqual(['#ff0000', '#00ff00']);
    expect(meta).toMatchObject({ rawColorCount: 3 });
  });

  it('counts the background recess as a color, since it prints and costs a slot', async () => {
    // it is not in detectedColors: the app adds it, the artwork doesn't carry it. Left out, the
    // slot line disagreed with the colors chip beside it and showed the body's "+1" as +2.
    vi.mocked(buildGeometry).mockResolvedValue(
      flatBuild({
        colorMeshes: [
          colorMesh('#ff0000', 60),
          { ...colorMesh('#cfd6dc', 40), isBackground: true },
        ],
        detectedColors: [{ hex: '#ff0000', areaPct: 60 }],
      }),
    );

    await rebuildCurrent();

    const [entries, meta] = vi.mocked(renderColorList).mock.calls.at(-1)!;
    // 2 rows -> 3 slots with the body, and the left of the arrow now agrees with the chip
    expect(entries).toHaveLength(2);
    expect(meta).toMatchObject({ rawColorCount: 2 });
  });

  it('adds a base row and syncs the dominant member the build picked', async () => {
    state.baseColorKey = '#ee0000'; // a stale guess from addToBase
    state.baseColorMembers = ['#ee0000', '#ff0000'];
    vi.mocked(buildGeometry).mockResolvedValue(
      flatBuild({ baseAssigned: { hex: '#ff0000', areaPct: 25 } }),
    );

    await rebuildCurrent();

    const [entries] = vi.mocked(renderColorList).mock.calls.at(-1)!;
    const base = entries!.find((e) => e.isBase)!;
    expect(base).toMatchObject({ color: '#ff0000', key: 'base:#ff0000', areaPct: 25 });
    expect(base.members).toEqual(['#ee0000', '#ff0000']);
    // the build's answer wins over the provisional seed
    expect(state.baseColorKey).toBe('#ff0000');
  });

  it('clears the last build when the build refuses, so export has nothing stale to reach for', async () => {
    // A refused flat build returns early without re-disabling the button, so it can stay
    // enabled from the previous successful build — clicking it is a no-op, because
    // exportPanel guards on getLastBuild() being null. The null is what protects the user.
    await rebuildCurrent();
    expect(exportDisabled()).toBe(false);

    vi.mocked(buildGeometry).mockResolvedValue(null);
    await rebuildCurrent();

    expect(getLastBuild()).toBeNull();
  });

  it('exposes the last build for the exporter to reuse', async () => {
    const built = flatBuild();
    vi.mocked(buildGeometry).mockResolvedValue(built);

    await rebuildCurrent();

    expect(getLastBuild()).toBe(built);
  });
});

describe('assembly mode with no artwork yet', () => {
  beforeEach(() => {
    state.shapeKind = 'assembly';
    state.assembly.kindId = 'wheel';
  });

  it('shows the bare parts so selecting the assembly is not an empty viewport', async () => {
    state.assembly.parts = [asmPart()];

    await rebuildCurrent();

    const meshes: THREE.Mesh[] = [];
    modelGroup.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    expect(meshes).toHaveLength(1);
    expect(triStat()).toBe('1 tris');
    expect(exportDisabled()).toBe(true);
  });

  it('counts only loaded parts', async () => {
    state.assembly.parts = [asmPart({ id: 1 }), asmPart({ id: 2, loaded: false })];

    await rebuildCurrent();

    expect(triStat()).toBe('1 tris');
  });

  it('reports zero rather than a stale count when nothing has loaded', async () => {
    state.assembly.parts = [asmPart({ loaded: false })];

    await rebuildCurrent();

    expect(triStat()).toBe('0 tris');
  });

  it('opens the view from the design-face side', async () => {
    state.assembly.parts = [asmPart()];

    await rebuildCurrent();

    expect(setPreferredViewDir).toHaveBeenCalledWith(expect.anything());
  });
});

describe('assembly mode with artwork', () => {
  beforeEach(() => {
    state.shapeKind = 'assembly';
    state.assembly.kindId = 'wheel';
    state.parsed = parsedSquare();
    state.assembly.parts = [asmPart()];
  });

  it('adds a body mesh plus one inlay mesh per color, and totals their triangles', async () => {
    await rebuildCurrent();

    const meshes: THREE.Mesh[] = [];
    modelGroup.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    expect(meshes).toHaveLength(2); // body + one inlay
    expect(triStat()).toBe('2 tris');
    expect(exportDisabled()).toBe(false);
  });

  it('normalizes the color rows to percentages of the inlay area', async () => {
    vi.mocked(buildAssemblyGeometry).mockResolvedValue(
      assemblyBuild({
        partOutputs: [
          {
            part: asmPart(),
            bodySoup: tri(),
            // 3 triangles of colour 0, 1 of colour 1
            inlaySoups: {
              0: new Float32Array(27),
              1: new Float32Array(9),
            },
          },
        ] as AssemblyBuild['partOutputs'],
        palette: [
          { hex: '#ff0000', key: '#ff0000', members: ['#ff0000'], isMerge: false },
          { hex: '#00ff00', key: '#00ff00', members: ['#00ff00'], isMerge: false },
        ],
      }),
    );

    await rebuildCurrent();

    const [entries] = vi.mocked(renderColorList).mock.calls.at(-1)!;
    expect(entries!.map((e) => e.color)).toEqual(['#ff0000', '#00ff00']);
    expect(entries![0].areaPct).toBeCloseTo(75, 6);
    expect(entries![1].areaPct).toBeCloseTo(25, 6);
  });

  it('drops a palette color with no inlay area anywhere, so it costs no filament slot', async () => {
    // the export drops the same color from its materials (exportPanel.ts), so the visible rows
    // are the slot count
    vi.mocked(buildAssemblyGeometry).mockResolvedValue(
      assemblyBuild({
        partOutputs: [
          { part: asmPart(), bodySoup: tri(), inlaySoups: { 0: tri(1) } },
        ] as AssemblyBuild['partOutputs'],
        palette: [
          { hex: '#ff0000', key: '#ff0000', members: ['#ff0000'], isMerge: false },
          { hex: '#00ff00', key: '#00ff00', members: ['#00ff00'], isMerge: false },
        ],
      }),
    );

    await rebuildCurrent();

    const [entries, meta] = vi.mocked(renderColorList).mock.calls.at(-1)!;
    expect(entries).toHaveLength(1); // only one color actually cut anything
    expect(meta).not.toHaveProperty('slotsNeeded');
  });

  it('does not count an inlay whose only part was consumed by its own cut', async () => {
    // the export drops a part with an empty bodySoup, inlays and all, so a color living only
    // there ships no filament and must not get a row or a slot
    vi.mocked(buildAssemblyGeometry).mockResolvedValue(
      assemblyBuild({
        partOutputs: [
          { part: asmPart(), bodySoup: new Float32Array(0), inlaySoups: { 0: tri(1) } },
          { part: asmPart({ id: 2 }), bodySoup: tri(), inlaySoups: { 1: tri(1) } },
        ] as AssemblyBuild['partOutputs'],
        palette: [
          { hex: '#ff0000', key: '#ff0000', members: ['#ff0000'], isMerge: false },
          { hex: '#00ff00', key: '#00ff00', members: ['#00ff00'], isMerge: false },
        ],
      }),
    );

    await rebuildCurrent();

    const [entries] = vi.mocked(renderColorList).mock.calls.at(-1)!;
    expect(entries!.map((e) => e.color)).toEqual(['#00ff00']);
  });

  it('keeps the bare parts on screen when the build fails, rather than emptying the viewport', async () => {
    vi.mocked(buildAssemblyGeometry).mockResolvedValue(null as unknown as AssemblyBuild);

    await rebuildCurrent();

    const meshes: THREE.Mesh[] = [];
    modelGroup.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    expect(meshes).toHaveLength(1); // the raw part
    expect(exportDisabled()).toBe(true);
    expect(renderColorList).toHaveBeenCalledWith(null);
  });

  it('disables export when the build produced no parts at all', async () => {
    vi.mocked(buildAssemblyGeometry).mockResolvedValue(assemblyBuild({ partOutputs: [] }));

    await rebuildCurrent();

    expect(exportDisabled()).toBe(true);
  });

  it('exposes the last assembly build for the exporter', async () => {
    const built = assemblyBuild();
    vi.mocked(buildAssemblyGeometry).mockResolvedValue(built);

    await rebuildCurrent();

    expect(getLastAssemblyBuild()).toBe(built);
  });
});

describe('the display pose', () => {
  beforeEach(() => {
    state.shapeKind = 'assembly';
    state.assembly.kindId = 'wheel';
    state.assembly.parts = [asmPart()];
  });

  it('stands the assembly on the grid and centers it over the origin', async () => {
    await rebuildCurrent();

    modelGroup.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(modelGroup);
    // resting on the grid, not sunk into it or floating
    expect(box.min.z).toBeCloseTo(0, 6);
    // centered over the origin in plan
    const center = box.getCenter(new THREE.Vector3());
    expect(center.x).toBeCloseTo(0, 6);
    expect(center.y).toBeCloseTo(0, 6);
  });

  it('leaves an empty assembly where it is rather than dividing by an empty box', async () => {
    state.assembly.parts = [];

    await rebuildCurrent();

    expect(modelGroup.position.x).toBe(0);
    expect(modelGroup.position.y).toBe(0);
    expect(modelGroup.position.z).toBe(0);
  });
});

describe('the blank-zone notice', () => {
  beforeEach(() => {
    state.shapeKind = 'assembly';
    state.assembly.kindId = 'chair-body';
    state.parsed = parsedSquare();
  });

  const zoned = (id: number, zoneIds: string[]) =>
    asmPart({
      id,
      zones: zoneIds.map((z) => ({ id: z, name: z, chart: undefined })),
    });

  it('warns when a multi-zone part has zones nobody has covered', async () => {
    state.assembly.parts = [zoned(1, ['front', 'back', 'seat'])];
    state.sources = [{ id: 's1', name: 'a.svg' } as unknown as (typeof state.sources)[number]];
    state.artworks = [
      {
        id: 'a1',
        sourceId: 's1',
        zone: { partId: 1, zoneId: 'front' },
        offsetU: 0,
        offsetV: 0,
        scalePct: 100,
        rotationDeg: 0,
        flipX: false,
        flipY: false,
        mode: 'sticker',
      } as unknown as (typeof state.artworks)[number],
    ];

    await rebuildCurrent();

    const msg = WARNINGS.map((w) => w.message).join('\n');
    expect(msg).toContain('Placed on "front"');
    expect(msg).toContain('2 of 3 zones still blank');
  });

  it('says nothing when every zone is covered', async () => {
    state.assembly.parts = [zoned(1, ['front'])];
    state.artworks = [
      {
        id: 'a1',
        sourceId: 's1',
        zone: null, // unbound = covers every zone
        offsetU: 0,
        offsetV: 0,
        scalePct: 100,
        rotationDeg: 0,
        flipX: false,
        flipY: false,
        mode: 'sticker',
      } as unknown as (typeof state.artworks)[number],
    ];

    await rebuildCurrent();

    expect(WARNINGS.map((w) => w.message).join('\n')).not.toContain('still blank');
  });

  it('says nothing for a single-zone part, where there is no choice to make', async () => {
    state.assembly.parts = [asmPart()];

    await rebuildCurrent();

    expect(WARNINGS.map((w) => w.message).join('\n')).not.toContain('still blank');
  });
});

describe('a part whose shape follows the artwork sees the current placement', () => {
  it('syncs the instance before regenerating, not after', async () => {
    // The fit sliders and the gizmo write the legacy globals; the generated part reads the
    // instance. Regenerating first built the outline from the PREVIOUS scale while the cut used
    // the new one, so a scaled silhouette came out the old size — the exact drift the shared
    // placement seam exists to prevent, reintroduced by ordering alone.
    state.shapeKind = 'assembly';
    state.assembly.kindId = 'hubcap';
    state.hubcapSilhouette = true;
    state.assembly.parts = [asmPart({ roleId: 'hubcap' })];
    state.parsed = parsedSquare();
    state.sources = [
      { id: 's1', kind: 'raster', name: 'a.png', parsed: state.parsed, svgText: '' },
    ] as unknown as typeof state.sources;
    state.artworks = [
      {
        id: 'a1',
        sourceId: 's1',
        zone: null,
        offsetU: 0,
        offsetV: 0,
        scalePct: 100, // the instance is stale…
        rotationDeg: 0,
        flipX: false,
        flipY: false,
        mode: 'sticker',
      } as unknown as (typeof state.artworks)[number],
    ];
    state.activeArtworkId = 'a1';
    state.scalePct = 250; // …and the slider has moved

    let scaleAtRegen: number | undefined;
    vi.mocked(asmRebuildGeneratedParts).mockImplementation(async () => {
      scaleAtRegen = state.artworks[0]?.scalePct;
      return true;
    });

    await rebuildCurrent();

    expect(scaleAtRegen).toBe(250);

    state.hubcapSilhouette = false;
  });
});
