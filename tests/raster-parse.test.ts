import { describe, expect, it } from 'vitest';
import { parseRasterImage } from '../src/raster/parse';
import { measureImage, autoParams, DETAIL_DEFAULT } from '../src/raster/stats';
import { quantize } from '../src/raster/quantize';
import type { RasterImage } from '../src/raster/types';
import { deltaE, hexToLab } from '../src/color';

/** Solid blocks of flat color, laid out as vertical bands across an opaque frame. */
function bands(w: number, h: number, colors: string[], alpha = 255): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const n = parseInt(colors[Math.floor((x / w) * colors.length)].slice(1), 16);
      data[i] = (n >> 16) & 255;
      data[i + 1] = (n >> 8) & 255;
      data[i + 2] = n & 255;
      data[i + 3] = alpha;
    }
  return { data, w, h };
}

const opts = { colors: 4, detail: DETAIL_DEFAULT };

describe('parseRasterImage', () => {
  it('produces the same ParsedSVG shape the SVG parser does', () => {
    const img = bands(32, 32, ['#ff0000', '#00ff00', '#0000ff']);
    const { parsed, palette } = parseRasterImage(img, opts);

    expect(parsed.shapes.length).toBeGreaterThan(0);
    expect(parsed.rawSVGCircle).toBeNull();
    expect(parsed.userUnitMM).toBeNull();
    expect(parsed.viewBox).toEqual({ w: 32, h: 32 });
    expect(parsed.canvas).toEqual({ w: 32, h: 32 });
    expect(parsed.bbox).toEqual({ minX: 0, minY: 0, maxX: 32, maxY: 32 });
    expect(palette.length).toBe(3);
  });

  it('emits fills in the same canonical hex form as an SVG fill', () => {
    const { parsed } = parseRasterImage(bands(24, 24, ['#ff0000', '#0000ff']), opts);
    for (const shape of parsed.shapes) expect(shape.fill).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('groups every component of one color into a single shape by default', () => {
    // Two separate red blocks either side of a blue one — one red shape, holding both.
    const { parsed } = parseRasterImage(bands(24, 24, ['#ff0000', '#0000ff', '#ff0000']), opts);
    const reds = parsed.shapes.filter((s) => deltaE(hexToLab(s.fill), hexToLab('#ff0000')) < 10);
    expect(reds).toHaveLength(1);
    expect(reds[0].loops.length).toBeGreaterThanOrEqual(2);
  });

  it('emits one shape per component under the component granularity', () => {
    const img = bands(24, 24, ['#ff0000', '#0000ff', '#ff0000']);
    const byColor = parseRasterImage(img, opts, 'color');
    const byComponent = parseRasterImage(img, opts, 'component');
    expect(byComponent.parsed.shapes.length).toBeGreaterThan(byColor.parsed.shapes.length);
    expect(byComponent.parsed.shapes.length).toBe(byComponent.componentCount);
  });

  it('orders shapes largest-area first', () => {
    const { parsed } = parseRasterImage(bands(32, 32, ['#ff0000', '#00ff00', '#0000ff']), opts);
    expect(parsed.shapes.map((s) => s.order)).toEqual(parsed.shapes.map((_, i) => i));
  });

  it('throws on a fully transparent image rather than loading an empty design', () => {
    expect(() => parseRasterImage(bands(8, 8, ['#ff0000'], 0), opts)).toThrow(/nothing to cut/);
  });

  // `palette` used to be the quantizer's own, taken before tracing, so a color that won a cluster
  // and then had every one of its components despeckled away still counted. The panel read
  // "3 colors · 2 regions", the smoke's `shown === traced` check compared a 3 against a color list
  // holding 2, and remapSettingsToPalette could carry a depth onto a hex nothing paints.
  it('reports only the colors the traced shapes actually paint', () => {
    // A red sprinkle: enough pixels to win a palette entry, every one of them a lone speck the
    // despeckle floor absorbs. Deterministic placement — this assertion must not flake.
    const w = 64,
      h = 64;
    const img = bands(w, h, ['#0000ff', '#00c000']);
    for (let p = 0; p < w * h; p++) {
      const x = p % w,
        y = (p / w) | 0;
      if ((x * 5 + y * 3) % 17 !== 0 || x % 2 === 0 || y % 2 === 0) continue;
      const i = p * 4;
      img.data[i] = 255;
      img.data[i + 1] = 0;
      img.data[i + 2] = 0;
    }
    // Detail full-left quadruples the despeckle floor, so a one-pixel speck cannot survive it.
    const detail = 0;
    const { parsed, palette } = parseRasterImage(img, { colors: 4, detail });
    const painted = new Set(parsed.shapes.map((s) => s.fill));
    expect(palette.length).toBe(painted.size);
    for (const hex of palette) expect(painted.has(hex)).toBe(true);

    // …and the fixture really does exercise it: the quantizer found a color the trace then lost.
    const quantized = quantize(img, 4, autoParams(measureImage(img), detail).blurRadius);
    expect(quantized.palette.length).toBeGreaterThan(palette.length);
  });

  it('keeps the palette in the quantizer order it narrows', () => {
    const { parsed, palette } = parseRasterImage(bands(32, 32, ['#ff0000', '#0000ff']), opts);
    expect(palette).toEqual(
      [...new Set(parsed.shapes.map((s) => s.fill))].sort(byPalette(palette)),
    );
  });
});

/** Compare two hexes by their position in `palette` — used only to state "same set, same order". */
function byPalette(palette: string[]) {
  return (a: string, b: string) => palette.indexOf(a) - palette.indexOf(b);
}

describe('measureImage / autoParams', () => {
  it('reads flat color bands as flat art and per-pixel noise as photographic', () => {
    const flat = measureImage(bands(64, 64, ['#ff0000', '#00ff00', '#0000ff']));

    const w = 64,
      h = 64;
    const data = new Uint8ClampedArray(w * h * 4);
    // A deterministic hash, not Math.random — the assertions below must not flake.
    for (let p = 0; p < w * h; p++) {
      const v = (p * 2654435761) >>> 0;
      data[p * 4] = v & 255;
      data[p * 4 + 1] = (v >>> 8) & 255;
      data[p * 4 + 2] = (v >>> 16) & 255;
      data[p * 4 + 3] = 255;
    }
    const noisy = measureImage({ data, w, h });

    expect(flat.edgeDensity).toBeLessThan(0.12);
    expect(noisy.edgeDensity).toBeGreaterThan(0.45);
  });

  it('despeckles and smooths harder for a photographic image than for flat art', () => {
    const flat = autoParams({ edgeDensity: 0.02 });
    const photo = autoParams({ edgeDensity: 0.8 });
    expect(photo.blurRadius).toBeGreaterThan(flat.blurRadius);
    expect(photo.despeckleFrac).toBeGreaterThan(flat.despeckleFrac);
    expect(photo.flatness).toBeGreaterThan(flat.flatness);
    // Flat art keeps corners the photo path is happy to round off — a logo's square edge is a real
    // feature, the same angle in a photograph is usually quantization noise.
    expect(photo.alphaMax).toBeGreaterThan(flat.alphaMax);
  });

  it('only blurs flat art when the detail pass actually gave up a downscale', () => {
    // The blur replaces the low-pass a 3:1 downscale used to provide. An image too small for the
    // detail pass to enlarge was not downscaled harder before either, so there is nothing to
    // replace — and blurring it anyway erased thirteen of fourteen dark pixels on 12x12 pixel art,
    // taking an isolated pixel, a one-pixel cross and an eight-pixel bar with it.
    const flat = { edgeDensity: 0.05 };
    expect(autoParams(flat, DETAIL_DEFAULT, false).blurRadius).toBe(0);
    expect(autoParams(flat, DETAIL_DEFAULT, true).blurRadius).toBe(1);
    // A photograph is never enlarged, so it never picks the compensation up.
    expect(autoParams({ edgeDensity: 0.8 }, DETAIL_DEFAULT, false).blurRadius).toBe(2);
  });

  it('lets the Detail slider pull the auto-derived strength both ways', () => {
    const mid = autoParams({ edgeDensity: 0.3 }, DETAIL_DEFAULT);
    const bolder = autoParams({ edgeDensity: 0.3 }, 0);
    const finer = autoParams({ edgeDensity: 0.3 }, 100);
    expect(bolder.despeckleFrac).toBeGreaterThan(mid.despeckleFrac);
    expect(finer.despeckleFrac).toBeLessThan(mid.despeckleFrac);
    expect(finer.flatness).toBeLessThan(mid.flatness);
    // alphaMax deliberately doesn't move with Detail: it decides corner-vs-curve, not how much
    // detail survives, and its useful range is too narrow to take a 4x multiplier.
    expect(finer.alphaMax).toBe(mid.alphaMax);
    expect(bolder.alphaMax).toBe(mid.alphaMax);
  });
});
