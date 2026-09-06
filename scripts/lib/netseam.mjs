/**
 * Where two sheets of the whole-part net meet, and whether the surface under that meeting point is
 * actually continuous.
 *
 * Two sheets registered across a shared seam abut on the canvas everywhere along their boundary —
 * the partition guarantees it, since every point of the canvas belongs to exactly one of them. That
 * says nothing about the part: the registration is one rigid fit through the vertices the two zones
 * SHARE, so it lands the two sheets on each other only over the stretch those vertices span.
 * Everywhere else the sheets still abut, and a design drawn across the join is torn — the halves
 * cut on surfaces tens of millimetres apart.
 *
 * This module is the measurement, shared on purpose by the two places that must agree about it:
 * scripts/lib/zonebake.mjs bakes the answer into the sidecar, and scripts/check-net-design.mjs
 * re-derives it against the shipped sidecar and the real export. A second implementation would let
 * the two drift, and the number decides what the template draws.
 *
 * Deliberately free of TypeScript imports so it runs under plain `node`, like lib/mesh.mjs.
 */

/**
 * One zone's chart triangles carrying both spaces: UV as the sheet lays them out, and the 3D point
 * each vertex sits at on the part. `vertsOf(chart)` returns that chart's part vertices, indexed the
 * way `chart.verts` indexes them.
 */
export function chartTriangles(charts, vertsOf) {
  const tris = [];
  for (const chart of charts) {
    const packed = vertsOf(chart);
    const p3 = chart.verts.map((vi) => {
      const v = packed[vi];
      if (!v)
        throw new Error(
          `chart references vertex ${vi} of ${chart.libraryPartId}, which has ${packed.length}`,
        );
      return v;
    });
    for (const [a, b, c] of chart.chartTris) {
      const uv = [
        [chart.uv[2 * a], chart.uv[2 * a + 1]],
        [chart.uv[2 * b], chart.uv[2 * b + 1]],
        [chart.uv[2 * c], chart.uv[2 * c + 1]],
      ];
      tris.push({
        part: chart.libraryPartId,
        uv,
        p: [p3[a], p3[b], p3[c]],
        mn: [Math.min(uv[0][0], uv[1][0], uv[2][0]), Math.min(uv[0][1], uv[1][1], uv[2][1])],
        mx: [Math.max(uv[0][0], uv[1][0], uv[2][0]), Math.max(uv[0][1], uv[1][1], uv[2][1])],
      });
    }
  }
  return tris;
}

/** Net mm -> that zone's own UV mm. The net places a sheet at R(theta)*p_zone + t. */
export function netToZoneUV(place, p) {
  const r = (-place.rotationDeg * Math.PI) / 180;
  const c = Math.cos(r),
    s = Math.sin(r);
  const dx = p[0] - place.offsetU,
    dy = p[1] - place.offsetV;
  return [c * dx - s * dy, s * dx + c * dy];
}

/**
 * Cells per axis in the lookup grid below. A memory-for-time trade, not a geometric threshold:
 * every candidate it returns is still tested exactly, so the number changes how long a survey takes
 * and nothing about what it answers. A chair sheet carries ~50k triangles, and the linear scan this
 * replaces made one boundary survey take over ten minutes.
 */
const GRID_CELLS = 256;

/** Per triangle array, its UV lookup grid — built on first use so callers need not thread it. */
const gridCache = new WeakMap();

function gridFor(tris) {
  let g = gridCache.get(tris);
  if (g) return g;
  let minU = Infinity,
    minV = Infinity,
    maxU = -Infinity,
    maxV = -Infinity;
  for (const t of tris) {
    if (t.mn[0] < minU) minU = t.mn[0];
    if (t.mn[1] < minV) minV = t.mn[1];
    if (t.mx[0] > maxU) maxU = t.mx[0];
    if (t.mx[1] > maxV) maxV = t.mx[1];
  }
  const su = (maxU - minU) / GRID_CELLS || 1;
  const sv = (maxV - minV) / GRID_CELLS || 1;
  const cells = new Map();
  const key = (i, j) => i * (GRID_CELLS + 1) + j;
  const clamp = (n) => Math.max(0, Math.min(GRID_CELLS, n));
  for (const t of tris)
    for (
      let i = clamp(Math.floor((t.mn[0] - minU) / su));
      i <= clamp(Math.floor((t.mx[0] - minU) / su));
      i++
    )
      for (
        let j = clamp(Math.floor((t.mn[1] - minV) / sv));
        j <= clamp(Math.floor((t.mx[1] - minV) / sv));
        j++
      ) {
        const k = key(i, j);
        let list = cells.get(k);
        if (!list) cells.set(k, (list = []));
        list.push(t);
      }
  g = { minU, minV, su, sv, cells, key, clamp };
  gridCache.set(tris, g);
  return g;
}

