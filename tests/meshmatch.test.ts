import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain-JS tooling module, no .d.ts (run by node, not bundled)
import { analyze, applyTransform, findTransform } from '../scripts/lib/mesh.mjs';

/** One axis-aligned quad (2 triangles) of `size` mm, facing `axis` in direction `sign`. */
function quad(axis: number, sign: number, size: number, at: number): number[] {
  const [u, v] = [0, 1, 2].filter((k) => k !== axis);
  const pt = (a: number, b: number) => {
    const p = [0, 0, 0];
    p[axis] = at;
    p[u] = a;
    p[v] = b;
    return p;
  };
  // wind so the normal comes out along `sign`
  const c = [pt(0, 0), pt(size, 0), pt(size, size), pt(0, size)];
  const order = sign > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
  return order.flatMap((i) => c[i]);
}

/**
 * A chiral shape: six axis-aligned faces whose areas are all different, so the only map taking
 * its mirror back onto it is that mirror itself — no rotation can. Areas are 1..6 squared units
 * (quad side = sqrt(k)), which keeps every direction bucket distinct.
 */
function chiral(): Float32Array {
  const tris: number[] = [];
  const dirs: [number, number][] = [
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [2, 1],
    [2, -1],
  ];
  dirs.forEach(([axis, sign], k) => tris.push(...quad(axis, sign, Math.sqrt(k + 1), 0)));
  // pad the bbox to a fixed cube so mirrored/translated copies compare on equal dims
  tris.push(...quad(0, 1, 0.001, 10), ...quad(0, -1, 0.001, -10));
  return new Float32Array(tris);
}

const IDENTITY = { perm: [0, 1, 2], sign: [1, 1, 1], det: 1 };
const MIRROR_X = { perm: [0, 1, 2], sign: [-1, 1, 1], det: -1 };

describe('findTransform', () => {
  it('recovers a pure translation as the identity rotation', () => {
    const a = analyze(chiral());
    const b = analyze(applyTransform(chiral(), IDENTITY, [5, -72, 110]));
    const hit = findTransform(a, b);
    expect(hit).not.toBeNull();
    expect(hit.r.det).toBe(1);
    expect(hit.translate[0]).toBeCloseTo(5, 2);
    expect(hit.translate[1]).toBeCloseTo(-72, 2);
    expect(hit.translate[2]).toBeCloseTo(110, 2);
  });

  it('reports a genuine mirror of a chiral part as the opposite hand', () => {
    const a = analyze(chiral());
    const b = analyze(applyTransform(chiral(), MIRROR_X, [0, 0, 0]));
    const hit = findTransform(a, b);
    expect(hit).not.toBeNull();
    expect(hit.r.det).toBe(-1);
  });

  /**
   * Regression for the footrest: on a part that is symmetric about an axis, mirroring it is a
   * geometric no-op, so the mirror and the rotation tie and the winner is decided by tessellation
   * noise. Ranking purely by score made the tool report "opposite hand" for a perfectly good mesh.
   * A rotation must win any near-tie.
   */
  it('prefers a rotation over a mirror that only ties, on a symmetric part', () => {
    // Symmetric about X except for a sliver of tessellation noise: the +X/-X areas differ by
    // 0.005%. That tiny asymmetry is enough to make the mirror outscore the identity, which is
    // exactly how the real footrest got flagged as the opposite hand. An exactly symmetric mesh
    // would NOT reproduce the bug -- the old code broke exact ties correctly.
    // The +-Y and +-Z faces have distinct areas so no *other* rotation can stand in for the
    // X-mirror (without them, (-x,y,-z) achieves it for free and the bug hides).
    const sym = new Float32Array([
      ...quad(0, 1, Math.sqrt(2), 5),
      ...quad(0, -1, Math.sqrt(2.0001), -5),
      ...quad(1, 1, 3, 0),
      ...quad(1, -1, 1, 0),
      ...quad(2, 1, Math.sqrt(5), 0),
      ...quad(2, -1, 2, 0),
    ]);
    const a = analyze(sym);
    const b = analyze(applyTransform(sym, MIRROR_X, [0, 0, 0]));
    const hit = findTransform(a, b);
    expect(hit).not.toBeNull();
    expect(hit.r.det).toBe(1);
  });
});
