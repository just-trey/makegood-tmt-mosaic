import { describe, expect, it } from 'vitest';
import { traceLabelMap } from '../src/raster/trace';
import { printableFloorPx } from '../src/raster/stats';
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

  it('leaves nothing under the floor when the specks are nested inside each other', () => {
    // Three specks nested one inside the next, each under the floor, and only the outermost
    // touches the surrounding field. Relabelling every speck at once used to let the inner two
    // trade labels while the outer one left, so the pile came back as a smaller pile still under
    // the floor. They now merge into one another instead, and the 49px they add up to clears it.
    const size = 13;
    const rows = Array.from({ length: size }, (_, y) =>
      Array.from({ length: size }, (_, x) => {
        const d = Math.max(Math.abs(x - 6), Math.abs(y - 6));
        return d <= 1 ? 'd' : d <= 2 ? 'b' : d <= 3 ? 'a' : 'c';
      }).join(''),
    );
    // 30 clears the largest speck on its own (the outer ring, 24px) and stays under the 120px
    // field, so every speck here is one and the field is not.
    const floor = 30;
    const { components } = traceLabelMap(
      grid(rows, 'abcd'),
      params({ despeckleFrac: floor / (size * size) }),
    );
    for (const c of components) expect(c.area).toBeGreaterThanOrEqual(floor);
    expect(components.reduce((s, c) => s + areaOf(c), 0)).toBeCloseTo(size * size, 9);
  });

  it('removes a speck the fractional floor keeps but the placed size cannot print', () => {
    const size = 16;
    const rows = Array.from({ length: size }, (_, y) =>
      y === 7 ? 'a'.repeat(6) + 'bb' + 'a'.repeat(size - 8) : 'a'.repeat(size),
    );
    // No fractional floor at all, so the speck's only threat is the printable one.
    const loose = traceLabelMap(grid(rows, 'ab'), params());
    expect(loose.components).toHaveLength(2);

    // 0.5mm per pixel puts one nozzle width under a pixel, so nothing is unprintable.
    expect(
      traceLabelMap(grid(rows, 'ab'), params(), printableFloorPx(0.5)).components,
    ).toHaveLength(2);

    // 0.1mm per pixel makes a nozzle 4 pixels across, 16 square, and the 2px speck cannot print.
    const printed = traceLabelMap(grid(rows, 'ab'), params(), printableFloorPx(0.1));
    expect(printed.components).toHaveLength(1);
    expect(areaOf(printed.components[0])).toBeCloseTo(size * size, 9);
  });

  it('absorbs a sub-width ribbon between two colors, whatever its area', () => {
    // A 1px band of 'b' the full width of the image: area 24 clears any small floor, but at under
    // 2px mean width it is quantization fringe (the anti-aliased boundary band coming back as a
    // third color) and cannot print.
    const size = 24;
    const rows = Array.from({ length: size }, (_, y) =>
      (y < 12 ? 'a' : y === 12 ? 'b' : 'c').repeat(size),
    );
    const loose = traceLabelMap(grid(rows, 'abc'), params());
    expect(loose.components).toHaveLength(3);

    const cleaned = traceLabelMap(grid(rows, 'abc'), params(), 0, 2);
    expect(cleaned.components).toHaveLength(2);
    expect(cleaned.components.map((c) => c.label)).not.toContain(1);
    expect(cleaned.components.reduce((s, c) => s + areaOf(c), 0)).toBeCloseTo(size * size, 9);
  });

  it('keeps a stroke wider than the fringe width, and never fills a background gap', () => {
    const size = 24;
    // A 4px 'b' stroke survives; the 1px transparent column between the two halves is a gap
    // between printed shapes, not an extrusion, so thinness must not fill it in.
    const rows = Array.from({ length: size }, (_, y) =>
      y >= 10 && y < 14 ? 'b'.repeat(size) : 'a'.repeat(11) + '.' + 'a'.repeat(size - 12),
    );
    const { components } = traceLabelMap(grid(rows, 'ab'), params(), 0, 2);
    expect(components.filter((c) => c.label === 1)).toHaveLength(1);
    // The stroke and the gap quarter the 'a' field; all four quadrants are wide enough to keep.
    expect(components.filter((c) => c.label === 0)).toHaveLength(4);
  });

  it('resolves a checkerboard without emitting a self-touching ring', () => {
    const { components } = traceLabelMap(grid(['abab', 'baba', 'abab', 'baba'], 'ab'), params());
    expect(components.length).toBeGreaterThan(0);
    for (const c of components)
      for (const loop of c.loops) {
        const seen = new Set(loop.map((p) => `${p.x},${p.y}`));
        expect(seen.size).toBe(loop.length);
      }
    // Every cell here is one pixel, far below the size at which a corner survives the fit — and
    // curve.ts's own area guard only covers closed chains, while these cells are bounded by
    // junctions. `unfitCollapsedChains` (trace.ts) is the one that reaches this case: it checks
    // area per *component*, not per chain, so a junction-bounded cell is caught the same as an
    // island. This exact total is the fix under test, not an incidental pass — it used to come up
    // about a third short of 16 before that guard existed.
    // What `toBeNull()` below verifies is a property of this fixture, not a general guarantee — the
    // general statement is the sliver bound asserted further down, and reading this as the tracer's
    // guarantee is what let a hole-swallowing bug sit undetected on fixtures with more nesting than
    // a 4x4 has.
    const feats = components.map((c) => featureOf(c.loops));
    for (let i = 0; i < feats.length; i++)
      for (let j = i + 1; j < feats.length; j++)
        expect(safeIntersect(feats[i], feats[j])).toBeNull();
    expect(components.reduce((s, c) => s + areaOf(c), 0)).toBeCloseTo(16, 9);
  });

  /**
   * Deterministic pseudo-random label field.
   *
   * Noise is the adversarial fixture for tracing and nothing like real quantized art: it maximises
   * junctions, one-pixel features and deep ring nesting all at once. That is exactly why the two
   * assertions below are stated as bounds rather than as exact tiling — see the notes on each.
   */
  function noise(seed: number, size: number, labels: number): LabelMap {
    let s = (seed * 2654435761) >>> 0 || 1;
    const next = () => {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5;
      s >>>= 0;
      return s / 4294967296;
    };
    const arr = new Int16Array(size * size);
    for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(next() * labels);
    return {
      labels: arr,
      w: size,
      h: size,
      palette: Array.from({ length: labels }, (_, i) => '#' + i.toString(16).repeat(6)),
    };
  }

  /** [seed, label count]. The first entry is the fixture the containment defect was found on. */
  const SEEDS: [number, number][] = [
    [1054097, 2],
    [1054098, 3],
    [205920, 2],
    [348131, 3],
    [665196, 2],
    [823473, 4],
  ];

  /**
   * The strong "no overlap at all" form the two fixtures above assert is a property of *those*
   * fixtures, not of the tracer. Two things break it in general, both understood and both bounded:
   * a fitted chain may stray up to about a pixel from the lattice path it replaces (Potrace's
   * straightness cone carries that slack by design), and a thin feature bounded by junctions can
   * lose its ring entirely so a neighbour covers the gap (the second is closed by
   * unfitCollapsedChains). So what has to hold generally is that any overlap stays *sliver*-sized:
   * one working pixel, which at the 1024px flat-art size is 0.27mm across the wheel, well under a
   * 0.4mm nozzle.
   *
   * The first is not closable from this angle, and the obvious fix was measured and rejected: a
   * bound on how far a fitted chain may stray cannot be set. A 45° staircase's lattice corners sit
   * 0.707px off their own chord and a 3:1 staircase's sit 0.949px off, both legitimate, while the
   * chains that misbehave measure about 0.97. No threshold separates them. Re-measured over 3000
   * random label grids after unfitCollapsedChains landed: worst overlap still 1.000000 unit²,
   * unchanged, because that function catches area loss rather than this. Downstream it is absorbed
   * anyway (paint order in computeNetRegionsByColor subtracts cross-colour overlap outright, and
   * two components of one colour land in the same shape and get unioned), which is why this pins
   * the bound instead of asserting zero. Closing it properly means recognising digital straight
   * segments, the arithmetic characterisation, instead of Potrace's cone, which does not carry the
   * half-pixel slack. Worth doing only if it ever shows up as a visible artifact.
   *
   * The bound is what caught a real defect: a hole ring starting on a junction read as "outside"
   * its own component and was emitted as a solid island, so the component painted over its cavity
   * and swallowed a 13-pixel region of another colour whole. Fixed in shapeToFeature (regions.ts);
   * this is the assertion that would have failed.
   */
  it('keeps any overlap between components down to a sliver', () => {
    for (const [seed, labels] of SEEDS) {
      const { components } = traceLabelMap(noise(seed, 28, labels), params());
      const feats = components.map((c) => featureOf(c.loops));
      for (let i = 0; i < feats.length; i++)
        for (let j = i + 1; j < feats.length; j++) {
          const inter = safeIntersect(feats[i], feats[j]);
          if (!inter) continue;
          expect(planarArea(inter)).toBeLessThanOrEqual(1);
        }
    }
  });

  it('ignores background — a transparent margin cuts nothing', () => {
    const { components } = traceLabelMap(grid(block(24, 16), 'a'), params());
    expect(components).toHaveLength(1);
    expect(components[0].label).toBe(0);
    expect(areaOf(components[0])).toBeCloseTo(256, 9);
  });

  it('keeps a one-pixel stroke sandwiched between two other regions', () => {
    // The straightness cone is widened by half a pixel at each bound, so the whole boundary of a
    // one-pixel-thick region can stay inside it and read as one straight run: out one side, around
    // the end, back the other. The fitted polygon collapses to the chord, the ring drops below three
    // points, and walkRings discarded it — the stroke disappeared from the output entirely, at every
    // length, in both orientations. Silent deletion of a whole colour, not degradation.
    // Caught now by `unfitCollapsedChains` (trace.ts), which checks area per component and unfits
    // the offending chains back to their lattice points rather than tightening the cone itself — a
    // tighter cone was tried and cost 34% more output points on photographic sources for no gain
    // curve.ts's own comment records the measurement and the choice.
    for (const len of [3, 10, 40]) {
      const pad = 3;
      const w = len + pad * 2;
      const rows = [
        'a'.repeat(w),
        'a'.repeat(pad) + 'b'.repeat(len) + 'a'.repeat(pad),
        'c'.repeat(w),
        'c'.repeat(w),
      ];
      const { components } = traceLabelMap(grid(rows, 'abc'), params());
      const stroke = components.find((c) => c.label === 1);
      expect(stroke, `stroke of length ${len} was dropped`).toBeDefined();
      expect(stroke!.area).toBe(len);
    }
  });

  it('keeps that stroke vertically too, not just along the scan direction', () => {
    const rows = ['aaaaaaa', ...Array.from({ length: 12 }, () => 'aaabccc'), 'ccccccc'];
    const { components } = traceLabelMap(grid(rows, 'abc'), params());
    const stroke = components.find((c) => c.label === 1);
    expect(stroke).toBeDefined();
    expect(stroke!.area).toBe(12);
  });

  it('keeps a shallow diagonal stroke intact, not scattered into isolated fragments', () => {
    // The out-and-back case above collapses one straight run; a stroke that turns a corner instead
    // (this one steps down two pixels at a time) reads as several short straight runs, and each one
    // independently degenerates — measured before the fix: 93 of 95 two-pixel runs produced no ring
    // at all. This is the same failure by a different route, and the same fix has to cover both.
    const w = 60,
      h = 32;
    const rows = Array.from({ length: h }, () => Array(w).fill('a'));
    for (let x = 0; x < w; x++) {
      const y = Math.floor(x / 2);
      if (y < h) rows[y][x] = 'b';
      for (let yy = y + 1; yy < h; yy++) rows[yy][x] = 'c';
    }
    const { components } = traceLabelMap(
      grid(
        rows.map((r) => r.join('')),
        'abc',
      ),
      params(),
    );
    const strokeArea = components.filter((c) => c.label === 1).reduce((s, c) => s + areaOf(c), 0);
    expect(strokeArea).toBeCloseTo(w, 9);
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
