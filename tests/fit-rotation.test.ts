import { describe, expect, it } from 'vitest';
import { fitTransform, transformFeature } from '../src/geometry/flat';
import type { FitTransform, PolyFeature } from '../src/types';

// A design centered on the origin, unit scale, no margin/mirror — isolates the rotation term.
function centeredFit(rotationDeg: number, offsetX = 0, offsetY = 0): FitTransform {
  return fitTransform(
    { minX: -5, minY: -5, maxX: 5, maxY: 5 },
    10,
    10,
    0,
    1,
    offsetX,
    offsetY,
    false,
    false,
    rotationDeg,
  );
}

function apply(fit: FitTransform, x: number, y: number): number[] {
  const feat: PolyFeature = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [[[x, y]]] },
  } as PolyFeature;
  const g = transformFeature(feat, fit).geometry;
  return (g.coordinates as number[][][])[0][0];
}

describe('fitTransform rotation', () => {
  it('leaves the point at the SVG-y-down baseline when rotation is 0', () => {
    // baseline: xMul=+1, yMul=-1 (SVG y-down → plate y-up), no rotation
    expect(apply(centeredFit(0), 3, 4)).toEqual([3, -4]);
  });

  it('rotates a +X point to +Y at 90°', () => {
    // a point on the x-axis (y=0) so the y-down baseline doesn't muddy the assertion
    const [x, y] = apply(centeredFit(90), 1, 0);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(1, 6);
  });

  it('rotates about the design center, then applies offset', () => {
    const [x, y] = apply(centeredFit(90, 5, 2), 1, 0);
    expect(x).toBeCloseTo(5, 6);
    expect(y).toBeCloseTo(3, 6);
  });

  it('is orientation-preserving (reverse flag depends only on mirror parity)', () => {
    expect(centeredFit(0).reverse).toBe(centeredFit(37).reverse);
  });
});
