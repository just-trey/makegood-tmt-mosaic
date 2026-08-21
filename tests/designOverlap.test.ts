import { describe, expect, it } from 'vitest';
import {
  convexIntersectionArea,
  overlappingDesignPairs,
  OVERLAP_WARN_FRACTION,
  type PlacedDesign,
} from '../src/geometry/designOverlap';

/** A `w`×`h` rectangle centered on (cx, cy), wound counter-clockwise. */
function rect(cx: number, cy: number, w: number, h: number): number[][] {
  return [
    [cx - w / 2, cy - h / 2],
    [cx + w / 2, cy - h / 2],
    [cx + w / 2, cy + h / 2],
    [cx - w / 2, cy + h / 2],
  ];
}

function design(quad: number[][], name = 'a.svg', fill = false): PlacedDesign {
  return { name, quad, fill };
}

/** A design whose ink is exactly its quad: the solid-rectangle case the quads already got right. */
function solid(quad: number[][], name = 'a.svg'): PlacedDesign {
  return { name, quad, fill: false, ink: () => [[quad]] };
}

/**
 * A `w`×`h` frame centered on (cx, cy): ink only in a `border`-wide rim, the rest a hole. This is
 * the shape the quad-only check reads as fully covering whatever sits in its middle.
 */
function frame(
  cx: number,
  cy: number,
  w: number,
  h: number,
  border: number,
  name = 'frame.svg',
): PlacedDesign {
  const outer = rect(cx, cy, w, h);
  return {
    name,
    quad: outer,
    fill: false,
    ink: () => [[outer, rect(cx, cy, w - 2 * border, h - 2 * border)]],
  };
}

describe('convexIntersectionArea', () => {
  it('is the full area when one quad sits exactly on another', () => {
    expect(convexIntersectionArea(rect(0, 0, 10, 10), rect(0, 0, 10, 10))).toBeCloseTo(100);
  });

  it('is zero for disjoint quads', () => {
    expect(convexIntersectionArea(rect(0, 0, 10, 10), rect(40, 0, 10, 10))).toBe(0);
  });

  it('is zero for quads that only touch along an edge', () => {
    expect(convexIntersectionArea(rect(0, 0, 10, 10), rect(10, 0, 10, 10))).toBeCloseTo(0);
  });

  it('measures a partial overlap', () => {
    // shifted 6mm along x: the 10x10 squares share a 4x10 strip
    expect(convexIntersectionArea(rect(0, 0, 10, 10), rect(6, 0, 10, 10))).toBeCloseTo(40);
  });

  it('is unaffected by winding order', () => {
    const cw = rect(6, 0, 10, 10).slice().reverse();
    expect(convexIntersectionArea(rect(0, 0, 10, 10), cw)).toBeCloseTo(40);
  });

  it('handles a rotated quad — a 45° square inscribed in a larger one', () => {
    // diagonal-2 square (area 2) fully inside a 10x10 square
    const diamond = [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ];
    expect(convexIntersectionArea(diamond, rect(0, 0, 10, 10))).toBeCloseTo(2);
  });

  it('is symmetric in its arguments', () => {
    const a = rect(0, 0, 10, 6),
      b = rect(3, 2, 8, 8);
    expect(convexIntersectionArea(a, b)).toBeCloseTo(convexIntersectionArea(b, a));
  });
});

describe('overlappingDesignPairs', () => {
  it('finds nothing for a single design', () => {
    expect(overlappingDesignPairs([design(rect(0, 0, 10, 10))])).toEqual([]);
  });

  it('flags two designs placed coplanar', () => {
    const pairs = overlappingDesignPairs([
      design(rect(0, 0, 10, 10), 'a.svg'),
      design(rect(0, 0, 10, 10), 'b.svg'),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].map((p) => p.name)).toEqual(['a.svg', 'b.svg']);
  });

  it('flags the cascade step, which clears only a sliver of a large design', () => {
    // what loading a second design on the wheel produces: 8mm apart on a 276mm design
    const pairs = overlappingDesignPairs([
      design(rect(0, 0, 276, 276), 'a.svg'),
      design(rect(8, 8, 276, 276), 'b.svg'),
    ]);
    expect(pairs).toHaveLength(1);
  });

  it('leaves designs placed side by side alone', () => {
    expect(
      overlappingDesignPairs([design(rect(0, 0, 10, 10)), design(rect(11, 0, 10, 10))]),
    ).toEqual([]);
  });

  it('leaves a small bounding-box graze alone', () => {
    // two 50mm designs side by side sharing 2mm of whitespace = 4% of the smaller footprint. This
    // is the case the threshold exists for: warning here would train users to ignore the pill.
    expect(
      overlappingDesignPairs([design(rect(0, 0, 50, 50)), design(rect(48, 0, 50, 50))]),
    ).toEqual([]);
  });

  // The threshold has to stay under what the app's own cascade leaves, or the app positions two
  // designs on top of each other and then says nothing about it — see the note on
  // OVERLAP_WARN_FRACTION. A 12mm sticker stepped 8mm keeps 11% covered.
  it('flags the cascade step on a design small enough that the step nearly clears it', () => {
    const pairs = overlappingDesignPairs([
      design(rect(0, 0, 12, 12), 'a.svg'),
      design(rect(8, 8, 12, 12), 'b.svg'),
    ]);
    expect(pairs).toHaveLength(1);
  });

  it('keeps the threshold below what the cascade leaves on a 12mm design', () => {
    const covered = ((12 - 8) / 12) ** 2; // 0.111…
    expect(OVERLAP_WARN_FRACTION).toBeLessThanOrEqual(covered);
  });

  it('measures coverage against the SMALLER design, not the bigger one', () => {
    // a 4x4 design fully inside a 100x100 one covers 0.16% of the big one but 100% of itself
    const pairs = overlappingDesignPairs([
      design(rect(0, 0, 100, 100), 'big.svg'),
      design(rect(0, 0, 4, 4), 'small.svg'),
    ]);
    expect(pairs).toHaveLength(1);
  });

  it('flags every overlapping pair among three designs', () => {
    const pairs = overlappingDesignPairs([
      design(rect(0, 0, 10, 10), 'a.svg'),
      design(rect(0, 0, 10, 10), 'b.svg'),
      design(rect(50, 50, 10, 10), 'c.svg'),
    ]);
    expect(pairs.map((p) => p.map((d) => d.name))).toEqual([['a.svg', 'b.svg']]);
  });

  it('flags two fills on one zone regardless of where their boxes sit', () => {
    const pairs = overlappingDesignPairs([
      design(rect(0, 0, 10, 10), 'a.svg', true),
      design(rect(500, 500, 10, 10), 'b.svg', true),
    ]);
    expect(pairs).toHaveLength(1);
  });

  it('leaves a fill under a sticker alone — that is a real workflow', () => {
    expect(
      overlappingDesignPairs([
        design(rect(0, 0, 10, 10), 'pattern.svg', true),
        design(rect(0, 0, 10, 10), 'logo.svg', false),
      ]),
    ).toEqual([]);
  });

  it('ignores a design with no extent rather than dividing by its area', () => {
    expect(
      overlappingDesignPairs([design(rect(0, 0, 10, 10)), design(rect(0, 0, 0, 0), 'empty.svg')]),
    ).toEqual([]);
  });
});

