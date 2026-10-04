import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { AssemblyPart, ParsedSVG, PolyFeature } from '../src/types';

// What happens when one color of a fill cannot be tiled at build time is a question about the
// build, not about the clipping engine, so the engine's answer is stood in for: tileFeature is
// swapped per test, and runs for real everywhere else.
const tiling = vi.hoisted(() => ({
  override: null as null | ((hex: string) => PolyFeature | 'too-big' | undefined),
}));
vi.mock('../src/geometry/patterns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/geometry/patterns')>();
  const { UnionTooBig } = await import('../src/geometry/regions');
  return {
    ...actual,
    tileFeature: async (...args: Parameters<typeof actual.tileFeature>) => {
      const hex = /color (#[0-9a-f]{6})/.exec(args[3] ?? '')?.[1] ?? '';
      const r = tiling.override?.(hex);
      if (r === 'too-big') throw new UnionTooBig();
      return r ?? actual.tileFeature(...args);
    },
  };
});
// A polygon over the cap that reaches the clip to the face would go on to be extruded, which takes
// many minutes, so a build that lets one through fails here at once instead.
vi.mock('../src/geometry/regions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/geometry/regions')>();
  return {
    ...actual,
    safeIntersectChecked: (...args: Parameters<typeof actual.safeIntersectChecked>) => {
      if (!actual.fitsBesideClips(args[0], [], actual.SWEEP_SEGMENT_CAP / 2))
        throw new Error('a polygon too big to clip reached the clip');
      return actual.safeIntersectChecked(...args);
    },
    differenceAllChecked: (...args: Parameters<typeof actual.differenceAllChecked>) => {
      if (!actual.fitsBesideClips(args[0], [], actual.SWEEP_SEGMENT_CAP / 2))
        throw new Error('a polygon too big to clip reached the stickers');
      return actual.differenceAllChecked(...args);
    },
  };
});

const { buildAssemblyGeometry } = await import('../src/geometry/assembly');
const { SWEEP_SEGMENT_CAP } = await import('../src/geometry/regions');
const { WARNINGS, clearWarnings, warnBuild } = await import('../src/warnings');

function boxPart(): AssemblyPart {
  const geo = new THREE.BoxGeometry(40, 10, 40).toNonIndexed();
  geo.translate(0, 5, 0);
  return {
    id: 1,
    name: 'test box',
    roleId: 'role',
    positions: Float32Array.from(geo.attributes.position.array as Float32Array),
    patches: null,
    patchIdx: 0,
    boundaryLoops: [
      [
        [-20, 10, -20],
        [20, 10, -20],
        [20, 10, 20],
        [-20, 10, 20],
      ],
    ],
    patchNormal: [0, 1, 0],
    topZ: 10,
    baseDepth: 0,
    isDuplicateOf: null,
    pivotX: 0,
    pivotZ: 0,
    angleDeg: 0,
    loaded: true,
    cutThrough: false,
  };
}

const square = (x: number, y: number, s: number) => [
  { x, y },
  { x: x + s, y },
  { x: x + s, y: y + s },
  { x, y: y + s },
  { x, y },
];

/** A red and a blue 2mm square in one 10mm tile, so a single copy is easy to tell from a fill. */
function twoDots(): ParsedSVG {
  return {
    shapes: [
      { fill: '#ff0000', loops: [square(1, 1, 2)], order: 0 },
      { fill: '#0000ff', loops: [square(6, 6, 2)], order: 1 },
    ],
    bbox: { minX: 1, minY: 1, maxX: 8, maxY: 8 },
    rawSVGCircle: null,
    userUnitMM: 1,
    viewBox: { w: 10, h: 10 },
  };
}

/** A green `pts`-gon sticker in the middle of the face. */
function sticker(pts: number): ParsedSVG {
  const ring = Array.from({ length: pts }, (_, k) => {
    const t = (2 * Math.PI * k) / pts;
    return { x: 5 + 3 * Math.cos(t), y: 5 + 3 * Math.sin(t) };
  });
  return {
    shapes: [{ fill: '#00ff00', loops: [[...ring, ring[0]]], order: 0 }],
    bbox: { minX: 2, minY: 2, maxX: 8, maxY: 8 },
    rawSVGCircle: null,
    userUnitMM: 1,
    viewBox: { w: 10, h: 10 },
  };
}

const placed = {
  zoneId: null,
  scaleMult: 1,
  maxScaleMult: 4,
  offX: 0,
  offZ: 0,
  flipX: false,
  flipY: false,
  rotationDeg: 0,
};

