import { describe, expect, it } from 'vitest';
import {
  MIN_CUT_DEPTH_MM,
  addPartTooDeepClamp,
  addTooDeepClamp,
  depthDiffers,
  requestedDepth,
  subLayerDepth,
  thinDepthNotice,
  tooDeepPlateWarning,
  tooDeepWarning,
  type DepthClamp,
  type PartDepthClamp,
} from '../src/geometry/depth';

describe('subLayerDepth', () => {
  it('ignores a depth that only rounds below a layer', () => {
    // 0.199 printed as "is 0.20 mm, thinner than the usual 0.20 mm print layer" — a note that
    // contradicts itself in its own sentence.
    expect(subLayerDepth(0.199)).toBe(false);
    expect(subLayerDepth(0.1951)).toBe(false);
    // Exactly on the old 0.005 epsilon, which let it through while it still prints as "0.20".
    expect(subLayerDepth(0.195)).toBe(false);
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
    //
    // Stepped as whole thousandths rather than by `d += 0.005`, which accumulates: that walked
    // past 0.195 as 0.19500000000000006 and skipped the one value that actually failed.
    for (let thou = 1; thou < MIN_CUT_DEPTH_MM * 1000; thou++) {
      const d = thou / 1000;
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

describe('tooDeepWarning', () => {
  const msg = tooDeepWarning(['#ff0000'], 'Wheel top', 9999, 48.45);

  it('names the color, the part, and both numbers', () => {
    expect(msg).toContain('"#ff0000"');
    expect(msg).toContain('"Wheel top"');
    expect(msg).toContain('9999.00 mm');
    expect(msg).toContain('48.45 mm');
  });

  // The cut stops CUT_FLOOR_MM short of the part's back, so quoting the cut depth as the part's
  // face-to-back distance made one figure do two jobs and was wrong by that floor at the second.
  it('does not claim the cut depth is the part’s depth', () => {
    expect(msg).not.toMatch(/is 48\.45 mm from/);
    expect(msg).toContain('deeper than "Wheel top" goes');
  });

  // CLAUDE.md bars em dashes in user-facing copy.
  it('uses no em dash', () => {
    expect(msg).not.toContain('\u2014');
  });

  it('names every color clamped to the same depth on the same part at once', () => {
    const grouped = tooDeepWarning(['#ff0000', '#00ff00'], 'Wheel top', 9999, 48.45);
    expect(grouped).toBe(
      'Depths for "#ff0000", "#00ff00" were set to 9999.00 mm, deeper than "Wheel top" goes. ' +
        'They were cut at 48.45 mm instead.',
    );
  });
});

describe('tooDeepPlateWarning', () => {
  it('names the color and both numbers, with the plate thickness instead of a part', () => {
    const msg = tooDeepPlateWarning(['#ff0000'], 100, 3.95, 4);
    expect(msg).toBe(
      'Depth for "#ff0000" was set to 100.00 mm, but a 4.00 mm plate can only cut 3.95 mm deep. ' +
        'It was cut at 3.95 mm instead.',
    );
  });

  it('groups every color clamped to the same depth into one message', () => {
    const msg = tooDeepPlateWarning(['#ff0000', '#0000ff'], 100, 3.95, 4);
    expect(msg).toBe(
      'Depths for "#ff0000", "#0000ff" were set to 100.00 mm, but a 4.00 mm plate can only cut ' +
        '3.95 mm deep. They were cut at 3.95 mm instead.',
    );
  });
});

describe('addTooDeepClamp / addPartTooDeepClamp', () => {
  it('groups by (requested, cutAt), keeping two different requested depths separate', () => {
    const into = new Map<string, DepthClamp>();
    addTooDeepClamp(into, '#ff0000', 100, 3.95);
    addTooDeepClamp(into, '#0000ff', 100, 3.95);
    addTooDeepClamp(into, '#00ff00', 50, 3.95);
    expect(Array.from(into.values())).toEqual([
      { requested: 100, cutAt: 3.95, labels: ['#ff0000', '#0000ff'] },
      { requested: 50, cutAt: 3.95, labels: ['#00ff00'] },
    ]);
  });

  it('does not repeat a label already staged for the same pair', () => {
    const into = new Map<string, DepthClamp>();
    addTooDeepClamp(into, '#ff0000', 100, 3.95);
    addTooDeepClamp(into, '#ff0000', 100, 3.95);
    expect(Array.from(into.values())).toEqual([
      { requested: 100, cutAt: 3.95, labels: ['#ff0000'] },
    ]);
  });

  it('keeps two parts clamping the same color to the same numbers separate', () => {
    const into = new Map<string, PartDepthClamp>();
    addPartTooDeepClamp(into, '#ff0000', 'Wheel top', 9999, 24.25);
    addPartTooDeepClamp(into, '#ff0000', 'Wheel bottom', 9999, 24.25);
    expect(Array.from(into.values())).toEqual([
      { requested: 9999, cutAt: 24.25, partName: 'Wheel top', labels: ['#ff0000'] },
      { requested: 9999, cutAt: 24.25, partName: 'Wheel bottom', labels: ['#ff0000'] },
    ]);
  });
});
