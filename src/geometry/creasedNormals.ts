import type { IndexedMesh } from '../types';

/**
 * Crease-aware vertex normals from a triangle index, not by hashing positions. Three's
 * `toCreasedNormals` keys every corner by string in both passes: ~1.1M keys per pass on the chair's
 * 368k triangles, 50% of the function (docs/findings/2026-08-23-boolean-pass-and-weld.md). Manifold
 * and packed 3MFs already carry an index; reading it measured 54ms against 699ms in Node, and 8.7x
 * in the browser, where this runs.
 *
 * Versus `toCreasedNormals`, deliberately: vertices are shared *exactly* by index, where three
 * buckets positions to 0.01mm (over the chair 892 of 1,104,990 corners differ by more than 1
 * degree, 0.08%, worst 24.9 degrees, all where the bucket merged vertices the mesh keeps distinct).
 * A degenerate triangle yields a zero normal, matching three, so this stays a swap.
 */
export function creasedNormalsFromIndex(
  { positions, indices }: IndexedMesh,
  creaseAngle: number,
): Float32Array {
  const creaseDot = Math.cos(creaseAngle);
  const triCount = indices.length / 3;
  const vertCount = positions.length / 3;

  const faceN = new Float32Array(triCount * 3);
  for (let f = 0; f < triCount; f++) {
    const a = indices[f * 3] * 3,
      b = indices[f * 3 + 1] * 3,
      c = indices[f * 3 + 2] * 3;
    const ux = positions[c] - positions[b],
      uy = positions[c + 1] - positions[b + 1],
      uz = positions[c + 2] - positions[b + 2];
    const vx = positions[a] - positions[b],
      vy = positions[a + 1] - positions[b + 1],
      vz = positions[a + 2] - positions[b + 2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    // No `|| 1`: a zero cross product must stay a zero normal, so a degenerate face fails its own
    // crease test as in three. `Math.sqrt`, not `Math.hypot`: hypot's overflow guard needs ~1e154
    // coordinates and measured 11x slower on 5M calls, about 20ms of the chair.
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 0) {
      faceN[f * 3] = nx / len;
      faceN[f * 3 + 1] = ny / len;
      faceN[f * 3 + 2] = nz / len;
    }
  }

  // vertex -> incident faces, as a CSR pair built by counting sort: two linear passes, two typed
  // arrays, nothing allocated per triangle. This is the work the string keys were paying for.
  const start = new Uint32Array(vertCount + 1);
  for (let i = 0; i < indices.length; i++) start[indices[i] + 1]++;
  for (let v = 0; v < vertCount; v++) start[v + 1] += start[v];
  const cursor = start.slice(0, vertCount);
  const adjacent = new Uint32Array(indices.length);
  for (let f = 0; f < triCount; f++) {
    for (let k = 0; k < 3; k++) adjacent[cursor[indices[f * 3 + k]]++] = f;
  }

  const normals = new Float32Array(triCount * 9);
  for (let f = 0; f < triCount; f++) {
    const fx = faceN[f * 3],
      fy = faceN[f * 3 + 1],
      fz = faceN[f * 3 + 2];
    for (let k = 0; k < 3; k++) {
      const v = indices[f * 3 + k];
      let sx = 0,
        sy = 0,
        sz = 0;
      for (let p = start[v]; p < start[v + 1]; p++) {
        const o = adjacent[p] * 3;
        const ox = faceN[o],
          oy = faceN[o + 1],
          oz = faceN[o + 2];
        if (fx * ox + fy * oy + fz * oz > creaseDot) {
          sx += ox;
          sy += oy;
          sz += oz;
        }
      }
      const len = Math.sqrt(sx * sx + sy * sy + sz * sz);
      const out = f * 9 + k * 3;
      if (len > 0) {
        normals[out] = sx / len;
        normals[out + 1] = sy / len;
        normals[out + 2] = sz / len;
      }
    }
  }
  return normals;
}

/**
 * Whether an index can be applied to the soup it is paired with. Both producers
 * (`manifoldToMeshes`, `load3MF`) expand the soup straight from the index, so they line up; the
 * hazard is a mesh replaced after its index was stored, which `AssemblyRole.buildMesh` does.
 * **A guard, not a proof**: it catches a different triangle count and an out-of-range index (reads
 * `undefined`, NaN normals, the part vanishes). A stale index of the right count and range passes,
 * so **every path that replaces `positions` must clear `indexed`**. The bounds scan measured well
 * under a millisecond per part.
 */
export function indexMatchesSoup(indexed: IndexedMesh | undefined, soup: Float32Array): boolean {
  if (!indexed || indexed.indices.length * 3 !== soup.length) return false;
  const vertCount = indexed.positions.length / 3;
  const { indices } = indexed;
  for (let i = 0; i < indices.length; i++) if (indices[i] >= vertCount) return false;
  return true;
}
