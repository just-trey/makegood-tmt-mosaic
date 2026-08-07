import { describe, expect, it } from 'vitest';
import { getManifold } from '../src/geometry/manifold';
import type { SVGShape } from '../src/types';
import {
  clipCoverage,
  fitOutline,
  narrowFeatureArea,
  outlineArea,
  outlineBounds,
  outlineContains,
  ringArea,
  silhouetteFromShapes,
  type Outline,
} from '../src/geometry/hubcapOutline';
import {
  HUBCAP_CLIP_FACE_INNER_R_MM,
  HUBCAP_CLIP_FACE_OUTER_R_MM,
  HUBCAP_MIN_CLIP_COVERAGE,
} from '../src/geometry/hubcap';

/**
 * The measurements a user-supplied silhouette has to pass before it can be a hubcap.
 *
 * Shapes are built here rather than traced from an image: the awkward cases are the point — a
 * ring whose middle is a hole, a shape too small to reach the clips, a limb one nozzle wide — and
 * none of the real test images have them. The real images are exercised end to end by the driven
 * check; these pin the decisions.
 */

/** A regular polygon, CCW in (x, z). */
function circle(r: number, n = 64, cx = 0, cz = 0): Outline[0] {
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return { x: cx + r * Math.cos(t), z: cz + r * Math.sin(t) };
  });
}

/** An axis-aligned rectangle centred on the origin. */
function rect(w: number, h: number, cx = 0, cz = 0): Outline[0] {
  return [
    { x: cx - w / 2, z: cz - h / 2 },
    { x: cx + w / 2, z: cz - h / 2 },
    { x: cx + w / 2, z: cz + h / 2 },
    { x: cx - w / 2, z: cz + h / 2 },
  ];
}

describe('fitting an outline to the size the user asked for', () => {
  it('scales the longest side to the size, and centres what it scaled', () => {
    const tall = [rect(50, 200, 999, -400)];

    const [x0, z0, x1, z1] = outlineBounds(fitOutline(tall, 220));

    expect(z1 - z0).toBeCloseTo(220, 6);
    expect(x1 - x0).toBeCloseTo(55, 6); // aspect kept: 50/200 of 220
    expect((x0 + x1) / 2).toBeCloseTo(0, 6);
    expect((z0 + z1) / 2).toBeCloseTo(0, 6);
  });

  it('leaves a degenerate outline alone rather than dividing by its zero span', () => {
    const flat = [
      [
        { x: 5, z: 5 },
        { x: 5, z: 5 },
        { x: 5, z: 5 },
      ],
    ];
    expect(fitOutline(flat, 220)).toEqual(flat);
  });

  it('keeps any shape inside the wheel once its longest side is capped', () => {
    // The wheel is round and 280mm across, so the case that actually has to hold is the one with
    // the worst diagonal — a square, whose corners reach furthest for a given longest side.
    const square = fitOutline([rect(100, 100)], 280);
    const [x0, z0, x1, z1] = outlineBounds(square);
    const worstRadius = Math.hypot(Math.max(-x0, x1), Math.max(-z0, z1));
    // 280 on the longest side is NOT the same as fitting a 280mm circle: this is the number the
    // size cap has to be derived from, not assumed equal to.
    expect(worstRadius).toBeGreaterThan(140);
  });
});

describe('area and containment', () => {
  it('subtracts a hole from its boundary', () => {
    const donut = [circle(50), circle(20)];
    expect(outlineArea(donut)).toBeCloseTo(
      outlineArea([circle(50)]) - outlineArea([circle(20)]),
      1,
    );
  });

  it('reads a point in a hole as outside', () => {
    const donut = [circle(50), circle(20)];
    expect(outlineContains(donut, 35, 0)).toBe(true); // in the ring
    expect(outlineContains(donut, 0, 0)).toBe(false); // in the hole
    expect(outlineContains(donut, 60, 0)).toBe(false); // outside altogether
  });

  it('measures a ring the same either way round', () => {
    const cw = circle(10);
    const ccw = [...cw].reverse();
    expect(Math.abs(ringArea(cw))).toBeCloseTo(Math.abs(ringArea(ccw)), 6);
    expect(ringArea(cw)).toBeCloseTo(-ringArea(ccw), 6);
  });
});