function build(withSticker = false, scaleMult = 1) {
  return buildAssemblyGeometry({
    artworks: [
      { ...placed, scaleMult, parsed: twoDots(), name: 'dots.svg', mode: 'fill' },
      ...(withSticker
        ? [{ ...placed, parsed: sticker(64), name: 'badge.svg', mode: 'sticker' as const }]
        : []),
    ],
    parts: [boxPart()],
    mergeGroups: [],
    colorSettings: {},
    globalDepth: 2,
    radius: 10,
  });
}

function xWidth(soup: Float32Array): number {
  let lo = Infinity,
    hi = -Infinity;
  for (let i = 0; i < soup.length; i += 3) {
    lo = Math.min(lo, soup[i]);
    hi = Math.max(hi, soup[i]);
  }
  return hi - lo;
}

const refusals = (): string[] =>
  WARNINGS.map((w) => w.message).filter((m) => /too detailed/.test(m));

describe('a fill one of whose colors is too big to tile', () => {
  beforeEach(() => clearWarnings());
  afterEach(() => {
    tiling.override = null;
  });

  it('tiles both colors when nothing is too big', async () => {
    const built = (await build())!;
    expect(refusals()).toEqual([]);
    for (const soup of Object.values(built.partOutputs[0].inlaySoups))
      expect(xWidth(soup)).toBeGreaterThan(30);
  });

  // Red tiles fine and blue does not. Cutting red tiled and blue once would land them out of
  // register, so both go back to one copy, and the pill says why.
  it('places every color once, and says so, when one color cannot be tiled', async () => {
    tiling.override = (hex) => (hex === '#0000ff' ? 'too-big' : undefined);
    const built = (await build())!;
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]).toContain('"dots.svg" is too detailed to fill "test box"');
    // Blue is the one that joined, and it is not the busiest color: 5 points a tile, as red has.
    expect(refusals()[0]).not.toContain('busiest color');
    expect(refusals()[0]).toContain('joins');
    const soups = Object.values(built.partOutputs[0].inlaySoups);
    expect(soups).toHaveLength(2);
    for (const soup of soups) expect(xWidth(soup)).toBeCloseTo(2, 1);
    expect(WARNINGS.some((w) => /Couldn't merge the shapes/.test(w.message))).toBe(false);
  });

  // Scale already at its maximum can't give fewer tiles, whatever the copies would count to.
  it('does not offer Raise Scale when Scale is already at its maximum', async () => {
    tiling.override = (hex) => (hex === '#0000ff' ? 'too-big' : undefined);
    await build(false, 4);
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]).not.toMatch(/Raise Scale/);
    expect(refusals()[0]).toContain('at any Scale');
  });

  // A tiled color can come back whole and still be one polygon the clip to the face cannot take
  // alongside the face's own outline.
  it('refuses a tiled color the clip to the face could not split', async () => {
    const n = SWEEP_SEGMENT_CAP - 3;
    const ring = Array.from({ length: n }, (_, k) => {
      const t = (2 * Math.PI * k) / n;
      return [5 + 2 * Math.cos(t), 5 + 2 * Math.sin(t)];
    });
    const huge: PolyFeature = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] },
    };
    tiling.override = (hex) => (hex === '#ff0000' ? huge : undefined);
    const built = (await build())!;
    expect(refusals()).toHaveLength(1);
    for (const soup of Object.values(built.partOutputs[0].inlaySoups))
      expect(xWidth(soup)).toBeCloseTo(2, 1);
    expect(WARNINGS.some((w) => /Clipping color region/.test(w.message))).toBe(false);
  });

  // The same, against the stickers the fill gives way to: all of them share one call with it.
  it('refuses a tiled color the stickers on its zone could not be cut from', async () => {
    const n = SWEEP_SEGMENT_CAP - 30;
    const ring = Array.from({ length: n }, (_, k) => {
      const t = (2 * Math.PI * k) / n;
      return [5 + 2 * Math.cos(t), 5 + 2 * Math.sin(t)];
    });
    const huge: PolyFeature = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] },
    };
    tiling.override = (hex) => (hex === '#ff0000' ? huge : undefined);
    await build(true);
    expect(refusals()).toHaveLength(1);
    expect(WARNINGS.some((w) => /Couldn't fit/.test(w.message))).toBe(false);
  });

  // Blue tiles, with a warning about its own merge, before red refuses. Blue is then cut from its
  // single copy, which the warning is not about.
  it('drops what tiling said about a color whose tiles are thrown away', async () => {
    const tiled: string[] = [];
    tiling.override = (hex) => {
      tiled.push(hex);
      if (hex === '#ff0000') return 'too-big';
      warnBuild(`Couldn't merge the shapes for color ${hex} on test box.`);
      return undefined;
    };
    await build();
    expect(tiled).toEqual(['#0000ff', '#ff0000']);
    expect(refusals()).toHaveLength(1);
    expect(WARNINGS.some((w) => /Couldn't merge the shapes/.test(w.message))).toBe(false);
  });
});
