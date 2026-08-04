import { describe, expect, it } from 'vitest';
import { traceLabelMap } from '../src/raster/trace';
import type { TracedComponent } from '../src/raster/trace';
import { BACKGROUND } from '../src/raster/types';
import type { LabelMap, TraceParams } from '../src/raster/types';
import { planarArea, safeIntersect, safeUnion, shapeToFeature } from '../src/geometry/regions';
import type { Loop, SVGShape } from '../src/types';

/**
 * Build a label grid from ASCII rows — '.' is transparent background, any other character is a
 * label whose index is its position in `keys`. Hand-built fixtures, same convention as
 * tests/regions.test.ts.
 */
function grid(rows: string[], keys: string): LabelMap {
  const h = rows.length;
  const w = rows[0].length;
  const labels = new Int16Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x];
      labels[y * w + x] = ch === '.' ? BACKGROUND : keys.indexOf(ch);
    }
  return {
    labels,
    w,
    h,
    palette: keys.split('').map((_, i) => '#' + i.toString(16).repeat(6)),
  };
}

const params = (over: Partial<TraceParams> = {}): TraceParams => ({
  blurRadius: 0,
  despeckleFrac: 0,
  alphaMax: 1,
  flatness: 0.25,
  ...over,
});

/** Area of one traced component, via the same containment-depth resolution the pipeline uses. */
function areaOf(c: TracedComponent): number {
  const shape: SVGShape = { fill: '#000000', loops: c.loops, order: 0 };
  return planarArea(shapeToFeature(shape));
}

function featureOf(loops: Loop[]) {
  return shapeToFeature({ fill: '#000000', loops, order: 0 });
}

/**
 * A rectangle of `label` inset by `margin` in a square grid, as ASCII rows.
 *
 * Sizes here are deliberately generous. The curve fit only keeps a corner sharp once it is big
 * enough to read as one — for a square that is a side of about nine pixels, since Potrace's corner
 * measure works out to side/2 and has to clear 4 at the default alphaMax. Below that the corner
 * rounds and the area drops a few percent, so a four-pixel fixture can no longer carry an exact
 * area assertion. That rounding is the intended behaviour (sub-nozzle detail), not a defect, but it
 * means these fixtures have to be sized like real artwork rather than like the smallest case that
 * used to work.
 */
function block(size: number, inner: number, label = 'a'): string[] {
  const margin = Math.floor((size - inner) / 2);
  return Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) =>
      x >= margin && x < margin + inner && y >= margin && y < margin + inner ? label : '.',
    ).join(''),
  );
}