describe('will the mounting clips bond to this shape', () => {
  const IN = HUBCAP_CLIP_FACE_INNER_R_MM;
  const OUT = HUBCAP_CLIP_FACE_OUTER_R_MM;
  const cov = (o: Outline) => clipCoverage(o, IN, OUT);

  it('fully backs a shape comfortably bigger than the clips', () => {
    expect(cov([circle(OUT + 5)])).toBeCloseTo(1, 2);
  });

  it('reports almost nothing for a shape smaller than the clips', () => {
    expect(cov([circle(IN - 2)])).toBeLessThan(0.05);
  });

  it('reports nothing for a ring, however big — the clips land in its hole', () => {
    // The case no real test image has and the one that matters: a logo with an open centre passes
    // every size and area check and still bonds to nothing.
    expect(cov([circle(120), circle(OUT + 5)])).toBeLessThan(0.05);
    expect(cov([circle(120), circle(OUT + 5)])).toBeLessThan(HUBCAP_MIN_CLIP_COVERAGE);
  });

  it('reports a partial for a bar that crosses the centre but misses the sides', () => {
    const c = cov([rect(6, 200)]);
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThan(HUBCAP_MIN_CLIP_COVERAGE);
  });

  it('tolerates a nick at the rim, which refusing on one sample did not', () => {
    // The regression: probing only the outer radius refused a real silhouette over 1 sample in 64
    // while its clips were otherwise entirely supported. A small bite out of the rim has to stay
    // acceptable; a clip over a hole must not.
    const nicked: Outline = [circle(OUT + 5), circle(1.2, 24, OUT, 0)];
    expect(cov(nicked)).toBeGreaterThan(HUBCAP_MIN_CLIP_COVERAGE);
  });
});

describe('features too narrow to print', () => {
  it('finds nothing narrow in a shape that is wide everywhere', async () => {
    const wasm = await getManifold();
    expect(narrowFeatureArea(wasm, [circle(50)], 1)).toBeLessThan(1);
  }, 30000);

  it('measures a limb narrower than the threshold', async () => {
    const wasm = await getManifold();
    // a 40mm disc with a 0.6mm spike out of it: the spike is the only thing under 1mm
    const shape: Outline = [circle(40)];
    const spike = [
      { x: 0, z: 39 },
      { x: 0.6, z: 39 },
      { x: 0.6, z: 70 },
      { x: 0, z: 70 },
    ];
    const withSpike = [...shape, spike];
    const bare = narrowFeatureArea(wasm, shape, 1);
    const spiked = narrowFeatureArea(wasm, withSpike, 1);
    expect(spiked).toBeGreaterThan(bare + 5);
  }, 30000);

  it('scales with the shape, which erosion alone does not', async () => {
    const wasm = await getManifold();
    // The regression this exists for: an erode-only test asked "did the ring count change", so a
    // shape that merely got thinner reported nothing wrong — a whole silhouette scaled to 60mm
    // claimed no feature under 3mm while being 34mm across. Opening measures the area instead.
    const bar: Outline = [rect(4, 100)];
    const wide = narrowFeatureArea(wasm, bar, 2);
    const narrow = narrowFeatureArea(wasm, bar, 6);
    expect(wide).toBeLessThan(narrow);
    expect(narrow).toBeCloseTo(outlineArea(bar), 0); // nothing in a 4mm bar is 6mm wide
  }, 30000);
});

