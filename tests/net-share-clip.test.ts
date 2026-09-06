import { describe, expect, it, vi } from 'vitest';

// The one boolean this file needs to fail on demand. `clipToNetShare` reports where a whole-part
// mark moved to, and turf hands a failed difference back as the subject UNCHANGED, so nothing about
// the returned feature says the move never happened.
vi.mock('@turf/turf', async (importOriginal) => {
  const real = await importOriginal<typeof import('@turf/turf')>();
  return {
    ...real,
    difference: () => {
      throw new Error('clipper failed');
    },
  };
});

import { clipToNetShare } from '../src/geometry/assembly';
import { ConformalZoneMapper, type ConformalChart } from '../src/geometry/conformal';
import { differenceChecked, safeDiff } from '../src/geometry/regions';
import type { NetExclusion } from '../src/geometry/zones';
import type { PolyFeature } from '../src/types';
import { makeCylinderChart } from './lib/cylinderChart';

const box = (x0: number, y0: number, x1: number, y1: number): PolyFeature =>
  ({
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
          [x0, y0],
        ],
      ],
    },
  }) as PolyFeature;

const exclusion = (over: Partial<NetExclusion> = {}): NetExclusion => ({
  toName: 'Sheet B',
  region: box(5, -1, 15, 11),
  bbox: [5, -1, 15, 11],
  ...over,
});

describe('clipToNetShare on a difference that fails', () => {
  it('reports the failure and names no zone the ink moved to', () => {
    const r = clipToNetShare(box(0, 0, 10, 10), [exclusion()]);
    expect(r.failed).toBe(true);
    // The mark is still cut here as well as on "Sheet B", so nothing may claim it moved.
    expect(r.movedTo).toEqual([]);
    expect(r.feat).not.toBeNull();
  });

  it('fails only on the patch the design actually reaches', () => {
    // The far patch is skipped by the bbox gate before any boolean runs, so it neither fails nor
    // moves anything, and the near one is the whole of the report.
    const r = clipToNetShare(box(0, 0, 10, 10), [
      exclusion({ toName: 'Far sheet', region: box(80, 80, 90, 90), bbox: [80, 80, 90, 90] }),
      exclusion(),
    ]);
    expect(r.failed).toBe(true);
    expect(r.movedTo).toEqual([]);
  });
});

describe('an exclusion whose baked loops build no polygon', () => {
  it('is reported as untrimmable rather than dropped', () => {
    const r = clipToNetShare(box(0, 0, 10, 10), [exclusion({ region: null })]);
    expect(r.failed).toBe(true);
    expect(r.movedTo).toEqual([]);
  });

  it('costs nothing and says nothing for a design that never reaches it', () => {
    const r = clipToNetShare(box(0, 0, 10, 10), [
      exclusion({ region: null, bbox: [80, 80, 90, 90] }),
    ]);
    expect(r.failed).toBe(false);
    expect(r.movedTo).toEqual([]);
  });

  it('is what the mapper hands over when the baked entry will not build', () => {
    // A truncated `excluded` entry: loops present, `holes` gone. The bbox still reads off the outer
    // loop, which is what keeps the gate honest for an entry with no polygon behind it.
    const chart: ConformalChart = {
      ...makeCylinderChart(),
      netExcluded: [
        {
          to: 'b',
          toName: 'Sheet B',
          areaMm2: 12,
          regions: [
            {
              outer: [
                [0, 0],
                [4, 4],
                [8, 0],
              ],
            } as unknown as { outer: number[][]; holes: number[][][] },
          ],
        },
      ],
    };
    const excl = new ConformalZoneMapper(null, chart, 'a').netExcluded();
    expect(excl).toHaveLength(1);
    expect(excl[0]).toMatchObject({ toName: 'Sheet B', region: null });
    expect(excl[0].bbox).toEqual([0, 0, 8, 4]);
  });

  it('keeps an entry with no loops at all, with a gate nothing slips past', () => {
    // An entry with an empty `regions` array has no loops to read a bbox from. Left inverted
    // ([Inf, Inf, -Inf, -Inf]), the overlap gate skips the entry for every real design and the
    // clip neither trims nor fails — the silent doubled cut again, one shape further gone.
    const chart: ConformalChart = {
      ...makeCylinderChart(),
      netExcluded: [{ to: 'b', toName: 'Sheet B', areaMm2: 12, regions: [] }],
    };
    const excl = new ConformalZoneMapper(null, chart, 'a').netExcluded();
    expect(excl).toHaveLength(1);
    expect(excl[0]).toMatchObject({ toName: 'Sheet B', region: null });
    // Unbounded, so the bbox gate consults it for every design and the null region fails the clip.
    expect(excl[0].bbox).toEqual([-Infinity, -Infinity, Infinity, Infinity]);
  });
});

describe('the mapper carries the bake’s continuity verdict through to the clip', () => {
  it('hands over `joins` and the tear beside the patch it belongs to', () => {
    const chart: ConformalChart = {
      ...makeCylinderChart(),
      netExcluded: [
        {
          to: 'b',
          toName: 'Sheet B',
          areaMm2: 12,
          joins: false,
          tearMm: 44.2,
          regions: [
            {
              outer: [
                [0, 0],
                [4, 4],
                [8, 0],
              ],
              holes: [],
            },
          ],
        },
      ],
    };
    const excl = new ConformalZoneMapper(null, chart, 'a').netExcluded();
    expect(excl[0]).toMatchObject({ joins: false, tearMm: 44.2 });
  });

  it('leaves both undefined on a patch baked before either was measured', () => {
    const chart: ConformalChart = {
      ...makeCylinderChart(),
      netExcluded: [{ to: 'b', toName: 'Sheet B', areaMm2: 12, regions: [] }],
    };
    const excl = new ConformalZoneMapper(null, chart, 'a').netExcluded();
    expect(excl[0].joins).toBeUndefined();
    expect(excl[0].tearMm).toBeUndefined();
  });
});

describe('differenceChecked', () => {
  it('flags the failure and hands the subject back whole', () => {
    const r = differenceChecked(box(0, 0, 10, 10), box(5, -1, 15, 11));
    expect(r.trimmed).toBe(false);
    expect(r.feat).toEqual(box(0, 0, 10, 10));
  });

  it('counts nothing to subtract as a clean success', () => {
    expect(differenceChecked(box(0, 0, 10, 10), null)).toEqual({
      feat: box(0, 0, 10, 10),
      trimmed: true,
    });
    expect(differenceChecked(null, box(0, 0, 1, 1))).toEqual({ feat: null, trimmed: true });
  });

  it('leaves safeDiff answering exactly as it did', () => {
    expect(safeDiff(box(0, 0, 10, 10), box(5, -1, 15, 11))).toEqual(box(0, 0, 10, 10));
    expect(safeDiff(null, box(0, 0, 1, 1))).toBeNull();
  });
});
