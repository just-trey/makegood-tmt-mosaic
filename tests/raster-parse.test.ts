import { describe, expect, it } from 'vitest';
import {
  parseRasterImage,
  EmptyTraceError,
  rasterCappedMessage,
  rasterColorLossMessage,
  rasterEmptyTraceMessage,
  rasterLostColors,
} from '../src/raster/parse';
import {
  measureImage,
  autoParams,
  despeckleFloorPx,
  fracFloorPx,
  printableFloorPx,
  DETAIL_DEFAULT,
} from '../src/raster/stats';
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

/**
 * Blue and green bands under a red sprinkle: enough red pixels to win a palette entry, every one
 * of them a lone speck. Deterministic placement — the assertions on it must not flake.
 */
function sprinkled(w = 64, h = w): RasterImage {
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
  return img;
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

  describe('empty trace', () => {
    /** A single small opaque square on an otherwise transparent canvas. */
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

    // 0.05mm per working pixel puts the printable floor (64px²) well above both the dot (4px²)
    // and the fractional floor at any Detail, so the placement — not Detail — is what empties it.
    // Measured: `npx vitest run tests/raster-parse.test.ts -t "printable-floor"`.
    it('gives the printable-floor message when the placement, not Detail, emptied it', () => {
      const img = dot(256, 256, 2);
      for (const detail of [0, 50, 100]) {
        let err: unknown;
        try {
          parseRasterImage(img, { colors: 4, detail, mmPerPixel: 0.05, name: 'confetti.png' });
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(EmptyTraceError);
        expect((err as EmptyTraceError).reason).toBe('printable');
        expect((err as Error).message).toBe(rasterEmptyTraceMessage('confetti.png', 'printable'));
      }
    });

    // No placement (mmPerPixel unset) leaves only the fractional floor, which Detail does scale:
    // full-left quadruples it and despeckles the same dot that full-right leaves alone.
    it('gives the noise message when the fractional floor, not a placement, emptied it', () => {
      const img = dot(90, 90, 2);
      expect(
        parseRasterImage(img, { colors: 4, detail: 100, name: 'speck.png' }).componentCount,
      ).toBe(1);

      let err: unknown;
      try {
        parseRasterImage(img, { colors: 4, detail: 0, name: 'speck.png' });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(EmptyTraceError);
      expect((err as EmptyTraceError).reason).toBe('noise');
      expect((err as Error).message).toBe(rasterEmptyTraceMessage('speck.png', 'noise'));
    });

    it('falls back to a generic name when the caller has none', () => {
      const img = dot(90, 90, 2);
      expect(() => parseRasterImage(img, { colors: 4, detail: 0 })).toThrow(/this image/);
    });
  });

  // `palette` used to be the quantizer's own, taken before tracing, so a color that won a cluster
  // and then had every one of its components despeckled away still counted. The panel read
  // "3 colors · 2 regions", the smoke's `shown === traced` check compared a 3 against a color list
  // holding 2, and remapSettingsToPalette could carry a depth onto a hex nothing paints.
  it('reports only the colors the traced shapes actually paint', () => {
    const img = sprinkled();
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

  // `painted` drops on five of nineteen corpus sources and nothing said so
  // (docs/findings/2026-08-20-despeckle-floor.md). The trigger is measured against the colors the
  // quantizer actually labelled pixels with, never against the slider.
  describe('dropped colors', () => {
    it('counts a color the quantizer found and the trace painted nothing with', () => {
      const img = sprinkled();
      const detail = 0;
      const result = parseRasterImage(img, { colors: 4, detail });
      const quantized = quantize(img, 4, autoParams(measureImage(img), detail).blurRadius);

      expect(quantized.palette.length).toBe(3);
      expect(result.palette.length).toBe(2);
      expect(result.droppedColors).toBe(1);
      expect(rasterLostColors(result)).toBe(true);
    });

    it('counts nothing when every color the quantizer found survives', () => {
      // The same sprinkle at the default Detail, where the floor leaves the specks alone.
      const result = parseRasterImage(sprinkled(), opts);
      expect(result.palette.length).toBe(3);
      expect(result.droppedColors).toBe(0);
      expect(rasterLostColors(result)).toBe(false);
    });

    it('counts nothing when the image just has fewer colors than Colors asked for', () => {
      // Two bands at Colors 4. The palette is short of the slider and nothing was lost: no Detail
      // setting invents a third color, so the notice must not offer one.
      const result = parseRasterImage(bands(64, 64, ['#0000ff', '#00c000']), {
        colors: 4,
        detail: 0,
      });
      expect(result.palette.length).toBe(2);
      expect(result.droppedColors).toBe(0);
      expect(rasterLostColors(result)).toBe(false);
    });

    it('leaves a capped trace to its own notice', () => {
      // 1024 six-pixel blocks over two bands, plus one-pixel yellow specks: past MAX_COMPONENTS,
      // so the floor is raised, and the raise takes the yellow with it. Both notices at once would
      // tell one image to lower Detail and raise it in the same breath.
      const img = bands(320, 320, ['#0000ff', '#00c000']);
      for (let y = 1; y + 6 < 320; y += 10)
        for (let x = 1; x + 6 < 320; x += 10)
          for (let dy = 0; dy < 6; dy++)
            for (let dx = 0; dx < 6; dx++) {
              const i = ((y + dy) * 320 + (x + dx)) * 4;
              img.data[i] = 255;
              img.data[i + 1] = 0;
              img.data[i + 2] = 0;
            }
      for (let p = 0; p < 320 * 320; p++) {
        const x = p % 320,
          y = (p / 320) | 0;
        if ((x * 5 + y * 3) % 53 !== 0 || x % 2 === 0 || y % 2 === 0) continue;
        const i = p * 4;
        img.data[i] = 255;
        img.data[i + 1] = 255;
        img.data[i + 2] = 0;
      }
      const result = parseRasterImage(img, { colors: 5, detail: 100 });

      expect(result.capped).toBe(true);
      expect(result.droppedColors).toBe(1);
      expect(rasterLostColors(result)).toBe(false);
      // The cap raise puts `floorPx` (33) above the fractional floor (24) on its own. Reading the
      // reason off it would call a placement in force on an image that has none.
      expect(result.floorPx).toBeGreaterThan(
        despeckleFloorPx(
          autoParams(measureImage(img), 100, false),
          320,
          320,
          measureImage(img),
          100,
          0,
        ),
      );
      expect(result.floorReason).toBe('noise');
    });

    // A centroid can win a cluster from the source histogram and label no pixel at all, because
    // assignment resolves against the blurred copy. Nothing of it was ever traced, so there were no
    // pieces to lose and no floor to raise: counting it would offer a remedy that does nothing.
    it('counts nothing for a color that never labelled a pixel', () => {
      const img = bands(768, 768, ['#0000ff', '#00c000']);
      for (let p = 0; p < 768 * 768; p++) {
        const x = p % 768,
          y = (p / 768) | 0;
        if ((x * 5 + y * 3) % 101 !== 0 || x % 2 === 0 || y % 2 === 0) continue;
        const i = p * 4;
        img.data[i] = 255;
        img.data[i + 1] = 0;
        img.data[i + 2] = 0;
      }
      for (const detail of [0, 50, 100]) {
        const params = autoParams(measureImage(img), detail, true);
        const map = quantize(img, 4, params.blurRadius);
        const labelled = new Set(map.labels);
        const result = parseRasterImage(img, { colors: 4, detail });

        // The fixture really does exercise it: one centroid carries no pixel in the label map.
        expect(map.palette.length).toBe(3);
        expect(map.palette.filter((_, i) => !labelled.has(i))).toHaveLength(1);
        expect(result.palette.length).toBe(2);
        expect(result.droppedColors).toBe(0);
        expect(rasterLostColors(result)).toBe(false);
      }
    });

    // Placed small, the nozzle-width floor sits above the fractional one, and Detail never scales
    // that half: the color is gone at Detail 0, 50 and 100 alike, so the notice must not offer it.
    // 128px across 12.8mm gives a printable floor of 16px² against a fractional 2 at Detail 50.
    it('sends the user to the size, not to Detail, under a printable floor', () => {
      for (const detail of [0, 50, 100]) {
        const img = sprinkled(128);
        const result = parseRasterImage(img, { colors: 4, detail, mmPerPixel: 0.1 });

        expect(result.droppedColors).toBe(1);
        expect(result.floorReason).toBe('printable');
        expect(rasterLostColors(result)).toBe(true);
        const text = rasterColorLossMessage('a.png', result.droppedColors, result.floorReason);
        expect(text).toContain('Make the design or the part bigger.');
        expect(text).not.toContain('Detail');
      }
    });

    // Not "on a part": a part-scale placement runs the other way. 512px across 185mm (0.361mm per
    // pixel) has a sub-pixel printable floor against a fractional 39, so Detail is still the answer.
    it('still asks for Detail at part scale, where the fractional floor binds', () => {
      const result = parseRasterImage(sprinkled(512), {
        colors: 4,
        detail: DETAIL_DEFAULT,
        mmPerPixel: 0.361,
      });

      expect(printableFloorPx(0.361)).toBeLessThan(
        fracFloorPx(autoParams(measureImage(sprinkled(512)), DETAIL_DEFAULT, true), 512, 512),
      );
      expect(result.droppedColors).toBe(1);
      expect(result.floorReason).toBe('noise');
      expect(rasterColorLossMessage('a.png', 1, result.floorReason)).toContain('Raise Detail');
    });

    it('names one dropped color in the singular and more in the plural', () => {
      expect(rasterColorLossMessage('a.png', 1, 'noise')).toContain(
        '1 color in "a.png" was dropped.',
      );
      expect(rasterColorLossMessage('a.png', 3, 'noise')).toContain(
        '3 colors in "a.png" were dropped.',
      );
    });

    it('tells the user to raise Detail under the floor Detail scales', () => {
      expect(parseRasterImage(sprinkled(), { colors: 4, detail: 0 }).floorReason).toBe('noise');
      expect(rasterColorLossMessage('a.png', 1, 'noise')).toContain('Raise Detail');
      // …which is the opposite of what the capped notice, its mutually exclusive sibling, asks for.
      expect(rasterCappedMessage('a.png')).toContain('lower Detail');
    });
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

  it('gives an enlarged image exactly the detail-pass compensation, never the lerped share on top', () => {
    // A cartoon measuring partway to photographic (mario, 0.253) used to pick up a lerped blur on
    // top of the detail-pass compensation. That blur widened every anti-aliased line boundary into
    // a band that quantized to a third color: a brown fringe on every black outline.
    expect(autoParams({ edgeDensity: 0.253 }, DETAIL_DEFAULT, true).blurRadius).toBe(1);
    // Worked at its own size, the same image keeps the lerped blur it always had: that case
    // was not in the measurement and has no detail-pass compensation to fall back on.
    expect(autoParams({ edgeDensity: 0.253 }, DETAIL_DEFAULT, false).blurRadius).toBe(1);
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

describe('despeckleFloorPx', () => {
  const flat = { edgeDensity: 0.05 };
  const photo = { edgeDensity: 0.8 };
  const p = (stats: { edgeDensity: number }) => autoParams(stats, DETAIL_DEFAULT, true);
  const w = 1024,
    h = 768;

  it('falls back to the fractional floor when the placement is unknown', () => {
    const frac = Math.round(p(flat).despeckleFrac * w * h);
    expect(despeckleFloorPx(p(flat), w, h, flat, DETAIL_DEFAULT, 0)).toBe(frac);
    expect(despeckleFloorPx(p(flat), w, h, flat, DETAIL_DEFAULT, NaN)).toBe(frac);
  });

  it('sizes flat art placed large in mm, below the fraction', () => {
    // 0.27mm per working pixel is the wheel at full size. The fractional floor there is tens of
    // square millimetres of print; the mm floor keeps everything down to the printable band.
    const floor = despeckleFloorPx(p(flat), w, h, flat, DETAIL_DEFAULT, 0.27);
    const frac = Math.round(p(flat).despeckleFrac * w * h);
    expect(floor).toBeLessThan(frac);
    expect(floor).toBeGreaterThanOrEqual(printableFloorPx(0.27));
  });

  it('keeps the #217 raise on a small placement', () => {
    // 0.01mm per pixel, coarser-floored than even the smallest hubcap (0.03), puts the printable
    // floor over the fraction, and the raise wins.
    const frac = Math.round(p(flat).despeckleFrac * w * h);
    const floor = despeckleFloorPx(p(flat), w, h, flat, DETAIL_DEFAULT, 0.01);
    expect(printableFloorPx(0.01)).toBeGreaterThan(frac);
    expect(floor).toBe(printableFloorPx(0.01));
  });

  it('leaves photographs on the fractional floor at any placement', () => {
    const frac = Math.round(p(photo).despeckleFrac * w * h);
    expect(despeckleFloorPx(p(photo), w, h, photo, DETAIL_DEFAULT, 0.27)).toBe(frac);
  });
});
