import { describe, expect, it } from 'vitest';
import { fitChain } from '../src/raster/curve';
import type { CurveParams } from '../src/raster/curve';
import type { Pt } from '../src/types';

const params = (over: Partial<CurveParams> = {}): CurveParams => ({
  alphaMax: 1,
  flatness: 0.25,
  ...over,
});

/**
 * The lattice boundary of a rasterized shape, as the tracer would walk it: unit axis steps along
 * the cracks between inside and outside pixels. Marching around the pixel grid rather than
 * hand-listing points keeps these fixtures honest about what the tracer actually produces.
 */
function boundaryOf(inside: (x: number, y: number) => boolean, w: number, h: number): Pt[] {
  let sx = -1;
  let sy = -1;
  outer: for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (inside(x, y)) {
        sx = x;
        sy = y;
        break outer;
      }
  if (sx < 0) return [];

  // Walk the crack boundary keeping the inside on the right, the same convention walkRings uses.
  // Directions are E, S, W, N; for a step in each, these are the pixels on its right and left.
  const inBounds = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && inside(x, y);
  const sides = (x: number, y: number, d: number): [boolean, boolean] => {
    if (d === 0) return [inBounds(x, y), inBounds(x, y - 1)];
    if (d === 1) return [inBounds(x - 1, y), inBounds(x, y)];
    if (d === 2) return [inBounds(x - 1, y - 1), inBounds(x - 1, y)];
    return [inBounds(x, y - 1), inBounds(x - 1, y - 1)];
  };
  const stepX = [1, 0, -1, 0];
  const stepY = [0, 1, 0, -1];

  const pts: Pt[] = [];
  let cx = sx;
  let cy = sy;
  let d = 0;
  for (let guard = 0; guard < 40000; guard++) {
    pts.push({ x: cx, y: cy });
    let next = -1;
    for (const cand of [(d + 1) & 3, d, (d + 3) & 3, (d + 2) & 3]) {
      const [rightIn, leftIn] = sides(cx, cy, cand);
      if (rightIn && !leftIn) {
        next = cand;
        break;
      }
    }
    if (next < 0) break;
    cx += stepX[next];
    cy += stepY[next];
    d = next;
    if (cx === sx && cy === sy) break;
  }
  return pts;
}

function maxDeviationFromCircle(pts: Pt[], cx: number, cy: number, r: number): number {
  let worst = 0;
  for (const p of pts) worst = Math.max(worst, Math.abs(Math.hypot(p.x - cx, p.y - cy) - r));
  return worst;
}

function signedArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** A staircase chain running diagonally, one unit step at a time. */
function diagonalChain(steps: number): Pt[] {
  const pts: Pt[] = [{ x: 0, y: 0 }];
  for (let i = 0; i < steps; i++) {
    const last = pts[pts.length - 1];
    pts.push({ x: last.x + 1, y: last.y });
    pts.push({ x: last.x + 1, y: last.y + 1 });
  }
  return pts;
}

