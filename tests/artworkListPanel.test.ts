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
import {
  parseRasterImage,
  rasterCappedMessage,
  rasterColorLossKey,
  rasterColorLossMessage,
  rasterLostColors,
  rasterTracedMessage,
} from '../src/raster/parse';
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
 * A 90x90 dot. No placement (mmPerPixel unset), so the fractional floor is the only one that can
 * empty it: Detail 100 keeps the dot (floor 1, despeckle skipped), Detail 0 quadruples the floor
 * past the dot's own area and empties the trace.
 */
function loadDotSource(name: string) {
  return loadRasterSource(dot(90, 90, 2), { colors: 4, detail: 100, name });
}

/**
 * Blue and green bands under a red sprinkle of lone specks — see raster-parse.test.ts. Detail 50
 * keeps all three colors; Detail 0 quadruples the floor and the red paints nothing.
 */
function loadSprinkleSource(name: string) {
  const w = 64,
    h = 64;
  const image = bands(w, h, ['#0000ff', '#00c000']);
  for (let p = 0; p < w * h; p++) {
    const x = p % w,
      y = (p / w) | 0;
    if ((x * 5 + y * 3) % 17 !== 0 || x % 2 === 0 || y % 2 === 0) continue;
    const i = p * 4;
    image.data[i] = 255;
    image.data[i + 1] = 0;
    image.data[i + 2] = 0;
  }
  return loadRasterSource(image, { colors: 4, detail: 50, name });
}

/** Solid vertical bands of flat color — see raster-parse.test.ts. */
function bands(w: number, h: number, colors: string[]): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const n = parseInt(colors[Math.floor((x / w) * colors.length)].slice(1), 16);
      data[i] = (n >> 16) & 255;
      data[i + 1] = (n >> 8) & 255;
      data[i + 2] = n & 255;
      data[i + 3] = 255;
    }
  return { data, w, h };
}

/** Load an image as a raster source, and raise the notices, the way applyRasterFile does. */
function loadRasterSource(
  image: RasterImage,
  opts: { colors: number; detail: number; name: string },
) {
  const name = opts.name;
  const result = parseRasterImage(image, opts);
  const instance = loadArtworkSource(result.parsed, name, 'raster', 'sticker', '', {
    image,
    ...opts,
    palette: result.palette,
    regions: result.componentCount,
  });
  // The notices a real load raises (see applyRasterFile) — loadArtworkSource itself is pure state.
  if (result.capped) notice(rasterCappedMessage(name), instance.sourceId);
  else notice(rasterTracedMessage(name), instance.sourceId);
  if (rasterLostColors(result))
    notice(
      rasterColorLossMessage(name, result.droppedColors, result.floorReason),
      rasterColorLossKey(instance.sourceId),
    );
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

describe('rasterControls Detail slider — dropped colors', () => {
  it('raises the notice beside the traced one, under its own key', () => {
    const source = loadSprinkleSource('sprinkle.png');
    expect(WARNINGS).toHaveLength(1);
    render();

    detailInput(source.id).value = '0';
    detailInput(source.id).dispatchEvent(new Event('change'));

    expect(WARNINGS).toEqual([
      { message: rasterTracedMessage('sprinkle.png'), level: 'info', key: source.id },
      {
        message: rasterColorLossMessage('sprinkle.png', 1, 'noise'),
        level: 'info',
        key: rasterColorLossKey(source.id),
      },
    ]);
  });

  it('retracts it once a re-trace keeps every color', () => {
    const source = loadSprinkleSource('sprinkle.png');
    render();
    detailInput(source.id).value = '0';
    detailInput(source.id).dispatchEvent(new Event('change'));
    expect(WARNINGS).toHaveLength(2);

    detailInput(source.id).value = '50';
    detailInput(source.id).dispatchEvent(new Event('change'));

    expect(WARNINGS).toEqual([
      { message: rasterTracedMessage('sprinkle.png'), level: 'info', key: source.id },
    ]);
  });

  it('retracts it when the source is removed', () => {
    const source = loadSprinkleSource('sprinkle.png');
    render();
    detailInput(source.id).value = '0';
    detailInput(source.id).dispatchEvent(new Event('change'));
    expect(WARNINGS).toHaveLength(2);

    document
      .querySelector<HTMLButtonElement>('.artwork-remove')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(state.sources).toHaveLength(0);
    expect(WARNINGS).toHaveLength(0);
  });

  it('retracts it when the next trace comes back empty', () => {
    // The dropped-color notice names colors the image no longer has any trace of, so it cannot be
    // left standing next to the empty-trace warning that replaced its row's status line.
    const source = loadDotSource('speck.png');
    notice(rasterColorLossMessage('speck.png', 1, 'noise'), rasterColorLossKey(source.id));
    render();

    detailInput(source.id).value = '0';
    detailInput(source.id).dispatchEvent(new Event('change'));

    expect(WARNINGS).toHaveLength(1);
    expect(WARNINGS[0]).toMatchObject({ level: 'warn', key: source.id });
  });
});
