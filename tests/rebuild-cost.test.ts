// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// rebuild.ts is the orchestration hub, so importing it pulls in the whole scene/UI graph. Only the
// cost estimate and the last-build accessors are under test here — everything it would touch to
// actually build is stubbed out. The build paths themselves are exercised by `npm run smoke`,
// which drives them in a real browser against the real engine.
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
  // rebuild.ts reads the accent token through this for the hidden-surface hatch. Absent from the
  // mock it is undefined, and any path here that reaches the overlay dies on a call to it.
  tokenColor: (_name: string, fallback: number) => fallback,
}));
vi.mock('../src/scene/zonePick', () => ({ refreshZonePickMeshes: vi.fn() }));
vi.mock('../src/ui/colorList', () => ({ renderColorList: vi.fn() }));
vi.mock('../src/ui/partPanel', () => ({ renderBaseColorSwatches: vi.fn() }));
vi.mock('../src/ui/warningsView', () => ({ renderWarnings: vi.fn() }));
vi.mock('../src/state/persist', () => ({ schedulePersist: vi.fn() }));
vi.mock('../src/ui/dom', () => ({ $: vi.fn(() => ({ textContent: '', disabled: false })) }));

import { estimateRebuildSlow, getLastAssemblyBuild, getLastBuild } from '../src/app/rebuild';
import { state } from '../src/state/store';
import type { ParsedSVG, SVGShape } from '../src/types';

/** One shape whose single loop carries `points` vertices. */
function parsedWithPoints(points: number): ParsedSVG {
  const loop = Array.from({ length: points }, (_, i) => ({ x: i, y: i }));
  return {
    shapes: [{ fill: '#ff0000', order: 0, loops: [loop] }] as SVGShape[],
    bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    rawSVGCircle: null,
  } as ParsedSVG;
}

/** The same total point count, spread over many small shapes instead of one big loop. */
function parsedAcrossShapes(shapes: number, pointsEach: number): ParsedSVG {
  const loop = Array.from({ length: pointsEach }, (_, i) => ({ x: i, y: i }));
  return {
    shapes: Array.from({ length: shapes }, (_, order) => ({
      fill: '#ff0000',
      order,
      loops: [loop],
    })) as SVGShape[],
    bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    rawSVGCircle: null,
  } as ParsedSVG;
}

beforeEach(() => {
  state.parsed = null;
  state.shapeKind = 'disc';
});

describe('estimateRebuildSlow', () => {
  it('is fast with no artwork — a bare plate renders instantly', () => {
    expect(estimateRebuildSlow()).toBe(false);
  });

  it('is fast with no artwork even in assembly mode', () => {
    state.shapeKind = 'assembly';
    state.parsed = null;

    expect(estimateRebuildSlow()).toBe(false);
  });

  it('is always slow in assembly mode once there is artwork — every part gets 3D CSG', () => {
    state.shapeKind = 'assembly';
    state.parsed = parsedWithPoints(3); // a triangle, as simple as artwork gets

    expect(estimateRebuildSlow()).toBe(true);
  });

  it('is fast for a simple flat design, like the sample badge', () => {
    state.parsed = parsedWithPoints(100);

    expect(estimateRebuildSlow()).toBe(false);
  });

  it('is slow for a dense flat design', () => {
    state.parsed = parsedWithPoints(5000);

    expect(estimateRebuildSlow()).toBe(true);
  });

  it('sums points across every shape and loop, not just the largest one', () => {
    // no single shape is dense, but 100 × 50 = 5000 points together is
    state.parsed = parsedAcrossShapes(100, 50);

    expect(estimateRebuildSlow()).toBe(true);
  });

  it('sits right on the documented 4000-point threshold', () => {
    state.parsed = parsedWithPoints(4000);
    expect(estimateRebuildSlow()).toBe(false); // strictly greater than, so 4000 is still fast

    state.parsed = parsedWithPoints(4001);
    expect(estimateRebuildSlow()).toBe(true);
  });

  it('is cheap — it must not touch the parsed geometry beyond counting', () => {
    const parsed = parsedWithPoints(10);
    const before = JSON.stringify(parsed);
    state.parsed = parsed;

    estimateRebuildSlow();

    expect(JSON.stringify(parsed)).toBe(before);
  });
});

describe('the last build', () => {
  it('is null before anything has been built', () => {
    expect(getLastBuild()).toBeNull();
    expect(getLastAssemblyBuild()).toBeNull();
  });
});
