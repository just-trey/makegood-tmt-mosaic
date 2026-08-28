import { afterEach, describe, expect, it } from 'vitest';
import { armCancel, cancelHonoured, requestCancel, RebuildCancelled } from '../src/cancel';
import { computeNetRegionsByColor } from '../src/geometry/regions';
import type { SVGShape } from '../src/types';

/**
 * The cancel call sites shipped unexercised: no test armed a cancel before a build, so deleting
 * any of them left the suite green. That is how the 140.4s latency the 2026-08-24 cycle measured
 * survived a check being added at the wrong layer — the code looked cancellable and was not.
 *
 * These drive the layer that actually holds the time. The sites inside assembly.ts need the
 * Manifold WASM engine and a loaded part, so they are covered in tests/assembly.test.ts, one case
 * per site, next to the fixtures that build one.
 */

/** Enough overlapping shapes that the paint-order loop runs past one yield budget. */
function manyShapes(n: number): SVGShape[] {
  return Array.from({ length: n }, (_, i) => ({
    fill: `#${(i % 3).toString(16).repeat(6)}`,
    order: i,
    loops: [
      [
        { x: i * 0.1, y: 0 },
        { x: i * 0.1 + 40, y: 0 },
        { x: i * 0.1 + 40, y: 40 },
        { x: i * 0.1, y: 40 },
      ],
    ],
  }));
}

afterEach(() => armCancel());

describe('computeNetRegionsByColor honours a cancel', () => {
  it('throws RebuildCancelled instead of running to completion', async () => {
    armCancel();
    requestCancel(); // as if the button were pressed while this pass was already running

    await expect(computeNetRegionsByColor(manyShapes(400), () => {})).rejects.toBeInstanceOf(
      RebuildCancelled,
    );
  });

  // The scheduler drops the queued follow-up pass only for a cancel that actually aborted
  // something, so a site that throws without recording the honour would leave the rebuild it
  // stopped to restart immediately.
  it('records that the cancel was honoured', async () => {
    armCancel();
    requestCancel();

    await computeNetRegionsByColor(manyShapes(400), () => {}).catch(() => {});

    expect(cancelHonoured()).toBe(true);
  });

  it('runs to completion when no cancel is armed', async () => {
    armCancel();

    const { byColor } = await computeNetRegionsByColor(manyShapes(20), () => {});

    expect(Object.keys(byColor).length).toBeGreaterThan(0);
    expect(cancelHonoured()).toBe(false);
  });
});