/** The 3D point one zone's charts put at a UV, by barycentric interpolation, or null off-chart. */
export function surfaceAt(tris, uv) {
  if (!tris.length) return null;
  const g = gridFor(tris);
  const i = g.clamp(Math.floor((uv[0] - g.minU) / g.su));
  const j = g.clamp(Math.floor((uv[1] - g.minV) / g.sv));
  for (const t of g.cells.get(g.key(i, j)) ?? []) {
    if (uv[0] < t.mn[0] || uv[0] > t.mx[0] || uv[1] < t.mn[1] || uv[1] > t.mx[1]) continue;
    const [A, B, C] = t.uv;
    const v0 = [C[0] - A[0], C[1] - A[1]],
      v1 = [B[0] - A[0], B[1] - A[1]],
      v2 = [uv[0] - A[0], uv[1] - A[1]];
    const d00 = v0[0] * v0[0] + v0[1] * v0[1],
      d01 = v0[0] * v1[0] + v0[1] * v1[1],
      d11 = v1[0] * v1[0] + v1[1] * v1[1],
      d20 = v2[0] * v0[0] + v2[1] * v0[1],
      d21 = v2[0] * v1[0] + v2[1] * v1[1];
    const den = d00 * d11 - d01 * d01;
    if (Math.abs(den) < 1e-12) continue;
    const u = (d11 * d20 - d01 * d21) / den,
      v = (d00 * d21 - d01 * d20) / den;
    if (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9) continue;
    const w = 1 - u - v;
    return {
      P: [0, 1, 2].map((k) => w * t.p[0][k] + v * t.p[1][k] + u * t.p[2][k]),
      part: t.part,
    };
  }
  return null;
}

export function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
    const a = ring[i],
      b = ring[k];
    if (
      a[1] > pt[1] !== b[1] > pt[1] &&
      pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

/** The exclusion covering this zone-UV point, i.e. the neighbour that owns that patch of canvas. */
export function exclusionAt(excluded, uv) {
  for (const e of excluded ?? [])
    for (const region of e.regions) {
      if (!inRing(uv, region.outer)) continue;
      if ((region.holes ?? []).some((h) => inRing(uv, h))) continue;
      return e;
    }
  return null;
}

/**
 * Who cuts a point of the whole-part canvas, and where that lands in 3D.
 *
 * `sheets` is a Map of zoneId -> { tris, place, excluded }. `others` carries what the zones that
 * did NOT win put at the same net point, which is what "cut exactly once" is asserted against.
 */
export function netPoint(sheets, u, v) {
  const covering = [];
  for (const [zoneId, sheet] of sheets) {
    const uv = netToZoneUV(sheet.place, [u, v]);
    const hit = surfaceAt(sheet.tris, uv);
    if (!hit) continue;
    covering.push({ zoneId, uv, ...hit, excluded: exclusionAt(sheet.excluded, uv) });
  }
  const owners = covering.filter((c) => !c.excluded);
  return {
    owner: owners.length === 1 ? owners[0] : null,
    owners,
    others: covering.filter((c) => !owners.includes(c)),
    covering,
  };
}

/** How finely the boundary is located along the canvas. See `surveyBoundary` on why it is not a tolerance. */
export const SURVEY_U_STEP_MM = 0.5;

/** How far apart the rows are. 2mm over a ~400mm boundary is 200 samples, which the bake affords. */
export const SURVEY_V_STEP_MM = 2;

/**
 * Walk the whole boundary between two sheets and report how far a mark would jump in 3D at each
 * crossing.
 *
 * Rows are scanned in net v, and per row the last canvas the first sheet owns and the first the
 * second owns are compared: the two are adjacent on the canvas by construction, so the distance
 * between their 3D points is the tear a design crossing there would take.
 *
 * `uStep` is a sampling resolution, not a tolerance. The two samples straddling the boundary are up
 * to that far apart on the canvas, so a genuinely continuous crossing still reports a jump of about
 * that much of real surface travel — which is why callers add it to the registration bar rather
 * than picking a slack of their own.
 */
export function surveyBoundary(
  sheets,
  a,
  b,
  { vStep = SURVEY_V_STEP_MM, uStep = SURVEY_U_STEP_MM, uFrom, uTo, vFrom, vTo },
) {
  const rows = [];
  for (let v = vFrom; v <= vTo; v += vStep) {
    let lastA = null,
      firstB = null;
    for (let u = uFrom; u <= uTo; u += uStep) {
      const owners = netPoint(sheets, u, v).owners.map((o) => [o.zoneId, o.P]);
      const inA = owners.find(([z]) => z === a);
      const inB = owners.find(([z]) => z === b);
      if (inA && !firstB) lastA = { u, P: inA[1] };
      if (inB && !firstB && lastA) firstB = { u, P: inB[1] };
    }
    if (lastA && firstB)
      rows.push({
        v,
        u: (lastA.u + firstB.u) / 2,
        canvasGap: firstB.u - lastA.u,
        jump: Math.hypot(...[0, 1, 2].map((k) => lastA.P[k] - firstB.P[k])),
      });
  }
  return rows;
}

const quantile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

/**
 * The survey reduced to what the sidecar carries and the template draws: how many rows of the
 * boundary cross within `tolMm`, and the net-v stretch they span.
 *
 * `vFrom`/`vTo` are absent when nothing crosses — there is then no continuous stretch to mark, and
 * a caller must not read a zero-length one as "continuous at v = 0".
 */
export function seamContinuity(rows, tolMm) {
  if (!rows.length) return null;
  const met = rows.filter((r) => r.jump <= tolMm);
  const sorted = rows.map((r) => r.jump).sort((x, y) => x - y);
  return {
    rows: rows.length,
    met: met.length,
    ...(met.length
      ? { vFrom: Math.min(...met.map((r) => r.v)), vTo: Math.max(...met.map((r) => r.v)) }
      : {}),
    jumpMm: {
      median: quantile(sorted, 0.5),
      p95: quantile(sorted, 0.95),
      max: sorted[sorted.length - 1],
    },
  };
}
