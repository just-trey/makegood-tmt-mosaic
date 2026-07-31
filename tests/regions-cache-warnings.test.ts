import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SVGShape } from '../src/types';
import { WARNINGS, clearBuildWarnings, clearWarnings } from '../src/warnings';

// computeNetRegionsByColor's fallback path only runs when a turf boolean throws, and real
// polygons that break turf 6.5 are not reproducible across platforms — force it instead.
vi.mock('@turf/turf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@turf/turf')>();
  return {
    ...actual,
    difference: () => {
      throw new Error('forced boolean failure');
    },
  };
});

const { computeNetRegionsByColor } = await import('../src/geometry/regions');

function square(x0: number, y0: number, size: number) {
  return [
    { x: x0, y: y0 },
    { x: x0 + size, y: y0 },
    { x: x0 + size, y: y0 + size },
    { x: x0, y: y0 + size },
  ];
}

function overlappingShapes(): SVGShape[] {
  return [
    { fill: '#ff0000', loops: [square(0, 0, 10)], order: 0 },
    { fill: '#000000', loops: [square(3, 3, 4)], order: 1 },
  ];
}

const messages = () => WARNINGS.map((w) => w.message);

describe('computeNetRegionsByColor cache + degraded-boolean warnings', () => {
  beforeEach(() => clearWarnings());

  it('warns when a boolean falls back', async () => {
    await computeNetRegionsByColor(overlappingShapes());
    expect(messages().some((m) => m.startsWith('Boolean subtraction failed'))).toBe(true);
    expect(WARNINGS.every((w) => w.build)).toBe(true);
  });

  it('replays the warning on a cache hit, so a later rebuild still reports the degraded regions', async () => {
    const shapes = overlappingShapes();
    const first = await computeNetRegionsByColor(shapes);
    expect(messages().some((m) => m.startsWith('Boolean subtraction failed'))).toBe(true);

    clearBuildWarnings(); // the next rebuild starts (a slider nudge — same shapes, cache hit)
    expect(WARNINGS).toHaveLength(0);

    const second = await computeNetRegionsByColor(shapes);
    expect(second).toBe(first); // no recompute, so nothing re-ran to re-warn on its own
    expect(messages().some((m) => m.startsWith('Boolean subtraction failed'))).toBe(true);
  });

  it('does not replay a previous artwork’s warnings once new shapes are computed', async () => {
    await computeNetRegionsByColor(overlappingShapes());
    clearBuildWarnings();
    // A single non-overlapping shape needs no difference at all.
    await computeNetRegionsByColor([{ fill: '#ff0000', loops: [square(0, 0, 10)], order: 0 }]);
    expect(WARNINGS).toHaveLength(0);
  });
});