describe('the silhouette of loaded artwork', () => {
  /** A square in artwork space (x, y), as one shape of the given colour. */
  const square = (w: number, cx = 0, cy = 0, fill = '#000'): SVGShape => ({
    fill,
    order: 0,
    loops: [
      [
        { x: cx - w / 2, y: cy - w / 2 },
        { x: cx + w / 2, y: cy - w / 2 },
        { x: cx + w / 2, y: cy + w / 2 },
        { x: cx - w / 2, y: cy + w / 2 },
      ],
    ],
  });

  it('merges overlapping colours instead of cancelling them', async () => {
    const wasm = await getManifold();
    // Artwork drawn as stacked layers overlaps almost everywhere. Feeding every loop to one
    // even-odd pass would punch a hole through each overlap; the union has to fill it.
    const overlapping = [square(40, -10), square(40, 10, 0, '#f00')];

    const rings = silhouetteFromShapes(wasm, overlapping);

    expect(outlineArea(rings)).toBeCloseTo(40 * 40 + 20 * 40, 0); // union, not xor
    expect(outlineContains(rings, 0, 0)).toBe(true); // the overlap is solid
  }, 30000);

  it('keeps a shape’s own hole a hole', async () => {
    const wasm = await getManifold();
    // circle() builds part-space points (x, z); artwork space is (x, y)
    const toArt = (r: ReturnType<typeof circle>) => r.map((p) => ({ x: p.x, y: p.z }));
    const ring: SVGShape = {
      fill: '#000',
      order: 0,
      loops: [toArt(circle(50)), toArt(circle(20))],
    };

    const rings = silhouetteFromShapes(wasm, [ring]);

    expect(outlineContains(rings, 35, 0)).toBe(true);
    expect(outlineContains(rings, 0, 0)).toBe(false);
  }, 30000);

  it('joins separate shapes into one outline the part can be cut to', async () => {
    const wasm = await getManifold();
    const apart = [square(20, -60), square(20, 60)];

    const rings = silhouetteFromShapes(wasm, apart);

    // two islands: a real outcome, and what the clip check exists to refuse
    expect(outlineArea(rings)).toBeCloseTo(800, 0);
    expect(
      clipCoverage(rings, HUBCAP_CLIP_FACE_INNER_R_MM, HUBCAP_CLIP_FACE_OUTER_R_MM),
    ).toBeLessThan(HUBCAP_MIN_CLIP_COVERAGE);
  }, 30000);

  it('flips both axes, so the part is neither upside down nor mirrored', async () => {
    const wasm = await getManifold();
    // Artwork space is y-down; the part's ground plane is not, and the cut path already corrects
    // for it (DesignPlacement.zMul). A shape sitting high in the artwork has to come out high on
    // the part. Mapping y straight through builds a plausible-looking shape that is inverted
    // relative to the picture printed on it.
    // a marker off to one corner, so each axis is checked independently
    const corner: SVGShape = {
      fill: '#000',
      order: 0,
      loops: [
        [
          { x: 40, y: -100 },
          { x: 60, y: -100 },
          { x: 60, y: -80 },
          { x: 40, y: -80 },
        ],
      ],
    };

    const [x0, z0, x1, z1] = outlineBounds(silhouetteFromShapes(wasm, [corner]));

    // artwork (+x, -y) is right-and-high on screen; the part frame reads it left-and-high
    expect(x1).toBeLessThan(0); // X mirrored — caught as "horizontally flipped"
    expect(z0).toBeGreaterThan(0); // Y flipped — caught as "upside down"
    expect(x1 - x0).toBeCloseTo(20, 6);
    expect(z1 - z0).toBeCloseTo(20, 6);
  }, 30000);

  it('gives nothing back for artwork with no usable loops', async () => {
    const wasm = await getManifold();
    expect(silhouetteFromShapes(wasm, [])).toEqual([]);
    expect(silhouetteFromShapes(wasm, [{ fill: '#000', order: 0, loops: [] }])).toEqual([]);
  }, 30000);
});
