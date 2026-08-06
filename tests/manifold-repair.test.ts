import { beforeAll, describe, expect, it } from 'vitest';
import { getManifold, repairSelfIntersections, type ManifoldAPI } from '../src/geometry/manifold';
import type { PolyFeature } from '../src/types';

/** Local, like the module-local alias in manifold.ts — a ring is a list of [x, y]. */
type Ring = number[][];

let wasm: ManifoldAPI;
beforeAll(async () => {
  wasm = await getManifold();
});

const polygon = (rings: Ring[]): PolyFeature =>
  ({
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: rings },
  }) as PolyFeature;

const multiPolygon = (polys: Ring[][]): PolyFeature =>
  ({
    type: 'Feature',
    properties: {},
    geometry: { type: 'MultiPolygon', coordinates: polys },
  }) as PolyFeature;

/** Every ring of the result, whether it came back as a Polygon or a MultiPolygon. */
function ringsOf(f: PolyFeature): Ring[] {
  const g = f.geometry;
  return g.type === 'Polygon' ? (g.coordinates as Ring[]) : (g.coordinates as Ring[][]).flat();
}

function area(ring: Ring): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(a) / 2;
}

const totalArea = (f: PolyFeature): number => ringsOf(f).reduce((s, r) => s + area(r), 0);

const cross = (o: number[], a: number[], b: number[]): number =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Proper (crossing) intersection of two open segments — the topology earcut chokes on. */
function segmentsCross(p1: number[], p2: number[], p3: number[], p4: number[]): boolean {
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
}

/** Does this closed ring cross itself? Adjacent segments share an endpoint and are skipped. */
function selfIntersects(ring: Ring): boolean {
  const n = ring.length - 1; // last point repeats the first
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // first and last segments are adjacent too
      if (segmentsCross(ring[i], ring[i + 1], ring[j], ring[j + 1])) return true;
    }
  }
  return false;
}

const closed = (ring: Ring): boolean =>
  ring.length > 3 &&
  ring[0][0] === ring[ring.length - 1][0] &&
  ring[0][1] === ring[ring.length - 1][1];

/** A bowtie: the classic self-crossing ring turf's clipper can emit without throwing. */
const BOWTIE: Ring = [
  [0, 0],
  [10, 10],
  [10, 0],
  [0, 10],
  [0, 0],
];

/** Counter-clockwise — GeoJSON winding for an outer ring. */
const square = (x: number, y: number, s: number): Ring => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
  [x, y],
];

/** Clockwise — GeoJSON winding for a hole, which is what turf's clipper emits. */
const holeSquare = (x: number, y: number, s: number): Ring =>
  [...square(x, y, s)].reverse() as Ring;

/** Shoelace with its sign kept: negative means the ring is wound the other way. */
function signedArea(ring: Ring): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return a / 2;
}

describe('repairSelfIntersections', () => {
  it('the input really is self-crossing — otherwise this whole suite proves nothing', () => {
    expect(selfIntersects(BOWTIE)).toBe(true);
  });

  it('resolves a bowtie into two disjoint, non-crossing lobes', () => {
    const out = repairSelfIntersections(wasm, polygon([BOWTIE]));

    expect(out).not.toBeNull();
    const rings = ringsOf(out!);
    expect(rings).toHaveLength(2);
    for (const r of rings) {
      expect(selfIntersects(r), JSON.stringify(r)).toBe(false);
      expect(closed(r)).toBe(true);
    }
  });

  it('keeps both lobes’ area, less only the sub-print-resolution erosion', () => {
    const out = repairSelfIntersections(wasm, polygon([BOWTIE]))!;

    // each lobe of this bowtie is a triangle of area 25
    for (const r of ringsOf(out)) {
      expect(area(r)).toBeGreaterThan(24.5);
      expect(area(r)).toBeLessThan(25);
    }
    expect(totalArea(out)).toBeGreaterThan(49);
    expect(totalArea(out)).toBeLessThan(50);
  });

  it('separates two shapes that touch at exactly one point', () => {
    // the pinched topology the doc comment calls out: THREE's earcut chokes on exact touching
    const touching = multiPolygon([[square(0, 0, 10)], [square(10, 10, 10)]]);

    const out = repairSelfIntersections(wasm, touching)!;

    const rings = ringsOf(out);
    expect(rings).toHaveLength(2);
    // no vertex of one ring coincides exactly with a vertex of the other any more
    for (const a of rings[0]) {
      for (const b of rings[1]) {
        expect(a[0] === b[0] && a[1] === b[1]).toBe(false);
      }
    }
    for (const r of rings) expect(area(r)).toBeGreaterThan(99);
  });

  it('accepts a MultiPolygon as readily as a Polygon', () => {
    const out = repairSelfIntersections(wasm, multiPolygon([[BOWTIE]]));

    expect(out).not.toBeNull();
    expect(ringsOf(out!)).toHaveLength(2);
  });

  it('preserves a hole, re-nested with the opposite winding', () => {
    const withHole = polygon([square(0, 0, 20), holeSquare(5, 5, 10)]);

    const out = repairSelfIntersections(wasm, withHole)!;

    const rings = ringsOf(out);
    expect(rings).toHaveLength(2);
    const signed = rings.map(signedArea).sort((a, b) => b - a);
    expect(signed[0]).toBeGreaterThan(390); // outer 20×20, less the erosion
    expect(signed[1]).toBeLessThan(0); // the hole comes back wound the other way
    expect(Math.abs(signed[1])).toBeGreaterThan(99); // 10×10, grown slightly by the same erosion
    expect(Math.abs(signed[1])).toBeLessThan(105);
  });

  it('needs GeoJSON winding to tell a hole from a second shape — NonZero fills a same-wound one', () => {
    // Not a defect: turf's clipper emits RFC7946 winding (holes reversed), which is the case
    // above. Pinned because the fill rule, not the ring order, is what distinguishes them — a
    // caller that hands over two same-wound rings gets a union, silently.
    const sameWinding = polygon([square(0, 0, 20), square(5, 5, 10)]);

    const out = repairSelfIntersections(wasm, sameWinding)!;

    expect(ringsOf(out)).toHaveLength(1);
    expect(signedArea(ringsOf(out)[0])).toBeGreaterThan(390);
  });
});

describe('repairSelfIntersections gives up rather than returning junk', () => {
  it('returns null when no ring has enough points to be a polygon', () => {
    expect(
      repairSelfIntersections(
        wasm,
        polygon([
          [
            [0, 0],
            [1, 1],
            [0, 0],
          ] as Ring,
        ]),
      ),
    ).toBeNull();
  });

  it('returns null for a feature with no rings at all', () => {
    expect(repairSelfIntersections(wasm, polygon([]))).toBeNull();
  });

  it('returns null when the shape is thinner than the erosion and vanishes entirely', () => {
    // 0.005mm tall against a 0.01mm inward offset — the caller must handle null, not a empty ring
    const sliver = polygon([
      [
        [0, 0],
        [10, 0],
        [10, 0.005],
        [0, 0.005],
        [0, 0],
      ],
    ]);

    expect(repairSelfIntersections(wasm, sliver)).toBeNull();
  });
});
