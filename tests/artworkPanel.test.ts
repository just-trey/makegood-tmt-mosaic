// @vitest-environment jsdom
import { describe, expect, it, beforeAll, beforeEach, vi } from 'vitest';

// Keep the load path light and DOM-only: stub the scene/scheduler side effects so importing
// artworkPanel doesn't pull in three.js or trigger a real rebuild.
vi.mock('../src/app/scheduler', () => ({
  scheduleRebuild: vi.fn(),
  isRebuildLikelySlow: () => false,
}));
vi.mock('../src/scene/viewport', () => ({ requestFrame: vi.fn() }));
// The fit panel's DOM sync isn't what this test covers, and its inputs (#p-scale, #p-offset-x,
// ...) aren't part of this test's minimal DOM fixture — stub it out like the other side effects.
vi.mock('../src/ui/fitPanel', () => ({
  refreshFitInputsFromState: vi.fn(),
  updateOffsetSliderRanges: vi.fn(),
}));
vi.mock('../src/state/patterns', () => ({
  getPatterns: () => [{ id: 'cow', name: 'Cow', file: 'cow.svg' }],
}));

import { applyParsedSVG, applyPattern } from '../src/ui/artworkPanel';
import { rasterCappedMessage, rasterTracedMessage } from '../src/raster/parse';
import { state } from '../src/state/store';
import { autoParams } from '../src/raster/stats';
import { notice, dismissNotice, clearWarnings, WARNINGS } from '../src/warnings';

const GOOD_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#ff0000"/></svg>';
const TWO_COLOR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#ff0000"/><rect width="4" height="4" fill="#0000ff"/></svg>';
// Valid XML, but no flat-filled shapes — parseSVGDocument throws, same as a malformed drop.
const BAD_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>';

