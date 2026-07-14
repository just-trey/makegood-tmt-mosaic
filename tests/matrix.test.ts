import { describe, expect, it } from 'vitest';
import { Mat, parseTransformAttr } from '../src/svg/matrix';

describe('Mat', () => {
  it('applies identity', () => {
    expect(Mat.apply(Mat.identity(), 3, 4)).toEqual({ x: 3, y: 4 });
  });

  it('composes translate then scale (apply B first, then A)', () => {
    const m = Mat.multiply(Mat.translate(10, 5), Mat.scale(2));
    expect(Mat.apply(m, 1, 1)).toEqual({ x: 12, y: 7 });
  });

  it('rotates 90° about the origin', () => {
    const p = Mat.apply(Mat.rotate(90), 1, 0);
    expect(p.x).toBeCloseTo(0, 10);
    expect(p.y).toBeCloseTo(1, 10);
  });

  it('rotates about a pivot', () => {
    const p = Mat.apply(Mat.rotate(180, 5, 5), 0, 0);
    expect(p.x).toBeCloseTo(10, 10);
    expect(p.y).toBeCloseTo(10, 10);
  });

  it('composes nested parent/child transforms like the SVG walker does', () => {
    const parent = parseTransformAttr('translate(100 0)');
    const child = parseTransformAttr('rotate(90)');
    const m = Mat.multiply(parent, child);
    const p = Mat.apply(m, 10, 0);
    expect(p.x).toBeCloseTo(100, 8);
    expect(p.y).toBeCloseTo(10, 8);
  });
});

describe('parseTransformAttr', () => {
  it('parses matrix()', () => {
    expect(parseTransformAttr('matrix(1 0 0 1 7 9)')).toEqual([1, 0, 0, 1, 7, 9]);
  });

  it('parses a multi-function list left to right', () => {
    const m = parseTransformAttr('translate(10, 5) scale(2)');
    expect(Mat.apply(m, 1, 1)).toEqual({ x: 12, y: 7 });
  });

  it('returns identity for null/empty', () => {
    expect(parseTransformAttr(null)).toEqual([1, 0, 0, 1, 0, 0]);
    expect(parseTransformAttr('')).toEqual([1, 0, 0, 1, 0, 0]);
  });
});
