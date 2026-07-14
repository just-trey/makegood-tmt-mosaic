import { describe, expect, it } from 'vitest';
import { rotXthenZ, soupToIndexed, xmlEscape } from '../src/export/threemf';

describe('soupToIndexed', () => {
  it('welds shared vertices across triangles', () => {
    // two triangles sharing the edge (1,0,0)-(0,1,0)
    const soup = new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      1, 0, 0, 1, 1, 0, 0, 1, 0,
    ]);
    const { verts, tris } = soupToIndexed(soup);
    expect(verts.length / 3).toBe(4); // 6 raw -> 4 unique
    expect(tris).toHaveLength(6);
    expect(tris.slice(0, 3)).toEqual([0, 1, 2]);
  });
});

describe('xmlEscape', () => {
  it('escapes XML metacharacters', () => {
    expect(xmlEscape('<a & "b">')).toBe('&lt;a &amp; &quot;b&quot;&gt;');
  });
});

describe('rotXthenZ', () => {
  it('is the identity for zero angles', () => {
    const R = rotXthenZ(0, 0);
    expect(R[0].map(v => +v.toFixed(9))).toEqual([1, 0, 0]);
    expect(R[1].map(v => +v.toFixed(9))).toEqual([0, 1, 0]);
    expect(R[2].map(v => +v.toFixed(9))).toEqual([0, 0, 1]);
  });

  it('tilts a +Y face normal to +Z with theta = -90 (face-down layout math)', () => {
    // p' = p * R with row-vector convention
    const R = rotXthenZ(-90, 0);
    const p = [0, 1, 0];
    const out = [
      p[0] * R[0][0] + p[1] * R[1][0] + p[2] * R[2][0],
      p[0] * R[0][1] + p[1] * R[1][1] + p[2] * R[2][1],
      p[0] * R[0][2] + p[1] * R[1][2] + p[2] * R[2][2],
    ];
    expect(out[0]).toBeCloseTo(0, 10);
    expect(out[1]).toBeCloseTo(0, 10);
    expect(out[2]).toBeCloseTo(-1, 10);
  });
});
