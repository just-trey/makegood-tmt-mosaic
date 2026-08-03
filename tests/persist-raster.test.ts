// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { loadSavedSession, saveSession, clearSavedSession } from '../src/state/persist';
import { clearArtwork, loadArtworkSource } from '../src/state/artwork';
import { state } from '../src/state/store';
import { parseRasterImage } from '../src/raster/parse';
import { DETAIL_DEFAULT } from '../src/raster/stats';
import type { ParsedSVG } from '../src/types';
import type { RasterImage } from '../src/raster/types';

const SVG_TEXT =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#ff0000"/></svg>';

function svgParsed(): ParsedSVG {
  return {
    shapes: [
      {
        fill: '#ff0000',
        loops: [
          [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
            { x: 0, y: 10 },
          ],
        ],
        order: 0,
      },
    ],
    bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    rawSVGCircle: null,
  };
}

function bands(w = 32, h = 32): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const left = p % w < w / 2;
    data[p * 4] = left ? 230 : 40;
    data[p * 4 + 1] = left ? 60 : 130;
    data[p * 4 + 2] = left ? 60 : 220;
    data[p * 4 + 3] = 255;
  }
  return { data, w, h };
}

function loadRaster(name = 'photo.png') {
  const image = bands();
  const opts = { colors: 4, detail: DETAIL_DEFAULT };
  const result = parseRasterImage(image, opts);
  return loadArtworkSource(result.parsed, name, 'raster', 'sticker', '', {
    image,
    ...opts,
    palette: result.palette,
    regions: result.componentCount,
  });
}

beforeEach(() => {
  clearArtwork();
  clearSavedSession();
  state.assembly.parts = [];
});

describe('session persistence with a raster source', () => {
  it('skips the raster source — restore re-parses svgText, and an image has none', () => {
    loadArtworkSource(svgParsed(), 'drawing.svg', 'upload', 'sticker', SVG_TEXT);
    loadRaster();

    saveSession();
    const saved = loadSavedSession();

    expect(saved).not.toBeNull();
    expect(saved!.sources.map((s) => s.name)).toEqual(['drawing.svg']);
    // Every persisted source must carry text restore can actually re-parse; a '' would throw in
    // parseSVGDocument() and take the whole restore down with it, not just the image.
    for (const s of saved!.sources) expect(s.svgText.length).toBeGreaterThan(0);
  });

  it('drops the raster instances too, so no placement points at a missing source', () => {
    loadArtworkSource(svgParsed(), 'drawing.svg', 'upload', 'sticker', SVG_TEXT);
    loadRaster();

    saveSession();
    const saved = loadSavedSession()!;

    const ids = new Set(saved.sources.map((s) => s.id));
    expect(saved.artworks).toHaveLength(1);
    for (const a of saved.artworks) expect(ids.has(a.sourceId)).toBe(true);
  });

  it('re-points the active selection when it was the image being dropped', () => {
    loadArtworkSource(svgParsed(), 'drawing.svg', 'upload', 'sticker', SVG_TEXT);
    const rasterInstance = loadRaster();
    expect(state.activeArtworkId).toBe(rasterInstance.id);

    saveSession();
    const saved = loadSavedSession()!;

    expect(saved.activeArtworkId).not.toBe(rasterInstance.id);
    expect(saved.artworks.some((a) => a.id === saved.activeArtworkId)).toBe(true);
  });

  it('saves nothing at all when the image is the only design loaded', () => {
    loadRaster();
    saveSession();
    const saved = loadSavedSession();
    // Not an empty-but-valid session offering to restore nothing — there is genuinely nothing to
    // restore, so the banner must not appear.
    expect(saved === null || saved.artworks.length === 0).toBe(true);
  });
});
