import type { ConformalChart } from '../../src/geometry/conformal';

// Quarter-cylinder shell, the one curved surface that unwraps exactly: radius R about the Y axis,
// θ ∈ [0, 90°], height H. UV is the analytic unwrap (u = R·θ arc length, v = y), so every chart
// quantity has a closed form to test against. Grid spacing ~2mm keeps chord sag (R·dθ²/8) well
// under the 0.05mm accuracy budget.
export const R = 30;
export const H = 60;
export const ARC_U = (R * Math.PI) / 2;

export function cylinderPoint(u: number, v: number): [number, number, number] {
  const th = u / R;
  return [R * Math.sin(th), v, R * Math.cos(th)];
}

export function makeCylinderChart(): ConformalChart {
  const nu = 24; // θ segments → du ≈ 1.96mm
  const nv = 15; // height segments → dv = 4mm
  const positions3: number[] = [];
  const uv: number[] = [];
  for (let i = 0; i <= nu; i++) {
    const u = (i / nu) * ARC_U;
    for (let j = 0; j <= nv; j++) {
      const v = (j / nv) * H;
      positions3.push(...cylinderPoint(u, v));
      uv.push(u, v);
    }
  }
  const triangles: number[] = [];
  const idx = (i: number, j: number): number => i * (nv + 1) + j;
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = idx(i, j),
        b = idx(i + 1, j),
        c = idx(i + 1, j + 1),
        d = idx(i, j + 1);
      triangles.push(a, b, c, a, c, d); // CCW in UV → outward (radial) normals
    }
  }
  return {
    positions3: Float32Array.from(positions3),
    uv: Float32Array.from(uv),
    triangles: Uint32Array.from(triangles),
    normalSign: 1,
    boundary: [
      [0, 0],
      [ARC_U, 0],
      [ARC_U, H],
      [0, H],
    ],
  };
}

/**
 * The same shell reflected across x = 0 (θ ∈ [−90°, 0]), charted the way the bake would chart the
 * twin: seen from outside, so u runs the other way round the axis (u' = ARC_U − u). Reflecting the
 * positions and the UVs each flip the winding once, so the triangles are re-wound to keep the
 * outward normal and `normalSign: 1`.
 */
export function makeMirroredCylinderChart(): ConformalChart {
  const c = makeCylinderChart();
  const positions3 = Float32Array.from(c.positions3);
  for (let i = 0; i < positions3.length; i += 3) positions3[i] = -positions3[i];
  const uv = Float32Array.from(c.uv);
  for (let i = 0; i < uv.length; i += 2) uv[i] = ARC_U - uv[i];
  const triangles = Uint32Array.from(c.triangles);
  for (let t = 0; t < triangles.length; t += 3) {
    const b = triangles[t + 1];
    triangles[t + 1] = triangles[t + 2];
    triangles[t + 2] = b;
  }
  return { ...c, positions3, uv, triangles };
}
