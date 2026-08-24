import { describe, expect, it, vi } from 'vitest';
import type { SVGShape } from '../src/types';
import { WARNINGS, clearWarnings } from '../src/warnings';

// Break only the n-ary sweep, and only the one reached through the ESM specifier.
//
// That is the whole point: `safeUnionAll` asks polygon-clipping to union n features in one call,
// and a single sweep has one outcome for all of them. When it fails, the helper re-folds the batch
// pairwise through `safeUnion`, which goes via Turf — CommonJS, requiring its own handle on the
// engine, so this mock does not reach it. Turf therefore still works, the fold succeeds, and
// nothing is lost.
//
// Without that fallback the helper returned `live[0]` and every other piece of the colour was
// discarded. This file fails if that ever comes back: 10 shapes collapse to 1.
vi.mock('polygon-clipping', async (importOriginal) => {
  const actual = (await importOriginal<{ default: Record<string, unknown> }>()).default;
  return {
    default: {
      ...actual,
      union: () => {
        throw new Error('forced n-ary union failure');
      },
    },
  };
});

const { computeNetRegionsByColor, planarArea } = await import('../src/geometry/regions');

const SIDE = 4;
const COUNT = 10; // > COVERED_BATCH, so the accumulator fold runs too, not just the per-color merge

/** `COUNT` disjoint squares of one colour, spaced so none occludes another. Every one is visible,
 * so they all reach that colour's merge as separate pieces. */
function disjointSameColor(): SVGShape[] {
  return Array.from({ length: COUNT }, (_, i) => ({
    fill: '#ff0000',
    order: i,
    loops: [
      [
        { x: i * 10, y: 0 },
        { x: i * 10 + SIDE, y: 0 },
        { x: i * 10 + SIDE, y: SIDE },
        { x: i * 10, y: SIDE },
      ],
    ],
  }));
}

describe('safeUnionAll falls back to the pairwise fold instead of dropping the batch', () => {
  it('keeps every piece of a color when the n-ary sweep fails', async () => {
    clearWarnings();
    const { byColor } = await computeNetRegionsByColor(disjointSameColor(), () => {});

    // All COUNT squares, not the one the failed sweep would have returned on its own.
    expect(planarArea(byColor['#ff0000'])).toBeCloseTo(COUNT * SIDE * SIDE, 6);
    expect(byColor['#ff0000'].geometry.type).toBe('MultiPolygon');
    expect((byColor['#ff0000'].geometry.coordinates as unknown[]).length).toBe(COUNT);
  });

  it('says nothing to the user, because the fold rescued it', async () => {
    clearWarnings();
    await computeNetRegionsByColor(disjointSameColor(), () => {});
    expect(WARNINGS.map((w) => w.message).filter((m) => m.startsWith("Couldn't merge"))).toEqual(
      [],
    );
  });
});
