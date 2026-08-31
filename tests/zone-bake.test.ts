import { beforeAll, describe, expect, it } from 'vitest';
import {
  bakeZones,
  boundaryVertexLoops,
  weldParts,
  simplifyLoop,
  meshFingerprint as bakeFingerprint,
  symmetrizeCovers,
  regionNetArea,
  // @ts-expect-error — plain-JS tooling module, no .d.ts (run by vite-node, not bundled)
} from '../scripts/lib/zonebake.mjs';
import { meshFingerprint as runtimeFingerprint } from '../src/geometry/zoneCharts';
import { ConformalZoneMapper, type ConformalChart } from '../src/geometry/conformal';
import { getManifold, type ManifoldAPI } from '../src/geometry/manifold';
import type { DesignPlacement } from '../src/geometry/zones';

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

/** Unrotated, unflipped, 1:1 placement of an SVG whose own centre is (5, 5). */
const PLACEMENT: DesignPlacement = {
  svgC: { cx: 5, cy: 5, r: 5 },
  mmPerUnit: 1,
  xFlip: 1,
  zMul: -1,
  offX: 0,
  offZ: 0,
  rotationDeg: 0,
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

  // The clip region each part's cutter gets. On this two-part zone it must be that part's HALF of
  // the surface, not the whole zone — clipping to the zone outline pushes artwork past the chart
  // the mapper can warp against, and the color disappears from both parts.
  it('gives each chart its own half of the zone as its clip region', () => {
    expect(zone.charts).toHaveLength(2);
    for (const c of zone.charts) {
      expect(c.subRegions).toHaveLength(1);
      expect(c.subRegions[0].holes).toEqual([]);
      expect(Math.abs(loopArea(c.subRegions[0].outer))).toBeCloseTo((ARC_U * H) / 2, -2);
    }
    // and the two halves account for the whole zone, with neither claiming the other's side
    const total = zone.charts.reduce(
      (s: number, c: { subRegions: { outer: number[][] }[] }) =>
        s + Math.abs(loopArea(c.subRegions[0].outer)),
      0,
    );
    expect(total).toBeCloseTo(Math.abs(loopArea(zone.boundary)), -2);
  });

  // Placement and fill tiling anchor on the zone's UV bbox, which must therefore be measured across
  // both charts: anchoring on a chart's own (half-width) bbox would centre a whole copy of the
  // design on each part's half, so a design straddling the seam would render twice, mis-registered
  // against the zone-wide template.
  it('bakes one zone-wide UV bbox and places both parts against it', () => {
    const all = uvBBox(zone.charts.flatMap((c: { uv: number[] }) => c.uv));
    expect(zone.uvBounds.minU).toBe(0);
    expect(zone.uvBounds.minV).toBe(0);
    expect(zone.uvBounds.maxU).toBeCloseTo(all.w, 3);
    expect(zone.uvBounds.maxV).toBeCloseTo(all.h, 3);
    // each part on its own carries only half the arc, so the bbox is genuinely wider than either
    for (const c of zone.charts) expect(uvBBox(c.uv).w).toBeLessThan(all.w * 0.6);

    const parts: Record<string, Part> = { 'part-a': partA, 'part-b': partB };
    const place = zone.charts.map(
      (c: {
        libraryPartId: string;
        verts: number[];
        uv: number[];
        chartTris: number[][];
        subRegions: ConformalChart['subRegions'];
      }) => {
        const part = parts[c.libraryPartId];
        const positions3 = new Float32Array(c.verts.length * 3);
        c.verts.forEach((lv: number, i: number) => positions3.set(part.verts[lv], i * 3));
        const chart: ConformalChart = {
          positions3,
          uv: Float32Array.from(c.uv),
          triangles: Uint32Array.from(c.chartTris.flat()),
          normalSign: zone.normalSign,
          boundary: zone.boundary,
          holes: zone.holes,
          subRegions: c.subRegions,
          zoneBounds: zone.uvBounds,
        };
        const mapper = new ConformalZoneMapper(null, chart);
        // the SVG's own centre maps to the placement anchor
        return { at: mapper.placer(PLACEMENT)([5, 5]), extent: mapper.fillExtent()! };
      },
    );
    expect(place[1].at[0]).toBeCloseTo(place[0].at[0], 6);
    expect(place[1].at[1]).toBeCloseTo(place[0].at[1], 6);
    expect(place[0].at[0]).toBeCloseTo(zone.uvBounds.maxU / 2, 6);
    expect(place[0].at[1]).toBeCloseTo(zone.uvBounds.maxV / 2, 6);
    expect(place[1].extent).toEqual(place[0].extent);
    expect(place[0].extent.maxX).toBeCloseTo(zone.uvBounds.maxU, 6);
  });

  it('marks the seam in the zone template', () => {
    expect(baked.templates[0].svg).toContain('printed-part seam');
    expect(baked.templates[0].svg).toContain('<polyline');
  });

  // The sheet tells the artist "the app clips artwork to exactly this outline", so it has to be
  // drawn from the per-part clip regions. Drawn from the whole-zone lobes instead it disagreed:
  // chained across a stitched seam those fan into spikes (48 lobes on the chair's left flank), and
  // all five chair sheets shipped showing wedges of surface that does not exist next to white gaps
  // over surface that does.
  it('draws the grey silhouette from the clip regions', () => {
    const d = /<path d="([^"]+)"/.exec(baked.templates[0].svg)![1];
    const subpaths = d
      .split('M')
      .slice(1)
      .map((sp) =>
        sp
          .replace(/Z\s*$/, '')
          .split('L')
          .map((p) => p.trim().split(/\s+/).map(Number)),
      );
    const loops = zone.charts.flatMap(
      (c: { subRegions: { outer: number[][]; holes: number[][][] }[] }) =>
        c.subRegions.flatMap((r) => [r.outer, ...r.holes]),
    );
    expect(subpaths).toHaveLength(loops.length);
    const area = (ls: number[][][]) => ls.reduce((s, l) => s + Math.abs(loopArea(l)), 0);
    expect(area(subpaths) / area(loops)).toBeCloseTo(1, 3);
  });

  // The seam line says where the artwork gets split; the labels say which physical piece each side
  // ends up on, which is what decides whether putting a face across the join is a good idea.
  it('names the printed part on each side of the seam', () => {
    const svg = baked.templates[0].svg;
    expect(svg).toContain('>part a<');
    expect(svg).toContain('>part b<');
    expect(svg).toContain('Labels name the printed part');
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

/**
 * Separately-printed parts are never coincident — they meet with real clearance (the chair's
 * widest is 0.53mm), so the 1e-3 weld above finds nothing to join and every zone stays trapped on
 * the part it seeds on. `seamWeldTolMm` stitches across that gap; without it, "artwork flows over
 * the seam" is unreachable no matter how the zones are configured.
 */
describe('seam welding across a real print clearance', () => {
  const GAP = 0.4; // mm — a plausible print clearance, far beyond the 1e-3 weld
  const partA = cylinderPart('part-a', 0, NU / 2);
  const partB = cylinderPart('part-b', NU / 2, NU, [GAP, 0, 0]);

  it('leaves the zone on one part when the gap is not stitched', () => {
    const baked = bakeZones(config([partA, partB], [WRAP_ZONE]), [partA, partB]);
    const zone = baked.sidecar.zones[0];
    expect(zone.charts).toHaveLength(1);
    expect(zone.seams).toEqual([]);
  });

  it('spans both parts once seamWeldTolMm covers it, with a seam and a clip region each', () => {
    const baked = bakeZones(config([partA, partB], [WRAP_ZONE], { seamWeldTolMm: GAP * 1.5 }), [
      partA,
      partB,
    ]);
    const zone = baked.sidecar.zones[0];

    expect(zone.charts.map((c: { libraryPartId: string }) => c.libraryPartId)).toEqual([
      'part-a',
      'part-b',
    ]);
    expect(zone.seams).toHaveLength(1);
    // each part is clipped to its own half — the thing the runtime needs to not drop the color
    for (const c of zone.charts) {
      expect(c.subRegions).toHaveLength(1);
      expect(Math.abs(loopArea(c.subRegions[0].outer))).toBeCloseTo((ARC_U * H) / 2, -2);
    }
  });

  it('refuses a tolerance that cannot stitch anything', () => {
    expect(() =>
      bakeZones(config([partA, partB], [WRAP_ZONE], { seamWeldTolMm: 1e-4 }), [partA, partB]),
    ).toThrow(/seamWeldTolMm/);
  });

  // Checked on weldParts directly: routed through bakeZones this would pass whatever the guard
  // does, because segmentZone rejects an inverted part on face angle before the weld matters.
  describe('the facing guard', () => {
    const flat = (id: string, z: number, up: boolean): Part => {
      const p = platePart(id, 2, () => false);
      return {
        libraryPartId: id,
        verts: p.verts.map(([x, y]) => [x, y, z]),
        tris: up ? p.tris : p.tris.map((t) => [t[0], t[2], t[1]]),
      };
    };

    it('stitches two parts whose surfaces face the same way', () => {
      const w = weldParts([flat('a', 0, true), flat('b', GAP, true)], 1e-3, GAP * 1.5);
      expect(
        [...w.seamStitches.values()].reduce((s: number, n: number) => s + n, 0),
      ).toBeGreaterThan(0);
    });

    it('refuses two parts that face each other across the same gap', () => {
      // the lap-joint case: one part's outer skin sitting a clearance away from its neighbour's
      // inner one. Fusing those welds surfaces that are not the same surface.
      const w = weldParts([flat('a', 0, true), flat('b', GAP, false)], 1e-3, GAP * 1.5);
      expect([...w.seamStitches.values()]).toEqual([]);
    });
  });

  // Rejecting a candidate whose two vertices already share a part is not enough on its own: two
  // vertices of one part that share no triangle can each reach the *same* vertex opposite and so
  // meet transitively, folding the faces between them onto each other. Measured on the chair at
  // 0.6mm before the group-owner check existed: 392 folded faces that the pairwise test let past.
  describe('the collapse guard', () => {
    // A quad split (a,b,c)+(a,c,d), so b and d share no triangle. vB sits closer to both b and d
    // than to a, putting both pairs in the candidate list.
    const partA: Part = {
      libraryPartId: 'part-a',
      verts: [
        [0, 0, 0],
        [0.5, 0, 0],
        [2, 2, 0],
        [0, 0.5, 0],
      ],
      tris: [
        [0, 1, 2],
        [0, 2, 3],
      ],
    };
    const partB: Part = {
      libraryPartId: 'part-b',
      verts: [
        [0.3, 0.3, 0.01],
        [3, 0.3, 0.01],
        [0.3, 3, 0.01],
      ],
      tris: [[0, 1, 2]],
    };

    it('lets only the nearest of two same-part vertices reach a shared neighbour', () => {
      const w = weldParts([partA, partB], 1e-3, 0.4);
      expect([...w.seamStitches.values()]).toEqual([1]);
      // partA's two faces still span four vertices. Taking both stitches merges b into d, leaving
      // the faces on the same three vertices wound opposite ways.
      const [f0, f1] = w.tris as { v: number[] }[];
      expect(new Set([...f0.v, ...f1.v]).size).toBe(4);
    });
  });
});

// The bake parses the 3MF into doubles; the runtime hashes the Float32Array load3MF produces. If
// the bake doesn't narrow to float32 first, a coordinate can round to a different 3rd decimal on
// each side, the fingerprints disagree, and the part's zones are dropped at load with no error.
// Real case: chair-wheel-mount-left's max z of -203.4805 (-203.481 double, -203.480 float32),
// dormant until that part first appeared in a chart.
describe('the mesh fingerprint survives the double-to-float32 narrowing', () => {
  const part = {
    libraryPartId: 'narrows',
    verts: [
      [0, 0, 0],
      [1, 0, -203.4805],
      [0, 1, 0],
    ],
    tris: [[0, 1, 2]],
  };

  it('agrees with the runtime fingerprint the loader will compute', () => {
    const f32 = new Float32Array(part.verts.length * 3);
    part.verts.forEach((v, i) => f32.set(v, i * 3));
    expect(bakeFingerprint(part)).toEqual(runtimeFingerprint(f32, part.tris.length));
  });
});

// Dead-surface classification, on shapes whose hidden area is known in closed form. Every case is
// the same 200x200 plate; what changes is the cover and the plate's tessellation.
describe('hidden surface classification', () => {
  let wasm: ManifoldAPI;
  beforeAll(async () => {
    wasm = await getManifold();
  }, 30000);

  type Cover = { verts: number[][]; tris: number[][] };

  /** Axis-aligned box, outward-wound. */
  function boxCover(lo: number[], hi: number[]): Cover {
    const verts: number[][] = [];
    for (let i = 0; i < 8; i++)
      verts.push([i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]]);
    const v = (x: number, y: number, z: number): number => x + y * 2 + z * 4;
    const quads = [
      [v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1)],
      [v(0, 0, 0), v(0, 0, 1), v(0, 1, 1), v(0, 1, 0)],
      [v(0, 1, 0), v(0, 1, 1), v(1, 1, 1), v(1, 1, 0)],
      [v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)],
      [v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)],
      [v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), v(1, 0, 0)],
    ];
    return {
      verts,
      tris: quads.flatMap((q) => [
        [q[0], q[1], q[2]],
        [q[0], q[2], q[3]],
      ]),
    };
  }

  /**
   * A dish: annular front face at `zFront` with a bore of radius `ri`, a solid back wall at
   * `zBack`, and the rim between them. This is the chair wheel in miniature — the surface under
   * the bore has nothing within 25mm of it along its own normal, and is still hidden.
   */
  function dishCover(
    cx: number,
    cy: number,
    ri: number,
    ro: number,
    zFront: number,
    zBack: number,
  ): Cover {
    const N = 64;
    const verts: number[][] = [];
    const ring = (r: number, z: number): number => {
      const base = verts.length;
      for (let i = 0; i < N; i++)
        verts.push([
          cx + r * Math.cos((2 * Math.PI * i) / N),
          cy + r * Math.sin((2 * Math.PI * i) / N),
          z,
        ]);
      return base;
    };
    const inF = ring(ri, zFront);
    const outF = ring(ro, zFront);
    const outB = ring(ro, zBack);
    const inB = ring(ri, zBack);
    const hub = verts.length;
    verts.push([cx, cy, zBack]);
    const tris: number[][] = [];
    const band = (a: number, b: number): void => {
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        tris.push([a + i, b + i, b + j], [a + i, b + j, a + j]);
      }
    };
    band(inF, outF); // front annulus
    band(outF, outB); // rim
    band(outB, inB); // back wall, outer part
    for (let i = 0; i < N; i++) tris.push([inB + i, hub, inB + ((i + 1) % N)]);
    return { verts, tris };
  }

  const COVER_CFG = { file: '-', referenceColor: '#FFFFFF', bleedMm: 10 };
  const ZONE = { id: 'face', name: 'Face', seedNormal: [0, 0, 1], maxAngleDeg: 20, up: [0, 1, 0] };
  /** 200x200 plate as two triangles: the chair's CAD faces arrive this coarse. */
  const coarsePlate: Part = {
    libraryPartId: 'coarse',
    verts: [
      [0, 0, 0],
      [200, 0, 0],
      [200, 200, 0],
      [0, 200, 0],
    ],
    tris: [
      [0, 1, 2],
      [0, 2, 3],
    ],
  };
  const finePlate = platePart('fine', 20, () => false);

  const bake = (
    part: Part,
    covers: Cover[],
    coverCfg: object = COVER_CFG,
  ): ReturnType<typeof bakeZones> =>
    bakeZones(config([part], [ZONE], { covers: coverCfg }), [part], () => {}, { covers, wasm });
  const deadOf = (
    baked: ReturnType<typeof bakeZones>,
  ): { outer: number[][]; holes: number[][][] }[] =>
    baked.sidecar.zones[0].charts[0].deadRegions ?? [];
  const deadArea = (baked: ReturnType<typeof bakeZones>): number =>
    deadOf(baked).reduce((s, r) => s + regionNetArea(r), 0);

  it('a flush box on a finely meshed plate leaves one clean patch, inset by the bleed', () => {
    const baked = bake(finePlate, [boxCover([50, 50, 1], [150, 150, 31])]);
    const dead = deadOf(baked);
    expect(dead).toHaveLength(1);
    expect(dead[0].holes).toHaveLength(0);
    // Exactly 80x80, with square corners. Smoothing runs before the bleed, so the covered 100x100
    // comes out of the close-then-open with DEAD_SMOOTH_MM fillets at its corners and the visible
    // set comes out with the matching fillets inside its hole — and dilating that by a bleed wider
    // than the fillet radius (10 against 5) erodes them away again. Under the old bleed-then-smooth
    // order the fillets survived onto the result and cost 4 * (r² - πr²/4) of it.
    expect(deadArea(baked)).toBeCloseTo(80 * 80, 2);
  });

  it('drops a dead island the bleed margin would swallow, and keeps the real patch', () => {
    // Two covers: a 100x100 that survives the bleed with 80x80 to spare, and a 37x37 whose 17x17
    // remnant is wide enough to survive the open but under the bleed's own footprint (a disc of
    // bleedMm, 314mm²), so it carries no signal worth hatching.
    const baked = bake(finePlate, [
      boxCover([10, 10, 1], [110, 110, 31]),
      boxCover([150, 150, 1], [187, 187, 31]),
    ]);
    const dead = deadOf(baked);
    expect(dead).toHaveLength(1);
    expect(deadArea(baked)).toBeGreaterThan(6000);
  });

  it('the same box on a two-triangle plate hides the same 80x80, not the whole plate', () => {
    // Classifying whole triangles cannot answer this: both triangle centroids are under the box,
    // so a per-triangle verdict has only "all 40,000mm²" and "nothing" to choose between.
    const baked = bake(coarsePlate, [boxCover([50, 50, 1], [150, 150, 31])]);
    const dead = deadOf(baked);
    expect(dead).toHaveLength(1);
    expect(deadArea(baked)).toBeCloseTo(80 * 80, -2);
  });

  it('a dished cover hides the surface under its bore, which no ray along the normal reaches', () => {
    // Bore radius 30 at 5mm, back wall at 45mm: straight out, the plate centre sees nothing until
    // 45mm. It is still hidden — the rim and back wall close off every other direction.
    const baked = bake(finePlate, [dishCover(100, 100, 30, 60, 5, 45)]);
    const dead = deadOf(baked);
    expect(dead).toHaveLength(1);
    expect(dead[0].holes).toHaveLength(0);
    // Bounded, not pinned: the bore's own 30mm radius has to be inside the patch, and the rim's
    // 60mm shadow inset by the 10mm bleed bounds it from above. Where the edge falls between the
    // two is how far under the rim you can still see, which is the thing being measured.
    expect(deadArea(baked)).toBeGreaterThan(Math.PI * 30 * 30);
    expect(deadArea(baked)).toBeLessThan(Math.PI * 50 * 50);
  });

  const span = (c: Cover, k: number): number[] => [
    Math.min(...c.verts.map((v) => v[k])),
    Math.max(...c.verts.map((v) => v[k])),
  ];

  it('snaps an off-mirror cover pair onto mirrored poses', () => {
    // Two boxes that should be each other's mirror image and are not: one sits 20..80 from the
    // plane, the other 21..81, and the second is 1mm along y as well. The chair's casters are out
    // by the same order (1.187mm).
    const a = boxCover([-80, 70, 1], [-20, 130, 31]);
    const b = boxCover([21, 71, 1], [81, 131, 31]);
    symmetrizeCovers([a, b], 0);
    // both now stand the averaged distance from the plane, 20.5..80.5
    expect(span(a, 0)).toEqual([-80.5, -20.5]);
    expect(span(b, 0)).toEqual([20.5, 80.5]);
    // and along the axes it does not mirror, both land on the average
    expect(span(a, 1)).toEqual(span(b, 1));
    expect(span(a, 1)).toEqual([70.5, 130.5]);
  });

  it('poses a rotated pair without replacing either mesh with the other’s mirror', () => {
    // The chair's casters: the same body, mounted rotated 180 degrees about the vertical, so its
    // two instances are NOT mirror images (owner, 2026-08-31). A box could not tell the two
    // behaviours apart, being its own mirror, so two corners are chamfered 10mm along x — inward
    // on a diagonal pair, which leaves the bounding box (and so the pairing test) untouched.
    const chamfered = (): Cover => {
      const c = boxCover([-30, -30, 0], [30, 30, 20]);
      c.verts = c.verts.map((v) =>
        (v[0] === 30 && v[1] === 30 && v[2] === 20) || (v[0] === -30 && v[1] === -30 && v[2] === 0)
          ? [v[0] - Math.sign(v[0]) * 10, v[1], v[2]]
          : v,
      );
      return c;
    };
    const a = chamfered();
    const b = chamfered();
    // b is a turned 180 degrees about the vertical: a rotation, so its winding still reads out.
    b.verts = b.verts.map((v) => [-v[0], -v[1], v[2]]);
    // Placed as a pair straddling the plane, each 100mm out.
    a.verts = a.verts.map((v) => [v[0] - 100, v[1], v[2]]);
    b.verts = b.verts.map((v) => [v[0] + 100, v[1], v[2]]);
    const shapeOf = (c: Cover): string[] => {
      const mid = [0, 1, 2].map((k) => (span(c, k)[0] + span(c, k)[1]) / 2);
      return c.verts.map((v) => v.map((x, k) => (x - mid[k]).toFixed(6)).join()).sort();
    };
    const beforeA = shapeOf(a);
    const beforeB = shapeOf(b);
    const out = symmetrizeCovers([a, b], 0);
    expect(out.pairs).toBe(1);
    // Posed: mirrored midpoints along the axis, equal on the others.
    expect(span(a, 0)).toEqual([-130, -70]);
    expect(span(b, 0)).toEqual([70, 130]);
    // Each mesh is still its own shape, and the two are not each other's reflection. Before this,
    // b came back rebuilt from a and its chamfers swapped corners — the same replacement that
    // moved the chair's casters by 21.976mm.
    expect(shapeOf(a)).toEqual(beforeA);
    expect(shapeOf(b)).toEqual(beforeB);
    expect(shapeOf(a)).not.toEqual(shapeOf(b));
    // Reported rather than hidden: 10mm, one chamfer's full travel.
    expect(out.maxResidualMm).toBeCloseTo(10, 6);
  });

  it('a cover beside the plate hides nothing', () => {
    const baked = bake(finePlate, [boxCover([260, 50, 1], [360, 150, 31])]);
    expect(deadOf(baked)).toHaveLength(0);
  });

  describe('which parts a cover hides on', () => {
    /** 100x200 plate on 10mm cells, its left edge at `x0`; two of them meet along x=100. */
    const plateAt = (libraryPartId: string, x0: number): Part => {
      const verts: number[][] = [];
      for (let i = 0; i <= 10; i++)
        for (let j = 0; j <= 20; j++) verts.push([x0 + i * 10, j * 10, 0]);
      const idx = (i: number, j: number): number => i * 21 + j;
      const tris: number[][] = [];
      for (let i = 0; i < 10; i++)
        for (let j = 0; j < 20; j++)
          tris.push(
            [idx(i, j), idx(i + 1, j), idx(i + 1, j + 1)],
            [idx(i, j), idx(i + 1, j + 1), idx(i, j + 1)],
          );
      return { libraryPartId, verts, tris };
    };
    const left = plateAt('left', 0);
    const right = plateAt('right', 100);

    const bake2 = (
      covers: Cover[],
    ): { left: number; right: number; box: Record<string, number[]> } => {
      const baked = bakeZones(
        config([left, right], [ZONE], { covers: COVER_CFG }),
        [left, right],
        () => {},
        { covers, wasm },
      );
      const out: { left: number; right: number; box: Record<string, number[]> } = {
        left: 0,
        right: 0,
        box: {},
      };
      for (const c of baked.sidecar.zones[0].charts as {
        libraryPartId: 'left' | 'right';
        deadRegions?: { outer: number[][]; holes: number[][][] }[];
      }[]) {
        const dead = c.deadRegions ?? [];
        out[c.libraryPartId] = dead.reduce((s, r) => s + regionNetArea(r), 0);
        const pts = dead.flatMap((r) => r.outer);
        if (pts.length)
          out.box[c.libraryPartId] = [
            Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0])),
            Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1])),
          ];
      }
      return out;
    };

    // 120x120, three quarters of it over the left plate. Flush against both (0.5mm, inside
    // COVER_CONTACT_MM) in one case and standing 4mm clear of both in the other; nothing else
    // about the two differs.
    const RESTING: [number[], number[]] = [
      [20, 40, 0.5],
      [140, 160, 30],
    ];
    const MOUNTED: [number[], number[]] = [
      [20, 40, 4],
      [134, 160, 34],
    ];

    it('a cover resting on both parts hides surface on both', () => {
      const { left: l, right: r } = bake2([boxCover(...RESTING)]);
      // 120x120 hidden, inset by the 10mm bleed, split 70/30 by the seam at x=100
      expect(l).toBeGreaterThan(6800);
      expect(l).toBeLessThan(7100);
      expect(r).toBeGreaterThan(2800);
      expect(r).toBeLessThan(3100);
    });

    it('a cover resting on nothing hides on every part it occludes', () => {
      const { left: l, right: r, box } = bake2([boxCover(...MOUNTED)]);
      // Nothing carries it, so nothing narrows it: the shadow falls where the hemisphere test puts
      // it, and it crosses the seam. The rule this replaces handed a standing cover to the ONE part
      // holding the larger share of its nearest surface, and `r` came back exactly 0 — which is how
      // the chair's wheel shadow came to stop dead along a straight line down the mount/fender seam
      // while the wheel plainly hides across it.
      expect(r).toBeGreaterThan(1500);
      // 4mm of standoff lets the edges of the shadow see out sideways, so the patch comes in
      // under the flush cover's 7,000mm² above
      expect(l).toBeGreaterThan(5500);
      expect(l).toBeLessThan(7000);
      // and it runs to the seam, not 10mm short of it: the surface it hides on the right plate is
      // hidden, so it must not dilate back across the seam the way visible surface would. The
      // patch starts at x=35 and the seam is at 100, so reaching it is 65mm wide against 55.
      expect(box.left[0]).toBeGreaterThan(60);
      expect(box.left[1]).toBeGreaterThan(85);
    });

    it('mirroring a standing cover mirrors its shadow', () => {
      // The two plates are one mesh translated, so the mirrored cover has to give the un-mirrored
      // answer with the parts swapped. Under the argmax rule this pair read (l > 0, r = 0) and then
      // (l = 0, r > 0): each side of one fixture losing a whole plate to a tie-break.
      const mirror = (v: number[]): number[] => [200 - v[0], v[1], v[2]];
      const a = bake2([boxCover(...MOUNTED)]);
      const b = bake2([boxCover(mirror(MOUNTED[1]), mirror(MOUNTED[0]))]);
      expect(b.right).toBeCloseTo(a.left, 0);
      expect(b.left).toBeCloseTo(a.right, 0);
    });
  });
});
