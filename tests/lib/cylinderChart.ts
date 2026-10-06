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

/**
 * A closed solid behind the quarter-cylinder chart: its outer face is the chart's surface, and it is
 * `thinMM` thick below v = H/2 and `thickMM` above, so a wall bound can be told per region. Same 24
 * θ segments as the chart, so the two outer surfaces coincide. Triangle soup, wound outward.
 */
export function makeSteppedShell(thinMM: number, thickMM: number): Float32Array {
  const nu = 24;
  // (r, y) profile, counter-clockwise; (R, H/2) splits the outer side so the caps meet it.
  const profile = [
    [R - thinMM, 0],
    [R, 0],
    [R, H / 2],
    [R, H],
    [R - thickMM, H],
    [R - thickMM, H / 2],
    [R - thinMM, H / 2],
  ];
  const at = (r: number, y: number, th: number): number[] => [
    r * Math.sin(th),
    y,
    r * Math.cos(th),
  ];
  const out: number[] = [];
  const push = (a: number[], b: number[], c: number[], outward: number[]): void => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const flip = n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2] < 0;
    out.push(...a, ...(flip ? c : b), ...(flip ? b : c));
  };
  for (let i = 0; i < nu; i++) {
    const ta = (i / nu) * (Math.PI / 2),
      tb = ((i + 1) / nu) * (Math.PI / 2),
      tm = (ta + tb) / 2;
    for (let k = 0; k < profile.length; k++) {
      const [pr, py] = profile[k];
      const [qr, qy] = profile[(k + 1) % profile.length];
      // the profile edge's outward normal in (r, y), swept to the segment's middle
      const o = [(qy - py) * Math.sin(tm), -(qr - pr), (qy - py) * Math.cos(tm)];
      const P0 = at(pr, py, ta),
        Q0 = at(qr, qy, ta),
        Q1 = at(qr, qy, tb),
        P1 = at(pr, py, tb);
      push(P0, Q0, Q1, o);
      push(P0, Q1, P1, o);
    }
  }
  const [A, B, G, C, D, E, F] = profile;
  const cap: number[][][] = [
    [A, B, G],
    [A, G, F],
    [F, G, C],
    [E, F, C],
    [E, C, D],
  ];
  for (const [th, outward] of [
    [0, [-1, 0, 0]],
    [Math.PI / 2, [0, 0, -1]],
  ] as [number, number[]][])
    for (const [a, b, c] of cap)
      push(at(a[0], a[1], th), at(b[0], b[1], th), at(c[0], c[1], th), outward);
  return Float32Array.from(out);
}
