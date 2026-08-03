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

import { applyParsedSVG, applyPattern, isRasterImage } from '../src/ui/artworkPanel';
import { state } from '../src/state/store';

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

describe('isRasterImage', () => {
  it('flags a PNG by MIME type, even with a misleading extension', () => {
    expect(isRasterImage(new File([''], 'photo.svg', { type: 'image/png' }))).toBe(true);
  });

  it('flags a JPG dropped with no MIME type, by extension', () => {
    expect(isRasterImage(new File([''], 'photo.jpg', { type: '' }))).toBe(true);
  });

  it('does not flag an SVG by MIME type or extension', () => {
    expect(isRasterImage(new File([''], 'design.svg', { type: 'image/svg+xml' }))).toBe(false);
    expect(isRasterImage(new File([''], 'design.svg', { type: '' }))).toBe(false);
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
