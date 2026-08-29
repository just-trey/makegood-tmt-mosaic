import { describe, expect, it, vi } from 'vitest';
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
    expect(loops[0].map((p) => [p.x, p.y])).toEqual([
      [10, 10],
      [20, 10],
      [20, 20],
      [10, 10],
    ]);
  });

  it('handles H and V', () => {
    const loops = parsePathD('M0 0 H10 V5');
    expect(loops[0]).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
    ]);
  });

  it('repeats the previous command implicitly', () => {
    const loops = parsePathD('M0 0 L1 1 2 2 3 3');
    expect(loops[0]).toHaveLength(4);
    expect(loops[0][3]).toEqual({ x: 3, y: 3 });
  });

  it('treats coordinates after M as implicit L (per SVG spec)', () => {
    const loops = parsePathD('M0 0 10 0 10 10');
    expect(loops[0]).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
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

  it('flattens a near-straight cubic into very few points (adaptive, not a fixed count)', () => {
    // control points sit almost exactly on the p0-p3 line -> should need ~1 segment
    const loops = parsePathD('M0 0 C33 0.01 66 -0.01 100 0');
    expect(loops[0].length).toBeLessThanOrEqual(3);
  });

  it('flattens a sharply curved cubic into more points than a gentle one', () => {
    const gentle = parsePathD('M0 0 C25 1 75 -1 100 0')[0];
    const sharp = parsePathD('M0 0 C0 100 100 -100 100 0')[0];
    expect(sharp.length).toBeGreaterThan(gentle.length);
  });

  it('drops only the subpath broken by a missing coordinate, instead of a NaN vertex or a throw', () => {
    const onMalformed = vi.fn();
    const loops = parsePathD('M0 0 L10 0 L10 10 Z M20 20 L30', onMalformed);
    expect(loops).toHaveLength(1); // the completed first square survives
    expect(loops[0]).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 0 },
    ]);
    expect(onMalformed).toHaveBeenCalledTimes(1);
  });

  it('keeps an already-closed subpath even when the next M itself is malformed', () => {
    const onMalformed = vi.fn();
    const loops = parsePathD('M0 0 L10 0 L10 10 Z M20 L30 30', onMalformed);
    expect(loops).toHaveLength(1); // the completed first square survives the broken M
    expect(loops[0]).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 0 },
    ]);
    expect(onMalformed).toHaveBeenCalledTimes(1);
  });

  it('drops an unclosed subpath whole, even one with several good points already drawn', () => {
    const onMalformed = vi.fn();
    // Three good points (0,0 / 10,0 / 10,10) precede the break, but the subpath was never
    // closed or flushed by a later M, so none of it survives — a truncated loop closed on its
    // own would be a shape never drawn, which is worse than losing the piece.
    const loops = parsePathD('M0 0 L10 0 L10 10 L20', onMalformed);
    expect(loops).toEqual([]);
    expect(onMalformed).toHaveBeenCalledTimes(1);
  });

  it('returns no loops (not a throw) when the only subpath is malformed', () => {
    const onMalformed = vi.fn();
    expect(parsePathD('M0 0 L10', onMalformed)).toEqual([]);
    expect(onMalformed).toHaveBeenCalledTimes(1);
  });

  it('never calls onMalformed for well-formed data', () => {
    const onMalformed = vi.fn();
    parsePathD('M0 0 L10 0 L10 10 Z', onMalformed);
    expect(onMalformed).not.toHaveBeenCalled();
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

  it('reads arc flags glued to the following coordinate (SVGO/Illustrator shorthand)', () => {
    const onMalformed = vi.fn();
    const glued = parsePathD('M0 0 A5 5 0 1110 0', onMalformed);
    expect(glued).toEqual(parsePathD('M0 0 A5 5 0 1 1 10 0'));
    expect(glued[0].length).toBeGreaterThan(1);
    expect(onMalformed).not.toHaveBeenCalled();
  });

  it('reads a glued zero flag the same way', () => {
    const onMalformed = vi.fn();
    const glued = parsePathD('M0 0 A5 5 0 01 10 0', onMalformed);
    expect(glued).toEqual(parsePathD('M0 0 A5 5 0 0 1 10 0'));
    expect(onMalformed).not.toHaveBeenCalled();
  });

  it('leaves a decimal remainder after a glued flag as the next coordinate', () => {
    const onMalformed = vi.fn();
    const glued = parsePathD('M0 0 A5 5 0 11.5 10', onMalformed);
    expect(glued).toEqual(parsePathD('M0 0 A5 5 0 1 1 0.5 10'));
    expect(onMalformed).not.toHaveBeenCalled();
  });

  it('reads glued flags on a relative arc', () => {
    const onMalformed = vi.fn();
    const glued = parsePathD('m5 5 a5 5 0 1110 0', onMalformed);
    expect(glued).toEqual(parsePathD('m5 5 a5 5 0 1 1 10 0'));
    expect(glued[0][0]).toEqual({ x: 5, y: 5 });
    expect(onMalformed).not.toHaveBeenCalled();
  });

  it('still repeats an arc implicitly after a glued one', () => {
    const onMalformed = vi.fn();
    const glued = parsePathD('M0 0 A5 5 0 1110 0 5 5 0 110 0', onMalformed);
    expect(glued).toEqual(parsePathD('M0 0 A5 5 0 1 1 10 0 A5 5 0 1 1 0 0'));
    expect(onMalformed).not.toHaveBeenCalled();
  });

  it('reports a flag that is neither 0 nor 1 as broken data', () => {
    const onMalformed = vi.fn();
    expect(parsePathD('M0 0 A5 5 0 2 1 10 0', onMalformed)).toEqual([]);
    expect(onMalformed).toHaveBeenCalledTimes(1);
  });

  it('reports a large-arc flag written as a decimal as broken data', () => {
    // the grammar reads a flag as one character, so `1.0` leaves `.0`, which is not a flag
    const onMalformed = vi.fn();
    expect(parsePathD('M0 0 A5 5 0 1.0 1 10 0', onMalformed)).toEqual([]);
    expect(onMalformed).toHaveBeenCalledTimes(1);
  });

  it('reads the same decimal in the sweep position as a flag and a coordinate', () => {
    const onMalformed = vi.fn();
    // `1.0 10` is sweep 1 then the coordinate pair `.0 10`, which is what the grammar says
    const decimal = parsePathD('M0 0 A5 5 0 1 1.0 10', onMalformed);
    expect(decimal).toEqual(parsePathD('M0 0 A5 5 0 1 1 0 10'));
    expect(onMalformed).not.toHaveBeenCalled();
  });

  it('reports an arc that runs out of tokens at a flag as broken data', () => {
    const onMalformed = vi.fn();
    expect(parsePathD('M0 0 A5 5 0', onMalformed)).toEqual([]);
    expect(onMalformed).toHaveBeenCalledTimes(1);
  });
});

describe('signedArea', () => {
  it('is positive for CCW and negative for CW', () => {
    const ccw = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(signedArea(ccw)).toBeCloseTo(100);
    expect(signedArea(ccw.slice().reverse())).toBeCloseTo(-100);
  });
});
