import { describe, expect, it } from 'vitest';
import { footprintFeature } from '../src/geometry/flat';
import type { BaseParams, ShapeKind } from '../src/types';

/** Local, like the module-local alias in flat.ts — a footprint ring is a list of [x, y]. */
type Ring = [number, number][];

const ringOf = (kind: ShapeKind, params: Partial<BaseParams>): Ring =>
  footprintFeature(kind, params as BaseParams).geometry.coordinates[0] as Ring;

const closed = (ring: Ring): boolean =>
  ring.length > 1 &&
  ring[0][0] === ring[ring.length - 1][0] &&
  ring[0][1] === ring[ring.length - 1][1];

function bboxOf(ring: Ring) {
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

/**
 * Corner arcs are polygonal (12 segments per 90°), so they inscribe the true fillet and enclose
 * a hair less than it — compare against the ideal circle within a relative tolerance instead of
 * pinning the segment count.
 */
function expectWithinPct(actual: number, ideal: number, pct: number, label: string): void {
  expect(Math.abs(actual - ideal) / ideal, `${label}: ${actual} vs ideal ${ideal}`).toBeLessThan(
    pct / 100,
  );
}

/** Shoelace area — sign-independent, so it works whatever winding the ring came out with. */
function area(ring: Ring): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(a) / 2;
}

describe('footprintFeature: disc', () => {
  it('is a closed circle centered on the origin at the requested diameter', () => {
    const ring = ringOf('disc', { diameter: 80 });

    expect(closed(ring)).toBe(true);
    const bbox = bboxOf(ring);
    expect(bbox.minX).toBeCloseTo(-40, 6);
    expect(bbox.maxX).toBeCloseTo(40, 6);
    expect(bbox.minY).toBeCloseTo(-40, 6);
    expect(bbox.maxY).toBeCloseTo(40, 6);
  });

  it('encloses very nearly πr² — the 128-gon is within 0.1% of the true circle', () => {
    const ring = ringOf('disc', { diameter: 80 });

    expect(area(ring)).toBeCloseTo(Math.PI * 40 * 40, -1);
    expect(area(ring) / (Math.PI * 40 * 40)).toBeGreaterThan(0.999);
  });
});

describe('footprintFeature: rect and stl', () => {
  it('is a closed rectangle centered on the origin', () => {
    const ring = ringOf('rect', { width: 80, height: 60 });

    expect(closed(ring)).toBe(true);
    expect(ring).toEqual([
      [-40, -30],
      [40, -30],
      [40, 30],
      [-40, 30],
      [-40, -30],
    ]);
  });

  it('treats stl exactly like rect — the plate under an imported mesh is the same footprint', () => {
    expect(ringOf('stl', { width: 80, height: 60 })).toEqual(
      ringOf('rect', { width: 80, height: 60 }),
    );
  });

  it('encloses width × height', () => {
    expect(area(ringOf('rect', { width: 100, height: 40 }))).toBeCloseTo(4000, 6);
  });
});

describe('footprintFeature: round', () => {
  it('is closed and stays within the requested width and height', () => {
    const ring = ringOf('round', { width: 80, height: 60, corner: 8 });

    expect(closed(ring)).toBe(true);
    const bbox = bboxOf(ring);
    expect(bbox.minX).toBeCloseTo(-40, 6);
    expect(bbox.maxX).toBeCloseTo(40, 6);
    expect(bbox.minY).toBeCloseTo(-30, 6);
    expect(bbox.maxY).toBeCloseTo(30, 6);
  });

  it('rounds the corners off, so it encloses less than the full rectangle', () => {
    const rounded = area(ringOf('round', { width: 80, height: 60, corner: 8 }));
    const square = area(ringOf('rect', { width: 80, height: 60 }));

    expect(rounded).toBeLessThan(square);
    // four corners lose (r² - πr²/4) each
    expectWithinPct(square - rounded, 4 * (64 - (Math.PI * 64) / 4), 2, 'corner area lost');
  });

  it('clamps the corner radius to the half-extent, so an over-large corner degenerates to a stadium, not a self-crossing ring', () => {
    // corner 999 on an 80×60 plate must clamp to 30 (half the height)
    const ring = ringOf('round', { width: 80, height: 60, corner: 999 });

    const bbox = bboxOf(ring);
    expect(bbox.minX).toBeCloseTo(-40, 6);
    expect(bbox.maxX).toBeCloseTo(40, 6);
    expect(bbox.minY).toBeCloseTo(-30, 6);
    expect(bbox.maxY).toBeCloseTo(30, 6);
    // a stadium: the 80×60 rect minus the four quarter-corners at r=30
    expectWithinPct(area(ring), 4800 - (4 * 900 - Math.PI * 900), 1, 'stadium area');
  });

  it('a zero corner radius gives back the plain rectangle area', () => {
    expect(area(ringOf('round', { width: 80, height: 60, corner: 0 }))).toBeCloseTo(4800, 0);
  });
});

describe('footprintFeature: degenerate input', () => {
  it('returns an empty ring for a kind with no flat footprint', () => {
    expect(ringOf('assembly', {})).toEqual([]);
  });

  it('treats missing dimensions as zero rather than producing NaN coordinates', () => {
    for (const kind of ['disc', 'rect', 'round', 'stl'] as const) {
      const ring = ringOf(kind, {});
      for (const [x, y] of ring) {
        expect(Number.isFinite(x), `${kind} x`).toBe(true);
        expect(Number.isFinite(y), `${kind} y`).toBe(true);
      }
    }
  });
});
