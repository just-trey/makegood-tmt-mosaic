import type { Mat6, Pt } from '../types';

export const Mat = {
  identity(): Mat6 {
    return [1, 0, 0, 1, 0, 0];
  },
  /** A*B — apply B first, then A. */
  multiply(A: Mat6, B: Mat6): Mat6 {
    const [a1, b1, c1, d1, e1, f1] = A,
      [a2, b2, c2, d2, e2, f2] = B;
    return [
      a1 * a2 + c1 * b2,
      b1 * a2 + d1 * b2,
      a1 * c2 + c1 * d2,
      b1 * c2 + d1 * d2,
      a1 * e2 + c1 * f2 + e1,
      b1 * e2 + d1 * f2 + f1,
    ];
  },
  apply(M: Mat6, x: number, y: number): Pt {
    return { x: M[0] * x + M[2] * y + M[4], y: M[1] * x + M[3] * y + M[5] };
  },
  translate(tx: number, ty?: number): Mat6 {
    return [1, 0, 0, 1, tx, ty || 0];
  },
  scale(sx: number, sy?: number): Mat6 {
    return [sx, 0, 0, sy === undefined ? sx : sy, 0, 0];
  },
  rotate(deg: number, cx?: number, cy?: number): Mat6 {
    const r = (deg * Math.PI) / 180,
      c = Math.cos(r),
      s = Math.sin(r);
    let m: Mat6 = [c, s, -s, c, 0, 0];
    if (cx !== undefined) {
      m = Mat.multiply(Mat.translate(cx, cy), Mat.multiply(m, Mat.translate(-cx, -(cy ?? 0))));
    }
    return m;
  },
  skewX(deg: number): Mat6 {
    return [1, 0, Math.tan((deg * Math.PI) / 180), 1, 0, 0];
  },
  skewY(deg: number): Mat6 {
    return [1, Math.tan((deg * Math.PI) / 180), 0, 1, 0, 0];
  },
};

/** Parse an SVG transform attribute ("translate(...) rotate(...)") into one Mat6. */
export function parseTransformAttr(str: string | null): Mat6 {
  let m = Mat.identity();
  if (!str) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(str))) {
    const fn = match[1];
    const args = match[2]
      .trim()
      .split(/[\s,]+/)
      .filter((s) => s.length)
      .map(Number);
    let fm: Mat6 | undefined;
    if (fn === 'matrix') fm = args as Mat6;
    else if (fn === 'translate') fm = Mat.translate(args[0], args[1]);
    else if (fn === 'scale') fm = Mat.scale(args[0], args[1]);
    else if (fn === 'rotate') fm = Mat.rotate(args[0], args[1], args[2]);
    else if (fn === 'skewX') fm = Mat.skewX(args[0]);
    else if (fn === 'skewY') fm = Mat.skewY(args[0]);
    if (fm) m = Mat.multiply(m, fm);
  }
  return m;
}
