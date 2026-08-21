import { describe, expect, it, beforeEach } from 'vitest';
import {
  addInstanceForSource,
  clearArtwork,
  isRasterSource,
  loadArtworkSource,
  rasterMmPerPixel,
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
  const opts = { colors, detail: DETAIL_DEFAULT, mmPerPixel: rasterMmPerPixel(image) };
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
  // Placement is test-owned here: the floor tests below set a kind, a radius and a scale, and
  // `clearArtwork` deliberately leaves placement alone (it is a preference, not artwork).
  state.shapeKind = 'disc';
  state.assembly.kindId = null;
  state.asmRadius = 138;
  state.scalePct = 100;
  state.disc = { diameter: 80, thickness: 4 };
  state.marginPct = 5;
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

  // Assembly mode is the app's primary mode and it keys per-color depths as "asm:#rrggbb"
  // (geometry/assembly.ts). Remapping only the bare hex meant this carried nothing there, and the
  // prune that follows — which does read past the prefix — then deleted every custom depth: the
  // Colors slider was destructive in exactly the mode most users are in.
  it('carries an assembly-mode depth across the same shift', () => {
    const source = loadRaster(6);
    const hex = source.raster!.palette[0];
    state.colorSettings['asm:' + hex] = { depth: 1.23 };

    requantizeSource(source.id, { detail: 20 });

    const live = new Set(source.parsed.shapes.map((s) => s.fill));
    const carried = Object.entries(state.colorSettings).find(([, v]) => v.depth === 1.23);
    expect(carried).toBeDefined();
    expect(carried![0].startsWith('asm:')).toBe(true);
    expect(live.has(carried![0].slice(4))).toBe(true);
  });

  it('drops settings for a color that genuinely disappeared', () => {
    const source = loadRaster(6);
    state.colorSettings['#7f00ff'] = { depth: 2 }; // never in this image's palette
    requantizeSource(source.id, { colors: 4 });
    expect(state.colorSettings['#7f00ff']).toBeUndefined();
  });

  it('sizes the despeckle floor from the part the design is placed on', () => {
    // The wheel: the Design radius over the image's own half-extent, which is what the cut uses.
    state.shapeKind = 'assembly';
    state.assembly.kindId = 'wheel';
    state.asmRadius = 138;
    state.scalePct = 100;
    const image = banded();
    expect(rasterMmPerPixel(image)).toBeCloseTo(5.75, 6);

    // Half the size, half the millimetres per pixel.
    state.scalePct = 50;
    expect(rasterMmPerPixel(image)).toBeCloseTo(2.875, 6);

    // A flat plate answers nothing: it fits the design's drawn content, which the trace has not
    // produced yet, and the opaque pixels are wrong in the damaging direction.
    state.shapeKind = 'disc';
    state.disc = { diameter: 80, thickness: 4 };
    expect(rasterMmPerPixel(image)).toBeUndefined();
  });

  it('reads the largest instance, since one trace serves them all', () => {
    // The wheel, whose scale is the Design radius over the image's own half-extent and needs no
    // loaded part: a 48px image at radius 138 is 5.75mm a pixel.
    state.shapeKind = 'assembly';
    state.assembly.kindId = 'wheel';
    state.asmRadius = 138;
    state.scalePct = 100;
    const source = loadRaster();
    expect(rasterMmPerPixel(source.raster!.image, source.id)).toBeCloseTo(5.75, 6);

    state.artworks[0].scalePct = 40;
    expect(rasterMmPerPixel(source.raster!.image, source.id)).toBeCloseTo(2.3, 6);

    // A second, bigger placement of the same source wins: the trace they share must keep the
    // detail the larger one can print.
    addInstanceForSource(source.id, null);
    state.artworks[1].scalePct = 250;
    expect(rasterMmPerPixel(source.raster!.image, source.id)).toBeCloseTo(14.375, 6);

    // A source with no instance falls back to the global fit the load is about to apply.
    state.scalePct = 175;
    expect(rasterMmPerPixel(source.raster!.image, 'source-does-not-exist')).toBeCloseTo(10.0625, 6);
  });

  it('keeps the last measured floor when a re-quantize cannot read the placement', () => {
    state.shapeKind = 'assembly';
    state.assembly.kindId = 'wheel';
    state.asmRadius = 138;
    state.scalePct = 100;
    const source = loadRaster();
    expect(source.raster!.mmPerPixel).toBeCloseTo(5.75, 6);

    // Switch to a rect kind whose parts have not arrived: the placement is unreadable, and the
    // stored measurement is better than none.
    state.assembly.kindId = 'footrest';
    state.assembly.parts = [];
    requantizeSource(source.id, { colors: 4 });
    expect(source.raster!.mmPerPixel).toBeCloseTo(5.75, 6);
  });

  it("does not carry a part's floor onto a flat plate", () => {
    state.shapeKind = 'assembly';
    state.assembly.kindId = 'wheel';
    state.asmRadius = 138;
    state.scalePct = 100;
    const source = loadRaster();
    expect(source.raster!.mmPerPixel).toBeCloseTo(5.75, 6);

    // A plate has no printable floor of its own, so the part's must not stand in for one.
    state.shapeKind = 'disc';
    state.disc = { diameter: 80, thickness: 4 };
    requantizeSource(source.id, { colors: 4 });
    expect(source.raster!.mmPerPixel).toBeUndefined();
  });

  it('answers nothing while a rect kind is still loading its parts', () => {
    // No part, no design face to fit to. designMmPerUnit's 1:1 branch would answer 1mm per unit
    // here, which is a real answer for an SVG and a fiction for an image, and it would be saved
    // into the session as if it had been measured.
    state.shapeKind = 'assembly';
    state.assembly.kindId = 'footrest';
    state.assembly.parts = [];
    state.scalePct = 100;
    expect(rasterMmPerPixel(banded())).toBeUndefined();
  });

  it('records the floor it traced at, so a restore can reproduce it', () => {
    state.shapeKind = 'assembly';
    state.assembly.kindId = 'wheel';
    state.asmRadius = 138;
    state.scalePct = 100;
    const source = loadRaster();
    source.raster!.mmPerPixel = undefined;
    requantizeSource(source.id, { colors: 4 });
    expect(source.raster!.mmPerPixel).toBeCloseTo(5.75, 6);
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
