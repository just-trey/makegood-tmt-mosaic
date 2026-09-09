import pc from 'polygon-clipping';

export type Pt = [number, number];
export type Ring = Pt[];
export type Polygon = Ring[];
export type MultiPolygon = Polygon[];

export function ringArea(r: Ring): number {
  let a = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const p = r[i];
    const q = r[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function mpArea(mp: MultiPolygon): number {
  let a = 0;
  for (const poly of mp) for (let i = 0; i < poly.length; i++) a += Math.abs(ringArea(poly[i])) * (i === 0 ? 1 : -1);
  return a;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function mpBounds(mp: MultiPolygon): Bounds | null {
  let b: Bounds | null = null;
  for (const poly of mp)
    for (const p of poly[0] ?? []) {
      if (!b) b = { minX: p[0], minY: p[1], maxX: p[0], maxY: p[1] };
      else {
        if (p[0] < b.minX) b.minX = p[0];
        if (p[0] > b.maxX) b.maxX = p[0];
        if (p[1] < b.minY) b.minY = p[1];
        if (p[1] > b.maxY) b.maxY = p[1];
      }
    }
  return b;
}

export function mapMp(mp: MultiPolygon, f: (p: Pt) => Pt): MultiPolygon {
  return mp.map((poly) => poly.map((ring) => ring.map(f)));
}

export function isEmpty(mp: MultiPolygon | null | undefined): boolean {
  return !mp || mp.length === 0 || mp.every((p) => p.length === 0 || p[0].length < 3);
}

export function union(a: MultiPolygon, b: MultiPolygon): MultiPolygon {
  if (isEmpty(a)) return b;
  if (isEmpty(b)) return a;
  return pc.union(a, b);
}

export function difference(a: MultiPolygon, b: MultiPolygon): MultiPolygon {
  if (isEmpty(a) || isEmpty(b)) return a;
  return pc.difference(a, b);
}

export function intersection(a: MultiPolygon, b: MultiPolygon): MultiPolygon {
  if (isEmpty(a) || isEmpty(b)) return [];
  return pc.intersection(a, b);
}

export function xor(a: MultiPolygon, b: MultiPolygon): MultiPolygon {
  if (isEmpty(a)) return b;
  if (isEmpty(b)) return a;
  return pc.xor(a, b);
}

export function unionAll(mps: MultiPolygon[]): MultiPolygon {
  const live = mps.filter((m) => !isEmpty(m));
  if (live.length === 0) return [];
  if (live.length === 1) return live[0];
  return pc.union(live[0], ...live.slice(1));
}

/** Drop repeated points and rings too small to matter, returning a clean ring or null. */
export function cleanRing(r: Ring, minArea = 1e-6): Ring | null {
  const out: Ring = [];
  for (const p of r) {
    const q = out[out.length - 1];
    if (!q || Math.abs(q[0] - p[0]) > 1e-9 || Math.abs(q[1] - p[1]) > 1e-9) out.push(p);
  }
  if (out.length > 1) {
    const a = out[0];
    const z = out[out.length - 1];
    if (Math.abs(a[0] - z[0]) < 1e-9 && Math.abs(a[1] - z[1]) < 1e-9) out.pop();
  }
  if (out.length < 3 || Math.abs(ringArea(out)) < minArea) return null;
  return out;
}

/**
 * Turn the closed subpaths of one filled shape into a well-formed multipolygon under the SVG
 * fill rule. evenodd is exactly the XOR of the rings. nonzero is approximated as the XOR of
 * (union of clockwise rings) and (union of counter-clockwise rings): exact for every real design
 * seen (nested same-direction rings fill, reversed inner rings are holes), off only for a ring
 * nested three deep with alternating directions.
 */
export function ringsToMp(rings: Ring[], fillRule: 'nonzero' | 'evenodd'): MultiPolygon {
  const clean = rings.map((r) => cleanRing(r)).filter((r): r is Ring => r !== null);
  if (clean.length === 0) return [];
  if (fillRule === 'evenodd') {
    let acc: MultiPolygon = [];
    for (const r of clean) acc = xor(acc, [[r]]);
    return acc;
  }
  const cw = clean.filter((r) => ringArea(r) < 0).map((r): MultiPolygon => [[r]]);
  const ccw = clean.filter((r) => ringArea(r) >= 0).map((r): MultiPolygon => [[r]]);
  return xor(unionAll(cw), unionAll(ccw));
}

/** Douglas-Peucker on a closed ring. */
export function simplifyRing(r: Ring, eps: number): Ring {
  if (r.length <= 4 || eps <= 0) return r;
  const keep = new Uint8Array(r.length);
  // Split at the two most distant points so the closed ring becomes two open chains.
  let far = 0;
  for (let i = 1; i < r.length; i++) {
    const d = (r[i][0] - r[0][0]) ** 2 + (r[i][1] - r[0][1]) ** 2;
    if (d > (r[far][0] - r[0][0]) ** 2 + (r[far][1] - r[0][1]) ** 2) far = i;
  }
  keep[0] = keep[far] = 1;
  const stack: [number, number][] = [
    [0, far],
    [far, r.length],
  ];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const pa = r[a];
    const pb = r[b % r.length];
    let best = -1;
    let bestD = eps * eps;
    const dx = pb[0] - pa[0];
    const dy = pb[1] - pa[1];
    const len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const p = r[i];
      let d: number;
      if (len2 === 0) d = (p[0] - pa[0]) ** 2 + (p[1] - pa[1]) ** 2;
      else {
        let t = ((p[0] - pa[0]) * dx + (p[1] - pa[1]) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        d = (p[0] - pa[0] - t * dx) ** 2 + (p[1] - pa[1] - t * dy) ** 2;
      }
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  const out: Ring = [];
  for (let i = 0; i < r.length; i++) if (keep[i]) out.push(r[i]);
  return out.length >= 3 ? out : r;
}

export function simplifyMp(mp: MultiPolygon, eps: number): MultiPolygon {
  const out: MultiPolygon = [];
  for (const poly of mp) {
    const rings: Ring[] = [];
    for (let i = 0; i < poly.length; i++) {
      const s = cleanRing(simplifyRing(poly[i], eps));
      if (s) rings.push(s);
      else if (i === 0) break;
    }
    if (rings.length) out.push(rings);
  }
  return out;
}

export function pointInRing(p: Pt, r: Ring): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i];
    const b = r[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

export function pointInMp(p: Pt, mp: MultiPolygon): boolean {
  for (const poly of mp) {
    if (!pointInRing(p, poly[0])) continue;
    let inHole = false;
    for (let i = 1; i < poly.length; i++)
      if (pointInRing(p, poly[i])) {
        inHole = true;
        break;
      }
    if (!inHole) return true;
  }
  return false;
}
