import { beforeAll, describe, expect, it } from 'vitest';
import {
  bakeZones,
  boundaryVertexLoops,
  simplifyLoop,
  // @ts-expect-error — plain-JS tooling module, no .d.ts (run by vite-node, not bundled)
} from '../scripts/lib/zonebake.mjs';
import { ConformalZoneMapper, type ConformalChart } from '../src/geometry/conformal';
import { getManifold, type ManifoldAPI } from '../src/geometry/manifold';

// Same analytic quarter-cylinder the conformal mapper tests use (radius R about the Y axis,
// θ ∈ [0, 90°], height H), but as an indexed mesh the bake has to unwrap itself. A polyhedral
// cylinder is developable, so LSCM must recover the unwrap exactly (up to the chord-vs-arc gap)
// and every closed form from tests/conformal.test.ts applies to the baked output.
const R = 30;
const H = 60;
const NU = 24;
const NV = 15;
const ARC_U = (R * Math.PI) / 2;

type Part = { libraryPartId: string; verts: number[][]; tris: number[][] };

function cylinderPart(
  libraryPartId: string,
  iFrom: number,
  iTo: number,
  shift: [number, number, number] = [0, 0, 0],
): Part {
  const verts: number[][] = [];
  for (let i = iFrom; i <= iTo; i++) {
    const th = ((i / NU) * Math.PI) / 2;
    for (let j = 0; j <= NV; j++)
      verts.push([
        R * Math.sin(th) + shift[0],
        (j / NV) * H + shift[1],
        R * Math.cos(th) + shift[2],
      ]);
  }
  const tris: number[][] = [];
  const idx = (i: number, j: number): number => (i - iFrom) * (NV + 1) + j;
  for (let i = iFrom; i < iTo; i++)
    for (let j = 0; j < NV; j++) {
      const a = idx(i, j),
        b = idx(i + 1, j),
        c = idx(i + 1, j + 1),
        d = idx(i, j + 1);
      tris.push([a, b, c], [a, c, d]); // CCW seen from outside → outward normals
    }
  return { libraryPartId, verts, tris };
}

/** Flat plate in the z=0 plane (normal +z) built from 10mm grid cells, skipping `skip` cells. */
function platePart(
  libraryPartId: string,
  cells: number,
  skip: (cx: number, cy: number) => boolean,
): Part {
  const verts: number[][] = [];
  for (let i = 0; i <= cells; i++) for (let j = 0; j <= cells; j++) verts.push([i * 10, j * 10, 0]);
  const tris: number[][] = [];
  const idx = (i: number, j: number): number => i * (cells + 1) + j;
  for (let i = 0; i < cells; i++)
    for (let j = 0; j < cells; j++) {
      if (skip(i, j)) continue;
      const a = idx(i, j),
        b = idx(i + 1, j),
        c = idx(i + 1, j + 1),
        d = idx(i, j + 1);
      tris.push([a, b, c], [a, c, d]);
    }
  return { libraryPartId, verts, tris };
}

function cubePart(libraryPartId: string): Part {
  const s = 10;
  const verts: number[][] = [];
  for (let i = 0; i < 8; i++) verts.push([i & 1 ? s : -s, i & 2 ? s : -s, i & 4 ? s : -s]);
  const v = (x: number, y: number, z: number): number =>
    (x > 0 ? 1 : 0) + (y > 0 ? 2 : 0) + (z > 0 ? 4 : 0);
  const quads = [
    [v(1, -1, -1), v(1, 1, -1), v(1, 1, 1), v(1, -1, 1)], // +X
    [v(-1, -1, -1), v(-1, -1, 1), v(-1, 1, 1), v(-1, 1, -1)], // -X
    [v(-1, 1, -1), v(-1, 1, 1), v(1, 1, 1), v(1, 1, -1)], // +Y
    [v(-1, -1, -1), v(1, -1, -1), v(1, -1, 1), v(-1, -1, 1)], // -Y
    [v(-1, -1, 1), v(1, -1, 1), v(1, 1, 1), v(-1, 1, 1)], // +Z
    [v(-1, -1, -1), v(-1, 1, -1), v(1, 1, -1), v(1, -1, -1)], // -Z
  ];
  const tris = quads.flatMap((q) => [
    [q[0], q[1], q[2]],
    [q[0], q[2], q[3]],
  ]);
  return { libraryPartId, verts, tris };
}

const config = (parts: Part[], zones: object[], extra: object = {}): object => ({
  schema: 1,
  kindId: 'fixture',
  parts: parts.map((p) => ({ libraryPartId: p.libraryPartId, file: '-' })),
  zones,
  ...extra,
});

