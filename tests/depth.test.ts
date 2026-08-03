import { describe, expect, it } from 'vitest';
import {
  MIN_CUT_DEPTH_MM,
  depthDiffers,
  requestedDepth,
  subLayerDepth,
  thinDepthNotice,
} from '../src/geometry/depth';

describe('subLayerDepth', () => {
  it('ignores a depth that only rounds below a layer', () => {
    // 0.199 printed as "is 0.20 mm, thinner than the usual 0.20 mm print layer" — a note that
    // contradicts itself in its own sentence.
    expect(subLayerDepth(0.199)).toBe(false);
    expect(subLayerDepth(0.1951)).toBe(false);
  });

  it('still catches a depth that really is under a layer', () => {
    expect(subLayerDepth(0.12)).toBe(true);
    expect(subLayerDepth(0.02)).toBe(true);
  });

  it('says nothing about a depth at or above the layer', () => {
    expect(subLayerDepth(MIN_CUT_DEPTH_MM)).toBe(false);
    expect(subLayerDepth(1)).toBe(false);
  });

  it('never produces a notice whose two numbers read the same', () => {
    // The guard that matters, stated as the property rather than as a threshold: whatever it lets
    // through has to print as visibly thinner than the layer it is being compared to.
    for (let d = 0.005; d < MIN_CUT_DEPTH_MM; d += 0.005) {
      if (!subLayerDepth(d)) continue;
      const msg = thinDepthNotice('#ff0000', d);
      expect(msg).not.toContain(
        `is ${MIN_CUT_DEPTH_MM.toFixed(2)} mm, thinner than the usual ${MIN_CUT_DEPTH_MM.toFixed(2)} mm`,
      );
    }
  });
});

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
