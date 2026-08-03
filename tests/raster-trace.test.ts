import { describe, expect, it } from 'vitest';
import { traceLabelMap } from '../src/raster/trace';
import type { TracedComponent } from '../src/raster/trace';
import { BACKGROUND } from '../src/raster/types';
import type { LabelMap, TraceParams } from '../src/raster/types';
import { planarArea, safeIntersect, shapeToFeature } from '../src/geometry/regions';
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
  simplifyTol: 0.6,
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

describe('traceLabelMap', () => {
  it('traces a solid block to one ring of four corners', () => {
    const { components } = traceLabelMap(
      grid(['......', '.aaaa.', '.aaaa.', '.aaaa.', '......'], 'a'),
      params(),
    );
    expect(components).toHaveLength(1);
    expect(components[0].loops).toHaveLength(1);
    expect(components[0].loops[0]).toHaveLength(4);
    expect(areaOf(components[0])).toBeCloseTo(12, 9);
  });

  it('emits a hole as a second ring the pipeline resolves by containment depth', () => {
    const { components } = traceLabelMap(
      grid(['aaaaa', 'aaaaa', 'aa.aa', 'aaaaa', 'aaaaa'], 'a'),
      params(),
    );
    expect(components).toHaveLength(1);
    expect(components[0].loops).toHaveLength(2);
    // 25 pixels minus the 1-pixel hole — proof the inner ring came back as a hole, not an island.
    expect(areaOf(components[0])).toBeCloseTo(24, 9);
  });

  it('treats an island inside a hole as its own component', () => {
    const { components } = traceLabelMap(
      grid(['aaaaaaa', 'aaaaaaa', 'aa...aa', 'aa.a.aa', 'aa...aa', 'aaaaaaa', 'aaaaaaa'], 'a'),
      params(),
    );
    expect(components).toHaveLength(2);
    const areas = components.map(areaOf).sort((x, y) => y - x);
    expect(areas[0]).toBeCloseTo(40, 9); // 49 minus the 3x3 hole
    expect(areas[1]).toBeCloseTo(1, 9); // the island
  });

  it('leaves adjacent regions sharing an edge exactly — no gaps, no overlaps', () => {
    // A deliberately jagged divider, so simplification has something to move.
    const map = grid(['aaabbb', 'aabbbb', 'aaabbb', 'aaaabb', 'aaabbb', 'aabbbb'], 'ab');
    const { components } = traceLabelMap(map, params());
    expect(components).toHaveLength(2);
    expect(components.reduce((s, c) => s + areaOf(c), 0)).toBeCloseTo(36, 9);
    expect(
      safeIntersect(featureOf(components[0].loops), featureOf(components[1].loops)),
    ).toBeNull();
  });

  it('still shares that edge after simplification pulls it straight', () => {
    // 16 wide so the tolerance below only ever reaches the divider — RDP would legitimately clip
    // the frame's own corners on a grid small enough for them to sit within tolerance of a chord,
    // and that would mask the invariant under test rather than exercise it.
    const size = 16;
    const rows = Array.from({ length: size }, (_, y) => {
      const split = 8 + ((y % 3) - 1);
      return 'a'.repeat(split) + 'b'.repeat(size - split);
    });
    const { components } = traceLabelMap(grid(rows, 'ab'), params({ simplifyTol: 2 }));
    expect(components).toHaveLength(2);
    // The divider has moved — but the two regions still tile the frame exactly, which is only true
    // if both sides kept the identical simplified polyline.
    expect(components.reduce((s, c) => s + areaOf(c), 0)).toBeCloseTo(size * size, 9);
    expect(
      safeIntersect(featureOf(components[0].loops), featureOf(components[1].loops)),
    ).toBeNull();
  });

  it('absorbs a sub-threshold speck into its surroundings without losing area', () => {
    const rows = ['aaaaaa', 'aaaaaa', 'aabaaa', 'aaaaaa', 'aaaaaa', 'aaaaaa'];
    const loose = traceLabelMap(grid(rows, 'ab'), params());
    expect(loose.components).toHaveLength(2);

    // 2/36 of the frame is well above the single speck pixel.
    const cleaned = traceLabelMap(grid(rows, 'ab'), params({ despeckleFrac: 2 / 36 }));
    expect(cleaned.components).toHaveLength(1);
    expect(areaOf(cleaned.components[0])).toBeCloseTo(36, 9);
  });

  it('resolves a checkerboard without emitting a self-touching ring', () => {
    const { components } = traceLabelMap(grid(['abab', 'baba', 'abab', 'baba'], 'ab'), params());
    expect(components.length).toBeGreaterThan(0);
    for (const c of components)
      for (const loop of c.loops) {
        const seen = new Set(loop.map((p) => `${p.x},${p.y}`));
        expect(seen.size).toBe(loop.length);
      }
    expect(components.reduce((s, c) => s + areaOf(c), 0)).toBeCloseTo(16, 9);
  });

  it('ignores background — a transparent margin cuts nothing', () => {
    const { components } = traceLabelMap(grid(['....', '.aa.', '.aa.', '....'], 'a'), params());
    expect(components).toHaveLength(1);
    expect(components[0].label).toBe(0);
    expect(areaOf(components[0])).toBeCloseTo(4, 9);
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