const WRAP_ZONE = {
  id: 'wrap',
  name: 'Wrap',
  seedNormal: [Math.SQRT1_2, 0, Math.SQRT1_2],
  maxAngleDeg: 50,
  up: [0, 1, 0],
};

const loopArea = (pts: number[][]): number => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
};

const uvBBox = (uv: number[]): { w: number; h: number } => {
  let minU = Infinity,
    maxU = -Infinity,
    minV = Infinity,
    maxV = -Infinity;
  for (let i = 0; i < uv.length; i += 2) {
    minU = Math.min(minU, uv[i]);
    maxU = Math.max(maxU, uv[i]);
    minV = Math.min(minV, uv[i + 1]);
    maxV = Math.max(maxV, uv[i + 1]);
  }
  return { w: maxU - minU, h: maxV - minV };
};

describe('quarter-cylinder bake', () => {
  const part = cylinderPart('cyl', 0, NU);
  const baked = bakeZones(config([part], [WRAP_ZONE]), [part]);
  const zone = baked.sidecar.zones[0];
  const chart = zone.charts[0];

  it('segments the whole shell into one single-chart zone', () => {
    expect(baked.sidecar.zones).toHaveLength(1);
    expect(zone.charts).toHaveLength(1);
    expect(chart.tris).toHaveLength(NU * NV * 2);
    expect(chart.libraryPartId).toBe('cyl');
  });

  it('unwraps to true mm: chart spans the chordal arc length by the height', () => {
    const { w, h } = uvBBox(chart.uv);
    // the polyhedral unwrap measures chords, not arcs — 24 chords land 0.008mm short of ARC_U
    expect(Math.abs(w - ARC_U)).toBeLessThan(0.05);
    expect(h).toBeCloseTo(H, 3);
  });

  it('reports near-zero distortion for a developable surface', () => {
    expect(zone.distortion.max).toBeLessThan(1.001);
    expect(zone.distortion.mean).toBeLessThan(1.001);
    expect(baked.warnings).toHaveLength(0);
  });

  it('orients the chart seen-from-outside with up reading +v', () => {
    // part vertex 0 is (θ=0, y=0): +v = +y puts it at v≈0, and the seen-from-outside handedness
    // (S_u × S_v = N̂) forces u to grow with θ, so it sits at the chart origin, not mirrored
    const at0 = chart.verts.indexOf(0);
    expect(at0).toBeGreaterThanOrEqual(0);
    expect(chart.uv[2 * at0]).toBeLessThan(0.05);
    expect(chart.uv[2 * at0 + 1]).toBeLessThan(0.05);
    const last = chart.verts.indexOf(NU * (NV + 1) + NV); // (θ=90°, y=H)
    const { w, h } = uvBBox(chart.uv);
    expect(chart.uv[2 * last]).toBeCloseTo(w, 1);
    expect(chart.uv[2 * last + 1]).toBeCloseTo(h, 1);
    expect(zone.normalSign).toBe(1);
  });

  it('simplifies the boundary to a CCW rectangle with no holes', () => {
    expect(zone.boundary.length).toBeLessThanOrEqual(8);
    expect(loopArea(zone.boundary)).toBeGreaterThan(0);
    expect(loopArea(zone.boundary)).toBeCloseTo(ARC_U * H, -2);
    expect(zone.holes).toHaveLength(0);
    expect(zone.seams).toHaveLength(0);
  });

  it('fingerprints the mesh for the load-time guard', () => {
    expect(baked.sidecar.meshes.cyl.triangleCount).toBe(NU * NV * 2);
    expect(baked.sidecar.meshes.cyl.bboxHash).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('baked sidecar drives the conformal mapper', () => {
  let wasm: ManifoldAPI;
  beforeAll(async () => {
    wasm = await getManifold();
  }, 30000);

  it('frameAt on a chart assembled from the sidecar lands on the cylinder', () => {
    const part = cylinderPart('cyl', 0, NU);
    const baked = bakeZones(config([part], [WRAP_ZONE]), [part]);
    const zone = baked.sidecar.zones[0];
    const c = zone.charts[0];
    // the Phase 5 runtime loader in miniature: chart verts are part-local packed indices
    const positions3 = new Float32Array(c.verts.length * 3);
    c.verts.forEach((lv: number, i: number) => positions3.set(part.verts[lv], i * 3));
    const chart: ConformalChart = {
      positions3,
      uv: Float32Array.from(c.uv),
      triangles: Uint32Array.from(c.chartTris.flat()),
      normalSign: zone.normalSign,
      boundary: zone.boundary,
      holes: zone.holes,
    };
    const mapper = new ConformalZoneMapper(wasm, chart);
    for (const du of [-20, -7.5, 0, 12, 20]) {
      for (const dv of [-25, 0, 25]) {
        const f = mapper.frameAt(du, dv);
        const r = Math.hypot(f.origin.x, f.origin.z);
        // chords sag up to R·dθ²/8 ≈ 0.016mm below the true cylinder, never above it
        expect(r).toBeGreaterThan(R - 0.05);
        expect(r).toBeLessThan(R + 0.01);
        expect(f.origin.y).toBeCloseTo(H / 2 + dv, 1);
      }
    }
  });
});

describe('cross-part welding and seams', () => {
  // the shared θ=45° vertex column is duplicated in both parts, and part B is nudged 0.2µm so
  // the weld tolerance (not exact equality) is what joins them
  const partA = cylinderPart('part-a', 0, NU / 2);
  const partB = cylinderPart('part-b', NU / 2, NU, [2e-4, 0, 0]);
  const baked = bakeZones(config([partA, partB], [WRAP_ZONE]), [partA, partB]);
  const zone = baked.sidecar.zones[0];

  it('welds the two parts into one island spanning two charts', () => {
    expect(zone.charts).toHaveLength(2);
    expect(zone.charts.map((c: { libraryPartId: string }) => c.libraryPartId)).toEqual([
      'part-a',
      'part-b',
    ]);
    const all = zone.charts.flatMap((c: { uv: number[] }) => c.uv);
    expect(Math.abs(uvBBox(all).w - ARC_U)).toBeLessThan(0.05);
  });

  it('records the part seam as one polyline down the mid-arc', () => {
    expect(zone.seams).toHaveLength(1);
    const seam = zone.seams[0];
    const w = uvBBox(zone.charts.flatMap((c: { uv: number[] }) => c.uv)).w;
    for (const [u] of seam) expect(Math.abs(u - w / 2)).toBeLessThan(0.1);
    const vs = seam.map((p: number[]) => p[1]);
    expect(Math.min(...vs)).toBeCloseTo(0, 1);
    expect(Math.max(...vs)).toBeCloseTo(H, 1);
  });

  it('gives each chart its own closed UV sub-boundary', () => {
    for (const c of zone.charts) {
      expect(c.subBoundary).toHaveLength(1);
      expect(Math.abs(loopArea(c.subBoundary[0]))).toBeCloseTo((ARC_U * H) / 2, -2);
    }
  });

  it('marks the seam in the zone template', () => {
    expect(baked.templates[0].svg).toContain('printed-part seam');
    expect(baked.templates[0].svg).toContain('<polyline');
  });
});

describe('flat plate with a hole', () => {
  const part = platePart('plate', 10, (cx, cy) => cx >= 4 && cx <= 5 && cy >= 4 && cy <= 5);
  const zone = { id: 'face', name: 'Face', seedNormal: [0, 0, 1], maxAngleDeg: 30, up: [0, 1, 0] };
  const baked = bakeZones(config([part], [zone]), [part]);
  const z = baked.sidecar.zones[0];

  it('unwraps isometrically: 100x100 outline, stretch ~1', () => {
    const bb = uvBBox(z.boundary.flat());
    expect(bb.w).toBeCloseTo(100, 3);
    expect(bb.h).toBeCloseTo(100, 3);
    expect(z.distortion.max).toBeLessThan(1.0001);
  });

  it('keeps the 20x20 hole as a hole ring', () => {
    expect(z.holes).toHaveLength(1);
    expect(Math.abs(loopArea(z.holes[0]))).toBeCloseTo(400, 0);
  });

  it('punches the hole out of the true-size template', () => {
    const svg = baked.templates[0].svg;
    expect(svg).toContain('width="100mm"');
    expect(svg).toContain('height="100mm"');
    expect(svg).toContain('fill-rule="evenodd"');
    expect(svg).toContain('GENERATED by scripts/bake-zones.mjs');
  });
});

describe('cube face zone', () => {
  it('bakes the top face alone at exact scale', () => {
    const part = cubePart('cube');
    const zone = { id: 'top', name: 'Top', seedNormal: [0, 1, 0], maxAngleDeg: 30, up: [0, 0, 1] };
    const baked = bakeZones(config([part], [zone]), [part]);
    const z = baked.sidecar.zones[0];
    expect(z.charts[0].tris).toHaveLength(2);
    const bb = uvBBox(z.boundary.flat());
    expect(bb.w).toBeCloseTo(20, 3);
    expect(bb.h).toBeCloseTo(20, 3);
  });
});

describe('bad inputs fail loudly', () => {
  it('refuses a closed surface (nothing to pin, no boundary)', () => {
    const part = cubePart('cube');
    const zone = { id: 'all', name: 'All', seedNormal: [0, 1, 0], maxAngleDeg: 180, up: [0, 0, 1] };
    expect(() => bakeZones(config([part], [zone]), [part])).toThrow(/closed/);
  });

  it('refuses a zone that is not a single connected island', () => {
    // two coplanar quads 20mm apart: one flat patch (same normal AND plane), two components
    const part = platePart('plate', 4, (cx) => cx === 1 || cx === 2);
    const zone = { id: 'z', name: 'Z', seedNormal: [0, 0, 1], maxAngleDeg: 30, up: [0, 1, 0] };
    expect(() => bakeZones(config([part], [zone]), [part])).toThrow(/single connected island/);
  });

  it('refuses a seedNormal no flat patch points along', () => {
    const part = platePart('plate', 4, () => false);
    const zone = { id: 'z', name: 'Z', seedNormal: [1, 0, 0], maxAngleDeg: 30, up: [0, 1, 0] };
    expect(() => bakeZones(config([part], [zone]), [part])).toThrow(/no flat patch/);
  });

  it('refuses duplicate zone ids', () => {
    const part = platePart('plate', 4, () => false);
    const zone = { id: 'z', name: 'Z', seedNormal: [0, 0, 1], maxAngleDeg: 30, up: [0, 1, 0] };
    expect(() => bakeZones(config([part], [zone, { ...zone }]), [part])).toThrow(/duplicate/);
  });
});

describe('pinch vertices', () => {
  it('splits a bowtie into two closed loops instead of dropping one', () => {
    // two triangles meeting at vertex 2 alone: it has two outgoing boundary edges, so a
    // successor keyed by tail vertex keeps only one and the other loop never closes
    const loops: number[][] = boundaryVertexLoops([
      [0, 1, 2],
      [2, 3, 4],
    ]);
    expect(loops).toHaveLength(2);
    for (const l of loops) {
      expect(l).toHaveLength(3);
      expect(l.filter((v) => v === 2)).toHaveLength(1);
    }
    expect(loops.map((l) => [...l].sort((a, b) => a - b))).toEqual(
      expect.arrayContaining([
        [0, 1, 2],
        [2, 3, 4],
      ]),
    );
  });

  it('keeps both holes when two of them touch at one vertex', () => {
    // 40x40 plate with the (1,1) and (2,2) cells removed — the two 10x10 holes share the corner
    // at (20, 20), pinching the boundary there
    const part = platePart(
      'plate',
      4,
      (cx, cy) => (cx === 1 && cy === 1) || (cx === 2 && cy === 2),
    );
    const zone = {
      id: 'face',
      name: 'Face',
      seedNormal: [0, 0, 1],
      maxAngleDeg: 30,
      up: [0, 1, 0],
    };
    const z = bakeZones(config([part], [zone]), [part]).sidecar.zones[0];

    expect(loopArea(z.boundary)).toBeCloseTo(1600, 0);
    expect(z.holes).toHaveLength(2);
    for (const h of z.holes) expect(Math.abs(loopArea(h))).toBeCloseTo(100, 0);
    // the invariant the chair's first `right` bake broke: holes are punched out of the outer ring,
    // so together they can never enclose more area than it does
    const holes = z.holes.reduce((s: number, h: number[][]) => s + Math.abs(loopArea(h)), 0);
    expect(holes).toBeLessThan(Math.abs(loopArea(z.boundary)));
  });
});

describe('simplifyLoop', () => {
  it('collapses a dense circle without leaving the tolerance band', () => {
    const pts: number[][] = [];
    for (let i = 0; i < 200; i++) {
      const th = (i / 200) * 2 * Math.PI;
      pts.push([30 * Math.cos(th), 30 * Math.sin(th)]);
    }
    const out = simplifyLoop(pts, 0.2);
    expect(out.length).toBeLessThan(60);
    expect(out.length).toBeGreaterThan(8);
    // every surviving point is an original point, so radius stays exact
    for (const [x, y] of out) expect(Math.hypot(x, y)).toBeCloseTo(30, 6);
  });
});
