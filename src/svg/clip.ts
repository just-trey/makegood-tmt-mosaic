import type { Loop, Pt } from '../types';

/**
 * Whether every point is on the inner side of every edge of `loop`, which proves an outline through
 * them lies inside it (so an artboard-sized clip crops nothing). Exact for a convex loop; for any
 * other it can say no when the answer is yes, never the reverse. A point on an edge counts as inside.
 */
export function insideEveryEdge(loop: Loop, pts: readonly Pt[]): boolean {
  const ring: Pt[] = [];
  for (const p of loop) {
    const q = ring[ring.length - 1];
    if (!q || q.x !== p.x || q.y !== p.y) ring.push(p);
  }
  const last = ring[ring.length - 1];
  if (ring.length > 1 && ring[0].x === last.x && ring[0].y === last.y) ring.pop();
  const n = ring.length;
  if (n < 3) return false;
  let turned = 0;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const a = ring[i],
      b = ring[(i + 1) % n],
      c = ring[(i + 2) % n];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    turned += Math.atan2(cross, (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y));
    minX = Math.min(minX, a.x);
    maxX = Math.max(maxX, a.x);
    minY = Math.min(minY, a.y);
    maxY = Math.max(maxY, a.y);
  }
  // Exactly one turn, so a point inside every edge is inside once: a star drawn point to point goes
  // round twice, and its middle is a hole under evenodd.
  if (Math.abs(Math.abs(turned) - 2 * Math.PI) > 1e-6) return false;
  const sign = Math.sign(turned);
  // Relative, so a vertex placed exactly on an artboard edge isn't lost to rounding at any scale.
  const tol = 1e-6 * Math.hypot(maxX - minX, maxY - minY);
  for (const p of pts) {
    for (let i = 0; i < n; i++) {
      const a = ring[i],
        b = ring[(i + 1) % n];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const side = ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / len;
      if (side * sign < -tol) return false;
    }
  }
  return true;
}