// jsdom has no 2d canvas without the native `canvas` package, and the parser resolves every fill
// through it — leave it unstubbed and GOOD_SVG's #ff0000 comes back as #000000, which matters now
// that the color settings below are pruned against the palette the designs actually paint with.
// Same stub as tests/parse.test.ts.
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = function () {
    let value = '#000000';
    return {
      get fillStyle() {
        return value;
      },
      set fillStyle(s: string) {
        const str = String(s).trim().toLowerCase();
        if (/^#[0-9a-f]{6}$/.test(str)) value = str;
      },
    };
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

beforeEach(() => {
  document.body.innerHTML = '<span id="svg-fname"></span><div id="artwork-list"></div>';
  state.parsed = null;
  state.sources = [];
  state.artworks = [];
  state.activeArtworkId = null;
  state.colorSettings = {};
  state.mergeGroups = [];
  state.keptApart = [];
  state.baseColorKey = null;
  state.baseColorMembers = [];
});

describe('applyParsedSVG failed-load safety', () => {
  it('a bad SVG throws and leaves the previously loaded artwork (and its settings) intact', () => {
    applyParsedSVG(GOOD_SVG, 'good.svg');
    const prevParsed = state.parsed;
    const prevSourceId = state.sources[0].id;
    // simulate work the user did on the loaded design
    state.colorSettings = { '#ff0000': { depth: 1.5 } };
    state.mergeGroups = [['#ff0000', '#0000ff']];
    state.baseColorKey = '#ff0000';
    state.baseColorMembers = ['#ff0000'];

    expect(() => applyParsedSVG(BAD_SVG, 'bad.svg')).toThrow();

    // nothing was cleared — a failed load is a no-op
    expect(state.parsed).toBe(prevParsed);
    expect(state.sources).toHaveLength(1);
    expect(state.sources[0].id).toBe(prevSourceId);
    expect(state.colorSettings).toEqual({ '#ff0000': { depth: 1.5 } });
    expect(state.mergeGroups).toEqual([['#ff0000', '#0000ff']]);
    expect(state.baseColorKey).toBe('#ff0000');
  });

  it('a second valid load adds alongside the first, leaving existing settings alone', () => {
    applyParsedSVG(TWO_COLOR_SVG, 'first.svg');
    state.colorSettings = { '#ff0000': { depth: 1.5 } };
    state.mergeGroups = [['#ff0000', '#0000ff']];

    applyParsedSVG(GOOD_SVG, 'second.svg');

    expect(state.sources).toHaveLength(2);
    expect(state.sources.map((s) => s.name)).toEqual(['first.svg', 'second.svg']);
    // colorSettings/mergeGroups are a shared palette across every loaded design, not tied to
    // whichever one loaded last — a second load must not discard the first design's settings.
    expect(state.colorSettings).toEqual({ '#ff0000': { depth: 1.5 } });
    expect(state.mergeGroups).toEqual([['#ff0000', '#0000ff']]);
  });
});

describe('rasterCappedMessage', () => {
  beforeEach(() => clearWarnings());

  // The notice used to advise "raise Detail", which is backwards: autoParams scales the despeckle
  // floor by 4^((50-detail)/50), so raising Detail quarters the floor and lets through four times
  // the specks — more components, not fewer, which is what tripped the cap in the first place.
  it('advises the direction that actually reduces the component count', () => {
    const at = (detail: number) => autoParams({ edgeDensity: 0.3 }, detail).despeckleFrac;
    expect(at(0)).toBeGreaterThan(at(50));
    expect(at(100)).toBeLessThan(at(50));

    const text = rasterCappedMessage('photo.png');
    expect(text).toMatch(/lower Detail/i);
    expect(text).not.toMatch(/raise Detail/i);
  });

  // One shared message deduped across every image, so re-tracing an *uncapped* image retracted a
  // still-true notice belonging to a different, capped one.
  it('is per image, so retracting one leaves another image’s standing', () => {
    expect(rasterCappedMessage('a.png')).not.toBe(rasterCappedMessage('b.png'));
    expect(rasterCappedMessage('a.png')).toContain('"a.png"');

    notice(rasterCappedMessage('a.png'));
    notice(rasterCappedMessage('b.png'));
    dismissNotice(rasterCappedMessage('b.png'));

    expect(WARNINGS.map((w) => w.message)).toEqual([rasterCappedMessage('a.png')]);
  });
});

describe('rasterTracedMessage', () => {
  beforeEach(() => clearWarnings());

  it('is per image, so dismissing one leaves another image’s standing', () => {
    expect(rasterTracedMessage('a.png')).not.toBe(rasterTracedMessage('b.png'));
    expect(rasterTracedMessage('a.png')).toContain('"a.png"');

    notice(rasterTracedMessage('a.png'));
    notice(rasterTracedMessage('b.png'));
    dismissNotice(rasterTracedMessage('b.png'));

    expect(WARNINGS.map((w) => w.message)).toEqual([rasterTracedMessage('a.png')]);
  });

  // A row shows exactly one status line once it has traced: capped and traced are mutually
  // exclusive, never both standing for the same image.
  it('is a different message from the capped notice, for the same file', () => {
    expect(rasterTracedMessage('a.png')).not.toBe(rasterCappedMessage('a.png'));
  });
});

describe('raster notices from two sources sharing a filename', () => {
  beforeEach(() => clearWarnings());

  // Two different sources loaded under the same name (a re-loaded same-named export, two photos
  // both called IMG_0001.jpg) can land on opposite sides of the capped/traced split. Removing one
  // must retract only its own notice, keyed by source id — not the other source's, which happens
  // to render identical text for its opposite state.
  it('dismissing one source leaves the other source’s notice standing', () => {
    notice(rasterCappedMessage('img.png'), 'source-1');
    notice(rasterTracedMessage('img.png'), 'source-2');
    expect(WARNINGS).toHaveLength(2);

    // source-1 is removed: src/ui/artworkListPanel.ts's remove handler dismisses by key alone, so
    // the message text passed doesn't have to match which of capped/traced this source held.
    dismissNotice(rasterCappedMessage('img.png'), 'source-1');

    expect(WARNINGS.map((w) => w.message)).toEqual([rasterTracedMessage('img.png')]);
  });

  // Mirrors src/ui/artworkListPanel.ts's rasterControls().apply(): both messages share one key,
  // so the old one has to be dismissed before the new one is added. Reversed, the new notice's
  // push is a no-op (the key is already taken) and the dismiss then wipes it, leaving nothing.
  it('re-quantizing a source from traced to capped replaces its notice, not clears it', () => {
    notice(rasterTracedMessage('img.png'), 'source-1');

    dismissNotice(rasterTracedMessage('img.png'), 'source-1');
    notice(rasterCappedMessage('img.png'), 'source-1');

    expect(WARNINGS.map((w) => w.message)).toEqual([rasterCappedMessage('img.png')]);
  });
});

describe('applyPattern', () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(GOOD_SVG),
    }) as unknown as typeof fetch;
  });

  it('loads as a pattern source, defaulting to Fill mode in assembly mode', async () => {
    state.shapeKind = 'assembly';
    await applyPattern('cow');
    expect(state.sources).toHaveLength(1);
    expect(state.sources[0].kind).toBe('pattern');
    expect(state.artworks[0].mode).toBe('fill');
  });

  it('stays Sticker outside assembly mode, which has no fill pipeline', async () => {
    state.shapeKind = 'disc';
    await applyPattern('cow');
    expect(state.artworks[0].mode).toBe('sticker');
  });

  it('a pattern id not in the manifest is a no-op', async () => {
    await applyPattern('does-not-exist');
    expect(state.sources).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