describe('traceLabelMap', () => {
  it('traces a solid block to one ring of four corners', () => {
    const { components } = traceLabelMap(grid(block(24, 20), 'a'), params());
    expect(components).toHaveLength(1);
    expect(components[0].loops).toHaveLength(1);
    expect(components[0].loops[0]).toHaveLength(4);
    expect(areaOf(components[0])).toBeCloseTo(400, 9);
  });

  it('emits a hole as a second ring the pipeline resolves by containment depth', () => {
    const rows = block(28, 24).map((row, y) =>
      y >= 8 && y < 20 ? row.slice(0, 8) + '.'.repeat(12) + row.slice(20) : row,
    );
    const { components } = traceLabelMap(grid(rows, 'a'), params());
    expect(components).toHaveLength(1);
    expect(components[0].loops).toHaveLength(2);
    // 24x24 minus the 12x12 hole — proof the inner ring came back as a hole, not an island.
    expect(areaOf(components[0])).toBeCloseTo(576 - 144, 9);
  });

  it('treats an island inside a hole as its own component', () => {
    const rows = block(36, 32).map((row, y) => {
      if (y < 10 || y >= 26) return row;
      const island = y >= 14 && y < 22 ? 'a'.repeat(8) : '.'.repeat(8);
      return row.slice(0, 10) + '.'.repeat(4) + island + '.'.repeat(4) + row.slice(26);
    });
    const { components } = traceLabelMap(grid(rows, 'a'), params());
    expect(components).toHaveLength(2);
    const areas = components.map(areaOf).sort((x, y) => y - x);
    expect(areas[0]).toBeCloseTo(32 * 32 - 16 * 16, 9); // the ring, minus its hole
    // The island is 8px across — under the size where corners survive, so it rounds slightly.
    expect(areas[1]).toBeGreaterThan(8 * 8 * 0.9);
    expect(areas[1]).toBeLessThanOrEqual(8 * 8);
  });

  it('leaves adjacent regions sharing an edge exactly — no gaps, no overlaps', () => {
    // A deliberately jagged divider, so the fit has something to move.
    const map = grid(['aaabbb', 'aabbbb', 'aaabbb', 'aaaabb', 'aaabbb', 'aabbbb'], 'ab');
    const { components } = traceLabelMap(map, params());
    expect(components).toHaveLength(2);

    const a = featureOf(components[0].loops);
    const b = featureOf(components[1].loops);
    // The two halves of the invariant, stated directly rather than inferred from a frame total:
    // nothing is covered twice, and nothing between them is left uncovered. A frame-area assertion
    // can't say this any more — the frame's own outer corners round like any other small feature,
    // so the union is legitimately smaller than the pixel count while the shared edge is still exact.
    expect(safeIntersect(a, b)).toBeNull();
    const union = safeUnion(a, b);
    expect(planarArea(union)).toBeCloseTo(planarArea(a) + planarArea(b), 9);
  });

  it('still shares that edge after the curve fit pulls it off the lattice', () => {
    // A zig-zag divider, which is exactly what the fit smooths hardest: every vertex on it moves to
    // a sub-pixel position, so the two sides agree only if they are splicing the same fitted chain
    // rather than each fitting their own copy.
    const size = 16;
    const rows = Array.from({ length: size }, (_, y) => {
      const split = 8 + ((y % 3) - 1);
      return 'a'.repeat(split) + 'b'.repeat(size - split);
    });
    const { components } = traceLabelMap(grid(rows, 'ab'), params());
    expect(components).toHaveLength(2);
    // At 16 wide the frame's own corners are large enough to survive the fit, so this one can still
    // assert the strong form: the divider has moved off the lattice, yet the two regions together
    // account for every pixel of the frame — only true if both sides spliced the identical chain.
    expect(components.reduce((s, c) => s + areaOf(c), 0)).toBeCloseTo(size * size, 9);
    expect(
      safeIntersect(featureOf(components[0].loops), featureOf(components[1].loops)),
    ).toBeNull();
  });

  it('absorbs a sub-threshold speck into its surroundings without losing area', () => {
    const size = 16;
    const rows = Array.from({ length: size }, (_, y) =>
      y === 7 ? 'a'.repeat(7) + 'b' + 'a'.repeat(size - 8) : 'a'.repeat(size),
    );
    const loose = traceLabelMap(grid(rows, 'ab'), params());
    expect(loose.components).toHaveLength(2);

    // Well above the single speck pixel, so the floor swallows it and the frame comes back whole.
    const cleaned = traceLabelMap(grid(rows, 'ab'), params({ despeckleFrac: 2 / (size * size) }));
    expect(cleaned.components).toHaveLength(1);
    expect(areaOf(cleaned.components[0])).toBeCloseTo(size * size, 9);
  });

  it('resolves a checkerboard without emitting a self-touching ring', () => {
    const { components } = traceLabelMap(grid(['abab', 'baba', 'abab', 'baba'], 'ab'), params());
    expect(components.length).toBeGreaterThan(0);
    for (const c of components)
      for (const loop of c.loops) {
        const seen = new Set(loop.map((p) => `${p.x},${p.y}`));
        expect(seen.size).toBe(loop.length);
      }
    // Every cell here is one pixel, far below the size at which a corner survives the fit, so the
    // total comes up about a third short of 16. curve.ts's area guard can't rescue these: it works
    // per chain, and these cells are bounded by junctions rather than by closed chains. Making it
    // work per *ring* is not available — one region falling back to the lattice while the region
    // across the boundary kept the fit is exactly the sliver the shared-chain design exists to
    // prevent. Recorded in docs/tech-debt.md; what still has to hold here is that nothing overlaps.
    const feats = components.map((c) => featureOf(c.loops));
    for (let i = 0; i < feats.length; i++)
      for (let j = i + 1; j < feats.length; j++)
        expect(safeIntersect(feats[i], feats[j])).toBeNull();
    expect(components.reduce((s, c) => s + areaOf(c), 0)).toBeGreaterThan(16 * 0.65);
  });

  it('ignores background — a transparent margin cuts nothing', () => {
    const { components } = traceLabelMap(grid(block(24, 16), 'a'), params());
    expect(components).toHaveLength(1);
    expect(components[0].label).toBe(0);
    expect(areaOf(components[0])).toBeCloseTo(256, 9);
  });

  it('orders components largest first', () => {
    const { components } = traceLabelMap(
      grid(['aaaaaa', 'aaaaaa', 'aaaaaa', 'bbbb..', 'bbbb..', 'c.....'], 'abc'),
      params(),
    );
    const areas = components.map((c) => c.area);
    expect(areas).toEqual([...areas].sort((a, b) => b - a));
  });
});