describe('fitChain', () => {
  it('fits a rasterized circle to well under a pixel — the anti-staircase guarantee', () => {
    const r = 40;
    const c = 48;
    const chain = boundaryOf((x, y) => Math.hypot(x + 0.5 - c, y + 0.5 - c) <= r, 96, 96);
    expect(chain.length).toBeGreaterThan(200);

    const latticeDev = maxDeviationFromCircle(chain, c, c, r);
    const fitted = fitChain(chain, true, params());
    const fittedDev = maxDeviationFromCircle(fitted, c, c, r);
    const meanDev =
      fitted.reduce((s, p) => s + Math.abs(Math.hypot(p.x - c, p.y - c) - r), 0) / fitted.length;

    // Measured across r=10..80: lattice max sits at 0.63-0.69px, the fit at 0.24-0.41px, and mean
    // error drops from ~0.30 to 0.11-0.20. Bounds are set above those with room, so this fails on a
    // regression rather than on noise.
    expect(fittedDev).toBeLessThan(latticeDev);
    expect(fittedDev).toBeLessThan(0.5);
    expect(meanDev).toBeLessThan(0.25);
    // Fewer points than the lattice walk, not more — ring length feeds a quadratic downstream.
    expect(fitted.length).toBeLessThan(chain.length / 2);
  });

  it('keeps a square square — four corners, on the corners', () => {
    const chain = boundaryOf((x, y) => x >= 10 && x < 40 && y >= 10 && y < 40, 60, 60);
    const fitted = fitChain(chain, true, params());

    expect(fitted).toHaveLength(4);
    const corners = [
      { x: 10, y: 10 },
      { x: 40, y: 10 },
      { x: 40, y: 40 },
      { x: 10, y: 40 },
    ];
    for (const corner of corners) {
      const nearest = Math.min(...fitted.map((p) => Math.hypot(p.x - corner.x, p.y - corner.y)));
      expect(nearest).toBeLessThan(1e-6);
    }
  });

  it('collapses a 45-degree staircase instead of keeping every step', () => {
    const chain = diagonalChain(30);
    const fitted = fitChain(chain, false, params());

    // 61 lattice points in, a handful out — and what comes out is essentially the diagonal.
    expect(fitted.length).toBeLessThan(8);
    const first = fitted[0];
    const last = fitted[fitted.length - 1];
    for (const p of fitted) {
      const t = (p.x - first.x) / (last.x - first.x || 1);
      expect(Math.abs(p.y - (first.y + t * (last.y - first.y)))).toBeLessThan(0.75);
    }
  });

  it('returns open-chain endpoints exactly — the pinning the tiling invariant rests on', () => {
    const chain = diagonalChain(20);
    const fitted = fitChain(chain, false, params());

    expect(fitted[0]).toEqual(chain[0]);
    expect(fitted[fitted.length - 1]).toEqual(chain[chain.length - 1]);
  });

  it('is deterministic — the two sides of a boundary must fit it identically', () => {
    const chain = boundaryOf((x, y) => Math.hypot(x - 30, y - 30) <= 20, 60, 60);
    const a = fitChain(chain, true, params());
    const b = fitChain(chain, true, params());
    expect(a).toEqual(b);
  });

  it('does not mutate its input', () => {
    const chain = diagonalChain(10);
    const copy = chain.map((p) => ({ ...p }));
    fitChain(chain, false, params());
    expect(chain).toEqual(copy);
  });

  it('survives degenerate chains without throwing', () => {
    expect(fitChain([], false, params())).toEqual([]);
    expect(fitChain([{ x: 1, y: 1 }], false, params())).toHaveLength(1);
    expect(
      fitChain(
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
        ],
        false,
        params(),
      ),
    ).toHaveLength(2);

    const collinear: Pt[] = Array.from({ length: 12 }, (_, i) => ({ x: i, y: 0 }));
    const fitted = fitChain(collinear, false, params());
    expect(fitted[0]).toEqual({ x: 0, y: 0 });
    expect(fitted[fitted.length - 1]).toEqual({ x: 11, y: 0 });
    for (const p of fitted) expect(Math.abs(p.y)).toBeLessThan(1e-9);
  });

  it('keeps a one-pixel-wide bar from collapsing or inverting', () => {
    const chain = boundaryOf((x, y) => y === 10 && x >= 5 && x < 35, 60, 60);
    const lattice = signedArea(chain);
    const fitted = fitChain(chain, true, params());
    const area = signedArea(fitted);

    expect(Math.sign(area)).toBe(Math.sign(lattice));
    expect(Math.abs(area)).toBeGreaterThan(Math.abs(lattice) * 0.5);
  });

  it('trades corners for curves as alphaMax rises', () => {
    const chain = boundaryOf((x, y) => Math.hypot(x - 30, y - 30) <= 20, 60, 60);
    const cornery = fitChain(chain, true, params({ alphaMax: 0.2 }));
    const smooth = fitChain(chain, true, params({ alphaMax: 1.3 }));
    expect(smooth.length).not.toBe(cornery.length);
  });
});
