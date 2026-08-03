import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearArtwork,
  isRasterSource,
  loadArtworkSource,
  requantizeSource,
} from '../src/state/artwork';
import { state } from '../src/state/store';
import { parseRasterImage } from '../src/raster/parse';
import { DETAIL_DEFAULT } from '../src/raster/stats';
import type { RasterImage } from '../src/raster/types';

/** Six flat vertical bands, so a Colors change genuinely changes the palette. */
function banded(w = 48, h = 48): RasterImage {
  const hexes = ['#ff0000', '#00a000', '#0000ff', '#ffd000', '#00c8c8', '#101010'];
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const n = parseInt(hexes[Math.floor((x / w) * hexes.length)].slice(1), 16);
      data[i] = (n >> 16) & 255;
      data[i + 1] = (n >> 8) & 255;
      data[i + 2] = n & 255;
      data[i + 3] = 255;
    }
  return { data, w, h };
}

/** Load a banded image as a raster source, the way applyRasterFile does. */
function loadRaster(colors = 6) {
  const image = banded();
  const opts = { colors, detail: DETAIL_DEFAULT };
  const result = parseRasterImage(image, opts);
  loadArtworkSource(result.parsed, 'photo.png', 'raster', 'sticker', '', {
    image,
    ...opts,
    palette: result.palette,
    regions: result.componentCount,
  });
  return state.sources[state.sources.length - 1];
}

beforeEach(() => {
  clearArtwork();
  state.assembly.parts = [];
});

describe('raster sources in app state', () => {
  it('registers decoded pixels alongside the parsed design', () => {
    const source = loadRaster();
    expect(source.kind).toBe('raster');
    expect(isRasterSource(source)).toBe(true);
    expect(source.raster?.image.w).toBe(48);
    expect(source.raster?.palette.length).toBeGreaterThan(1);
    expect(state.parsed).toBe(source.parsed);
  });

  it('re-quantizes to a fresh shapes array — the regions memo keys on its identity', () => {
    const source = loadRaster(6);
    const before = source.parsed;
    requantizeSource(source.id, { colors: 3 });
    expect(source.parsed).not.toBe(before);
    expect(source.parsed.shapes).not.toBe(before.shapes);
    // The active instance's mirror has to follow, or flat mode keeps cutting the old design.
    expect(state.parsed).toBe(source.parsed);
  });

  it('honours the new Colors value and records what it actually resolved to', () => {
    const source = loadRaster(6);
    expect(source.raster!.palette.length).toBeGreaterThan(3);
    requantizeSource(source.id, { colors: 3 });
    expect(source.raster!.colors).toBe(3);
    expect(source.raster!.palette.length).toBe(3);
    expect(new Set(source.parsed.shapes.map((s) => s.fill)).size).toBe(3);
  });

  it('carries a per-color depth across the palette shift a re-quantize causes', () => {
    const source = loadRaster(6);
    const hex = source.raster!.palette[0];
    state.colorSettings[hex] = { depth: 1.23 };

    requantizeSource(source.id, { detail: 20 });

    // The centroid moved, so the exact hex is gone — but the setting followed it to the nearest
    // survivor rather than being pruned, which is what keeps the sliders from feeling destructive.
    const live = new Set(source.parsed.shapes.map((s) => s.fill));
    const carried = Object.entries(state.colorSettings).find(([, v]) => v.depth === 1.23);
    expect(carried).toBeDefined();
    expect(live.has(carried![0])).toBe(true);
  });

  it('drops settings for a color that genuinely disappeared', () => {
    const source = loadRaster(6);
    state.colorSettings['#7f00ff'] = { depth: 2 }; // never in this image's palette
    requantizeSource(source.id, { colors: 4 });
    expect(state.colorSettings['#7f00ff']).toBeUndefined();
  });

  it('leaves a non-raster source alone', () => {
    loadArtworkSource(
      { shapes: [], bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, rawSVGCircle: null },
      'drawing.svg',
    );
    const svgSource = state.sources[0];
    expect(isRasterSource(svgSource)).toBe(false);
    expect(requantizeSource(svgSource.id, { colors: 4 })).toBeNull();
  });
});
