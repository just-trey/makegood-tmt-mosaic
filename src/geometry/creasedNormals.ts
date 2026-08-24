import type { IndexedMesh } from '../types';

/**
 * Crease-aware vertex normals computed from a triangle index instead of by hashing positions.
 *
 * `toCreasedNormals` (three) has to discover which faces share a vertex, and does it by building a
 * string key per corner and bucketing on it -- twice, because both of its passes hash. On the
 * chair's 368k triangles that is ~1.1M keys per pass, and it measured 50% of the whole function
 * for the bucketing alone (docs/findings/2026-08-23-boolean-pass-and-weld.md).
 *
 * Every mesh this app displays already knows the answer. Manifold emits an index from the boolean,
 * and a packed 3MF carries one in the file. So the sharing is read rather than rediscovered, and
 * the chair measured 54ms against 699ms in Node, and 8.7x in the browser, which is the number
 * that matters because this runs in one.
 *
 * **Two differences from `toCreasedNormals`, both deliberate.**
 *
 * Vertices are shared *exactly*, by index identity, where three buckets positions truncated to
 * 0.01mm. Exact is the stricter rule and the one the mesh itself asserts. Measured over the chair,
 * 892 of 1,104,990 corners differ by more than 1 degree (0.08%, worst 24.9 degrees) -- all of them
 * corners where the bucket pulled in a vertex the mesh keeps distinct.
 *
 * A degenerate (zero-area) triangle yields a zero normal, which is what three produces for one
 * too: its own face normal is zero, so nothing clears the crease threshold and nothing is summed.
 * Matched rather than improved, so this stays a swap and not a change.
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
    // No `|| 1` guard: a zero-length cross product must stay a zero normal, so that a degenerate
    // face fails its own crease test exactly as it does in three.
    //
    // `Math.sqrt` of the sum, not `Math.hypot`: hypot guards against intermediate overflow, which
    // needs coordinates near 1e154, and it measured 11x slower on 5M calls. Part coordinates are
    // millimetres in the hundreds, so the guard buys nothing and cost about 20ms of the chair.
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
 * Whether an index can be applied to the soup it is paired with.
 *
 * Both producers expand their soup straight from their index, corner for corner in the same order
 * (`manifoldToMeshes`, `load3MF`), so the normals this module returns line up with the soup by
 * construction. The hazard is not that arithmetic: it is a part whose mesh was replaced after the
 * index was stored, leaving a stale one behind. `AssemblyRole.buildMesh` does exactly that.
 *
 * **This is a guard, not a proof.** It rules out the two failures that corrupt the render rather
 * than merely misshade it: a different triangle count, and an index reaching past its own vertex
 * list (out of bounds on a Float32Array reads `undefined`, so every normal downstream of it comes
 * out NaN and the part disappears). A stale index that happens to have the right triangle count
 * and stays in range still passes, so **every path that replaces `positions` must clear
 * `indexed`** — this only stops that mistake becoming a crash-shaped one.
 *
 * The bounds scan is linear in the index and runs once per mesh, against a normal pass that is
 * linear too but with far more work per element. Measured at well under a millisecond per part.
 */
export function indexMatchesSoup(indexed: IndexedMesh | undefined, soup: Float32Array): boolean {
  if (!indexed || indexed.indices.length * 3 !== soup.length) return false;
  const vertCount = indexed.positions.length / 3;
  const { indices } = indexed;
  for (let i = 0; i < indices.length; i++) if (indices[i] >= vertCount) return false;
  return true;
}
