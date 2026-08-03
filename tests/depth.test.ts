import { describe, expect, it } from 'vitest';
import { MIN_CUT_DEPTH_MM, depthDiffers, requestedDepth } from '../src/geometry/depth';

describe('requestedDepth', () => {
  it('takes a stored 0 at face value instead of reading it as unset', () => {
    // `|| globalDepth` treated a deliberate 0 as absent, so in assembly mode a row showing 0.00
    // cut at the full global depth instead.
    expect(requestedDepth({ '#ff0000': { depth: 0 } }, 1, '#ff0000')).toBe(0);
  });

  it('passes a negative through so the caller can clamp and report it', () => {
    expect(requestedDepth({ '#ff0000': { depth: -1 } }, 1, '#ff0000')).toBe(-1);
  });

  it('falls back to the global depth for a missing or non-finite entry', () => {
    expect(requestedDepth({}, 1.5, '#ff0000')).toBe(1.5);
    expect(requestedDepth({ '#ff0000': { depth: NaN } }, 1.5, '#ff0000')).toBe(1.5);
  });

  it('keeps an explicit override', () => {
    expect(requestedDepth({ '#ff0000': { depth: 2.5 } }, 1, '#ff0000')).toBe(2.5);
  });
});

describe('depthDiffers', () => {
  it('ignores a difference too small to show at the printed precision', () => {
    expect(depthDiffers(3.95, 3.951)).toBe(false);
    expect(depthDiffers(3.95, 3.95)).toBe(false);
  });

  it('reports a difference the message would actually show', () => {
    expect(depthDiffers(3.95, 4)).toBe(true);
    expect(depthDiffers(MIN_CUT_DEPTH_MM, 0)).toBe(true);
  });
});
