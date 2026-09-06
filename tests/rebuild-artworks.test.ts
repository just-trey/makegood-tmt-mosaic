// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// rebuild.ts is the orchestration hub, so importing it pulls in the whole scene/UI graph. Only the
// state → build-input expansion is under test here; everything it would touch to actually build is
// stubbed out, exactly as tests/rebuild-cost.test.ts does.
vi.mock('../src/scene/viewport', () => ({
  frameModelIfPending: vi.fn(),
  getModelGroup: vi.fn(() => ({ traverse: vi.fn() })),
  newModelGroup: vi.fn(() => ({ add: vi.fn(), traverse: vi.fn() })),
  refreshModelShadows: vi.fn(),
  setPreferredViewDir: vi.fn(),
  requestFrame: vi.fn(),
}));
vi.mock('../src/scene/designGizmo', () => ({
  refreshGizmo: vi.fn(),
  isGizmoDragging: () => false,
  tokenColor: (_name: string, fallback: number) => fallback,
}));
vi.mock('../src/scene/zonePick', () => ({ refreshZonePickMeshes: vi.fn() }));
vi.mock('../src/ui/colorList', () => ({ renderColorList: vi.fn() }));
vi.mock('../src/ui/partPanel', () => ({ renderBaseColorSwatches: vi.fn() }));
vi.mock('../src/ui/warningsView', () => ({ renderWarnings: vi.fn() }));
vi.mock('../src/state/persist', () => ({ schedulePersist: vi.fn() }));
vi.mock('../src/ui/dom', () => ({ $: vi.fn(() => ({ textContent: '', disabled: false })) }));

import { artworkBuildInputs } from '../src/app/rebuild';
import { loadArtworkSource, setArtworkZone } from '../src/state/artwork';
import { state } from '../src/state/store';
import { WHOLE_CHAIR_ZONE } from '../src/geometry/zones';
import { clearWarnings, WARNINGS } from '../src/warnings';
import type { AssemblyPart, ParsedSVG } from '../src/types';

const parsed = (): ParsedSVG => ({
  shapes: [],
  bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
  rawSVGCircle: null,
});

const chart = {
  positions3: new Float32Array(),
  uv: new Float32Array(),
  triangles: new Uint32Array(),
  normalSign: 1,
  boundary: [],
  zoneBounds: { minU: 0, minV: 0, maxU: 10, maxV: 10 },
};

const zonedPart = (id: number, zoneId: string, name: string, charted = false): AssemblyPart =>
  ({
    id,
    name: `part-${id}`,
    roleId: 'r',
    positions: null,
    patches: null,
    patchIdx: 0,
    boundaryLoops: null,
    zones: [{ id: zoneId, name, ...(charted ? { chart } : {}) }],
    topZ: 0,
    baseDepth: 1,
    isDuplicateOf: null,
    pivotX: 0,
    pivotZ: 0,
    angleDeg: 0,
    loaded: true,
    cutThrough: false,
  }) as unknown as AssemblyPart;

/** A net placing exactly these zones, each at a neutral transform, under the names given. */
const netOf = (named: Record<string, string>): NonNullable<typeof state.assembly.net> => ({
  templateFile: 'net-template.svg',
  bounds: { minU: 0, minV: 0, maxU: 20, maxV: 20 },
  zones: Object.fromEntries(
    Object.entries(named).map(([id, name]) => [
      id,
      { name, rotationDeg: 0, offsetU: 0, offsetV: 0, attached: true },
    ]),
  ),
});

beforeEach(() => {
  clearWarnings();
  state.sources = [];
  state.artworks = [];
  state.activeArtworkId = null;
  state.parsed = null;
  state.offsetX = 0;
  state.offsetY = 0;
  state.scalePct = 100;
  state.rotationDeg = 0;
  state.flipX = false;
  state.flipY = false;
  state.shapeKind = 'assembly';
  state.assembly.parts = [];
  state.assembly.net = null;
});

describe('artworkBuildInputs — a whole-part binding with no net', () => {
  it('cuts nothing rather than falling back to the unbound legacy placement', () => {
    state.assembly.parts = [zonedPart(1, 'left', 'Left'), zonedPart(2, 'seat', 'Seat')];
    const a = loadArtworkSource(parsed(), 'a.svg');
    setArtworkZone(a.id, WHOLE_CHAIR_ZONE);

    const inputs = artworkBuildInputs();

    // The fallback would push a zoneId:null placement, which cuts on EVERY zone at the global
    // offset — the design stamped everywhere, right after the app said it would not be cut at all.
    expect(inputs).toEqual([]);
    expect(WARNINGS.map((w) => w.message)).toEqual([
      expect.stringContaining('is set to cover the whole part'),
    ]);
  });

  it('still falls back to the globals when there is no instance at all', () => {
    // Flat mode's own source of truth: state.parsed with an empty pool is the one case the fallback
    // is for, and it is unchanged.
    state.parsed = parsed();
    state.offsetX = 12;

    const inputs = artworkBuildInputs();

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ zoneId: null, offX: 12, mode: 'sticker' });
  });
});

// Every other string on screen reads a zone by the name the dropdown shows it under, so these two
// did not get to spell it "wing-left".
describe('artworkBuildInputs — zones the net and the parts disagree about', () => {
  const bind = (): void => {
    const a = loadArtworkSource(parsed(), 'a.svg');
    setArtworkZone(a.id, WHOLE_CHAIR_ZONE);
  };

  it('names a zone the net places that nothing loaded by its display name', () => {
    state.assembly.parts = [zonedPart(1, 'left', 'Left side', true)];
    state.assembly.net = netOf({ left: 'Left side', 'wing-left': 'Left wing' });
    bind();

    artworkBuildInputs();

    expect(WARNINGS.map((w) => w.message)).toContain(
      `The "Left wing" zone isn't loaded, so "a.svg" won't be cut there. Reload the page to try again.`,
    );
  });

  it('names a loaded zone the net does not place by its display name', () => {
    state.assembly.parts = [
      zonedPart(1, 'left', 'Left side', true),
      zonedPart(2, 'seat-left', 'Left seat', true),
    ];
    state.assembly.net = netOf({ left: 'Left side' });
    bind();

    artworkBuildInputs();

    expect(WARNINGS.map((w) => w.message)).toContain(
      `The "Left seat" zone isn't on the whole-part sheet, so "a.svg" won't reach it. Add another design and target that zone.`,
    );
  });
});
