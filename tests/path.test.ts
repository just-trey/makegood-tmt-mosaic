import { describe, expect, it } from 'vitest';
import { parsePathD, signedArea } from '../src/svg/path';

describe('parsePathD', () => {
  it('parses absolute M/L/Z into a closed loop', () => {
    const loops = parsePathD('M0 0 L10 0 L10 10 Z');
    expect(loops).toHaveLength(1);
    const loop = loops[0];
    expect(loop[0]).toEqual({ x: 0, y: 0 });
    expect(loop[loop.length - 1]).toEqual({ x: 0, y: 0 }); // Z returns to start
  });

  it('handles relative commands', () => {
    const loops = parsePathD('m10 10 l10 0 l0 10 z');
    expect(loops[0].map(p => [p.x, p.y])).toEqual([[10, 10], [20, 10], [20, 20], [10, 10]]);
  });

  it('handles H and V', () => {
    const loops = parsePathD('M0 0 H10 V5');
    expect(loops[0]).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }]);
  });

  it('repeats the previous command implicitly', () => {
    const loops = parsePathD('M0 0 L1 1 2 2 3 3');
    expect(loops[0]).toHaveLength(4);
    expect(loops[0][3]).toEqual({ x: 3, y: 3 });
  });

  it('treats coordinates after M as implicit L (per SVG spec)', () => {
    const loops = parsePathD('M0 0 10 0 10 10');
    expect(loops[0]).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
  });

  it('splits multiple subpaths into separate loops', () => {
    const loops = parsePathD('M0 0 L10 0 L10 10 Z M20 20 L30 20 L30 30 Z');
    expect(loops).toHaveLength(2);
    expect(loops[1][0]).toEqual({ x: 20, y: 20 });
  });

  it('flattens cubic beziers ending at the target point', () => {
    const loops = parsePathD('M0 0 C0 10 10 10 10 0');
    const last = loops[0][loops[0].length - 1];
    expect(last.x).toBeCloseTo(10, 6);
    expect(last.y).toBeCloseTo(0, 6);
  });

  it('flattens elliptical arcs ending at the target point (spec F.6.5 endpoint math)', () => {
    const loops = parsePathD('M0 0 A5 5 0 0 1 10 0');
    const pts = loops[0];
    const last = pts[pts.length - 1];
    expect(last.x).toBeCloseTo(10, 4);
    expect(last.y).toBeCloseTo(0, 4);
    // every intermediate point sits on the r=5 circle centered at (5,0)
    for (const p of pts) {
      expect(Math.hypot(p.x - 5, p.y - 0)).toBeCloseTo(5, 3);
    }
  });
});

describe('signedArea', () => {
  it('is positive for CCW and negative for CW', () => {
    const ccw = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    expect(signedArea(ccw)).toBeCloseTo(100);
    expect(signedArea(ccw.slice().reverse())).toBeCloseTo(-100);
  });
});
