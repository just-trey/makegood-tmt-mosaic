// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest';

// DOM-only: stub the scene/scheduler/analytics side effects so importing the panel doesn't pull
// in three.js or schedule a real rebuild. state/artwork and raster/parse stay real — the point of
// these tests is the real requantizeSource -> parseRasterImage -> notice-keying path.
vi.mock('../src/app/scheduler', () => ({ scheduleRebuild: vi.fn() }));
vi.mock('../src/ui/fitPanel', () => ({ refreshFitInputsFromState: vi.fn() }));
vi.mock('../src/scene/designGizmo', () => ({ refreshGizmo: vi.fn() }));
vi.mock('../src/analytics/track', () => ({ track: vi.fn() }));
vi.mock('../src/assembly/kinds', () => ({ fillModeOffered: () => false }));

import { renderArtworkList } from '../src/ui/artworkListPanel';
import { loadArtworkSource } from '../src/state/artwork';
import { state } from '../src/state/store';
import { parseRasterImage, rasterCappedMessage, rasterTracedMessage } from '../src/raster/parse';
import { WARNINGS, clearWarnings, notice } from '../src/warnings';
import type { RasterImage } from '../src/raster/types';

/** A single small opaque square on an otherwise transparent canvas — see raster-parse.test.ts. */
function dot(w: number, h: number, size = 2): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  const x0 = (w - size) >> 1,
    y0 = (h - size) >> 1;
  for (let dy = 0; dy < size; dy++)
    for (let dx = 0; dx < size; dx++) {
      const i = ((y0 + dy) * w + (x0 + dx)) * 4;
      data[i] = 255;
      data[i + 3] = 255;
    }
  return { data, w, h };
}

/**
 * Load a 90x90 dot as a raster source, the way applyRasterFile does. No placement (mmPerPixel
 * unset), so the fractional floor is the only one that can empty it: Detail 100 keeps the dot
 * (floor 1, despeckle skipped), Detail 0 quadruples the floor past the dot's own area and empties
 * the trace.
 */
function loadDotSource(name: string) {
  const image = dot(90, 90, 2);
  const opts = { colors: 4, detail: 100, name };
  const result = parseRasterImage(image, opts);
  const instance = loadArtworkSource(result.parsed, name, 'raster', 'sticker', '', {
    image,
    ...opts,
    palette: result.palette,
    regions: result.componentCount,
  });
  // The notice a real load raises (see applyRasterFile) — loadArtworkSource itself is pure state.
  if (result.capped) notice(rasterCappedMessage(name), instance.sourceId);
  else notice(rasterTracedMessage(name), instance.sourceId);
  return state.sources.find((s) => s.id === instance.sourceId)!;
}

function render() {
  document.body.innerHTML =
    '<div id="artwork-list"></div><div id="warnings"></div><span id="svg-fname"></span>';
  renderArtworkList();
}

function detailInput(sourceId: string) {
  return document.getElementById(`raster-detail-${sourceId}`) as HTMLInputElement;
}

beforeEach(() => {
  state.parsed = null;
  state.sources = [];
  state.artworks = [];
  state.activeArtworkId = null;
  state.assembly.parts = [];
  state.shapeKind = 'disc';
  clearWarnings();
});

describe('rasterControls Detail slider — empty trace', () => {
  it('keys the empty-trace warning by source id and clears the traced notice it replaces', () => {
    const source = loadDotSource('speck.png');
    expect(WARNINGS).toEqual([
      { message: rasterTracedMessage('speck.png'), level: 'info', key: source.id },
    ]);
    render();

    detailInput(source.id).value = '0';
    detailInput(source.id).dispatchEvent(new Event('change'));

    expect(WARNINGS).toHaveLength(1);
    expect(WARNINGS[0]).toMatchObject({ level: 'warn', key: source.id });
    expect(WARNINGS[0].message).toMatch(/No color regions survived tracing "speck\.png"/);
  });

  it('a following clean trace removes the warn and puts the traced notice back', () => {
    const source = loadDotSource('speck.png');
    render();
    detailInput(source.id).value = '0';
    detailInput(source.id).dispatchEvent(new Event('change'));
    expect(WARNINGS[0].level).toBe('warn');

    detailInput(source.id).value = '100';
    detailInput(source.id).dispatchEvent(new Event('change'));

    expect(WARNINGS).toEqual([
      { message: rasterTracedMessage('speck.png'), level: 'info', key: source.id },
    ]);
  });

  it('two sources sharing a name do not cross-retract', () => {
    const a = loadDotSource('img.png');
    const b = loadDotSource('img.png');
    render();

    detailInput(a.id).value = '0';
    detailInput(a.id).dispatchEvent(new Event('change'));

    // a's traced notice is gone, replaced by its own keyed warn; b's traced notice is untouched.
    const messages = WARNINGS.map((w) => ({ key: w.key, level: w.level }));
    expect(messages).toContainEqual({ key: a.id, level: 'warn' });
    expect(messages).toContainEqual({ key: b.id, level: 'info' });
    expect(WARNINGS).toHaveLength(2);
  });

  it('removing the empty-traced source retracts its warn', () => {
    const source = loadDotSource('speck.png');
    render();
    detailInput(source.id).value = '0';
    detailInput(source.id).dispatchEvent(new Event('change'));
    expect(WARNINGS.some((w) => w.key === source.id)).toBe(true);

    document
      .querySelector<HTMLButtonElement>('.artwork-remove')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(state.sources).toHaveLength(0);
    expect(WARNINGS.some((w) => w.key === source.id)).toBe(false);
  });
});
