import { describe, expect, it } from 'vitest';
import { getManifold } from '../src/geometry/manifold';
import {
  coversClipDisc,
  fitOutline,
  narrowFeatureArea,
  outlineArea,
  outlineBounds,
  outlineContains,
  ringArea,
  type Outline,
} from '../src/geometry/hubcapOutline';
import { HUBCAP_CLIP_FACE_OUTER_R_MM } from '../src/geometry/hubcap';

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
  const R = HUBCAP_CLIP_FACE_OUTER_R_MM;

  it('accepts a shape that covers the clip annulus', () => {
    expect(coversClipDisc([circle(R + 5)], R)).toBe(true);
  });

  it('refuses a shape smaller than the clips', () => {
    expect(coversClipDisc([circle(R - 2)], R)).toBe(false);
  });

  it('refuses a ring, however big — the clips land in its hole', () => {
    // The case no real test image has and the one that matters: a logo with an open centre passes
    // every size and area check and still bonds to nothing.
    expect(coversClipDisc([circle(120), circle(R + 5)], R)).toBe(false);
  });

  it('refuses a shape that covers the centre but not all of the annulus', () => {
    // a tall narrow bar through the middle: contains the origin, misses the clips left and right
    expect(coversClipDisc([rect(6, 200)], R)).toBe(false);
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