// The quads alone answer "could these cut into each other". Ink answers it for the one shape that
// makes the quad wrong in the user's favour: a design sitting in another's hollow.
describe('overlappingDesignPairs, ink gate', () => {
  it('leaves a logo centered in a frame alone', () => {
    expect(
      overlappingDesignPairs([frame(0, 0, 60, 60, 4), solid(rect(0, 0, 20, 20), 'logo.svg')]),
    ).toEqual([]);
  });

  it('still flags a logo that crosses the frame rim', () => {
    // the same frame, the logo moved out until it lands on the border rather than the hole
    const pairs = overlappingDesignPairs([
      frame(0, 0, 60, 60, 4),
      solid(rect(28, 0, 20, 20), 'logo.svg'),
    ]);
    expect(pairs).toHaveLength(1);
  });

  it('still flags two solid designs on top of each other', () => {
    const pairs = overlappingDesignPairs([
      solid(rect(0, 0, 10, 10), 'a.svg'),
      solid(rect(0, 0, 10, 10), 'b.svg'),
    ]);
    expect(pairs).toHaveLength(1);
  });

  it('leaves two frames whose rims miss each other alone', () => {
    expect(
      overlappingDesignPairs([
        frame(0, 0, 60, 60, 3, 'outer.svg'),
        frame(0, 0, 40, 40, 3, 'inner.svg'),
      ]),
    ).toEqual([]);
  });

  it('flags two frames whose rims land on each other', () => {
    const pairs = overlappingDesignPairs([
      frame(0, 0, 60, 60, 6, 'outer.svg'),
      frame(0, 0, 58, 58, 6, 'inner.svg'),
    ]);
    expect(pairs).toHaveLength(1);
  });

  it('falls back to the quads when only one design carries ink', () => {
    const pairs = overlappingDesignPairs([
      frame(0, 0, 60, 60, 4),
      design(rect(0, 0, 20, 20), 'logo.svg'),
    ]);
    expect(pairs).toHaveLength(1);
  });

  it('never contradicts the quads: ink can only clear a pair, never raise one', () => {
    const apart = overlappingDesignPairs([
      solid(rect(0, 0, 10, 10), 'a.svg'),
      solid(rect(11, 0, 10, 10), 'b.svg'),
    ]);
    expect(apart).toEqual([]);
  });

  it('reads a design with no ink at all as cutting nothing', () => {
    expect(
      overlappingDesignPairs([
        solid(rect(0, 0, 10, 10), 'a.svg'),
        { name: 'blank.svg', quad: rect(0, 0, 10, 10), fill: false, ink: () => [] },
      ]),
    ).toEqual([]);
  });

  // Ink is measured against the smaller design's ink, not its bounding box. Against the box, a
  // design this sparse could not reach the threshold however completely it lands on another.
  it('flags two sparse frames sitting exactly on each other', () => {
    const pairs = overlappingDesignPairs([
      frame(0, 0, 60, 60, 1.5, 'a.svg'),
      frame(0, 0, 60, 60, 1.5, 'b.svg'),
    ]);
    expect(pairs).toHaveLength(1);
  });

  it('still clears a sparse design nested in a sparse frame', () => {
    expect(
      overlappingDesignPairs([
        frame(0, 0, 60, 60, 1.5, 'outer.svg'),
        frame(0, 0, 20, 20, 1, 'inner.svg'),
      ]),
    ).toEqual([]);
  });

  it('does not consult ink for a pair the quads already cleared', () => {
    let reads = 0;
    const withCount = (d: PlacedDesign): PlacedDesign => ({
      ...d,
      ink: () => {
        reads++;
        return d.ink!();
      },
    });
    overlappingDesignPairs([
      withCount(solid(rect(0, 0, 10, 10), 'a.svg')),
      withCount(solid(rect(40, 0, 10, 10), 'b.svg')),
    ]);
    expect(reads).toBe(0);
  });
});
