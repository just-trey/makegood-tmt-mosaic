// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyRestoredSession,
  clearSavedSession,
  loadSavedSession,
  saveSession,
} from '../src/state/persist';
import { WARNINGS } from '../src/warnings';
import type { ParsedSVG } from '../src/types';
import { clearArtwork, loadArtworkSource } from '../src/state/artwork';
import { state } from '../src/state/store';
import { parseRasterImage } from '../src/raster/parse';
import { DETAIL_DEFAULT } from '../src/raster/stats';
import type { RasterImage } from '../src/raster/types';

/**
 * jsdom has no canvas, so encodeWorkingImage returns null there and every raster source takes the
 * drop-it fallback — which is what tests/persist-raster.test.ts covers. This file stubs just
 * enough of the 2d contract to exercise the path a real browser takes.
 *
 * The stub round-trips the pixels through a data URL of its own making rather than encoding PNG,
 * so what is under test is the wiring: that the image, its settings and the un-re-derivable
 * edgeDensity all reach storage and come back.
 */
type Pixels = { data: Uint8ClampedArray; width: number; height: number };
const encoded = new Map<string, Pixels>();
function stubCanvas(): void {
  let seq = 0;
  // jsdom has no ImageData either, so the stub hands back a plain object of the same shape. Only
  // the wiring is under test; nothing here reads a pixel back through a real decoder.
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    return {
      createImageData: (w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      }),
      putImageData: (d: Pixels) => encoded.set(this.dataset.key ?? '', d),
      getImageData: () => encoded.get(this.dataset.key ?? '')!,
      drawImage: () => {},
    };
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toDataURL = function (this: HTMLCanvasElement) {
    const key = `stub:${seq++}`;
    encoded.set(key, encoded.get('')!);
    this.dataset.key = key;
    return `data:image/png;stub,${key}`;
  } as unknown as typeof HTMLCanvasElement.prototype.toDataURL;
}

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
  } as unknown as ParsedSVG;
}

function bands(w = 16, h = 16): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const left = p % w < w / 2;
    data[p * 4] = left ? 230 : 40;
    data[p * 4 + 1] = left ? 60 : 130;
    data[p * 4 + 2] = left ? 60 : 220;
    data[p * 4 + 3] = 255;
  }
  return { data, w, h, edgeDensity: 0.137 };
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
  encoded.clear();
  vi.restoreAllMocks();
  stubCanvas();
  clearArtwork();
  clearSavedSession();
  state.assembly.parts = [];
});

describe('a raster source that the browser can encode', () => {
  it('is persisted, with the settings needed to reproduce its trace', () => {
    loadRaster();
    saveSession();
    const saved = loadSavedSession();

    expect(saved).not.toBeNull();
    const src = saved!.sources.find((s) => s.name === 'photo.png');
    expect(src).toBeDefined();
    expect(src!.raster?.png).toMatch(/^data:image\/png/);
    expect(src!.raster?.colors).toBe(4);
    expect(src!.raster?.detail).toBe(DETAIL_DEFAULT);
    // Measured at a fixed reference size and NOT re-derivable from the working pixels: without it
    // restore re-measures the working image and quietly moves every threshold hanging off it.
    expect(src!.raster?.edgeDensity).toBe(0.137);
  });

  it('keeps its instances, so no placement is orphaned and none is lost', () => {
    const inst = loadRaster();
    saveSession();
    const saved = loadSavedSession()!;

    const ids = new Set(saved.sources.map((s) => s.id));
    expect(saved.artworks.some((a) => a.id === inst.id)).toBe(true);
    for (const a of saved.artworks) expect(ids.has(a.sourceId)).toBe(true);
    expect(saved.activeArtworkId).toBe(inst.id);
  });

  it('saves a session whose only design is an image', () => {
    loadRaster();
    saveSession();
    // The old behaviour was a hard null here, and the restore banner never appeared. That was
    // correct while the image could not come back; it is not any more.
    expect(loadSavedSession()).not.toBeNull();
  });

  it('carries no svgText, which restore must not try to parse', () => {
    loadRaster();
    saveSession();
    const src = loadSavedSession()!.sources.find((s) => s.name === 'photo.png')!;
    // parseSVGDocument('') throws. The restore path branches on `raster` before it parses, and
    // this is the assertion that fails if that branch is ever removed.
    expect(src.svgText).toBe('');
    expect(src.raster).toBeDefined();
  });
});

describe('a saved image that will not come back', () => {
  // jsdom decodes nothing, so `Image` is stubbed to fail the way a real browser fails an
  // unreadable data URL: onerror, promptly. decodeWorkingImage's own timeout covers the
  // environment that answers neither way, and is deliberately not what this exercises — waiting
  // it out would put 15s in the suite to test a fallback.
  it('costs that design only, never the session', async () => {
    class FailingImage {
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;
      set src(_v: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal('Image', FailingImage);

    loadArtworkSource(svgParsed(), 'drawing.svg', 'upload', 'sticker', SVG_TEXT);
    loadRaster();
    saveSession();

    // Corrupt just the image payload, as a truncated or half-written storage entry would.
    const raw = JSON.parse(localStorage.getItem('tmt-mosaic:session:v1')!);
    raw.sources = raw.sources.map((x: { raster?: { png: string } }) =>
      x.raster ? { ...x, raster: { ...x.raster, png: 'data:image/png;base64,NOTVALID' } } : x,
    );
    localStorage.setItem('tmt-mosaic:session:v1', JSON.stringify(raw));

    const session = loadSavedSession()!;
    // Must resolve, not reject. restoreBanner.ts treats a rejected restore as a dead session and
    // calls clearSavedSession(), so throwing here would destroy the SVG designs along with the
    // image — permanently, and for a fault in one payload.
    await expect(applyRestoredSession(session)).resolves.toBeUndefined();

    expect(state.sources.map((x) => x.name)).toEqual(['drawing.svg']);
    // And no placement is left pointing at the source that did not come back.
    const ids = new Set(state.sources.map((x) => x.id));
    for (const a of state.artworks) expect(ids.has(a.sourceId)).toBe(true);
    expect(WARNINGS.some((w) => /could not be restored/i.test(w.message))).toBe(true);
    // The half that matters and that an earlier version of this test missed: the SVG has to be
    // *usable*, not merely present. The image was the active selection, and leaving that id on a
    // design that did not come back makes setActiveArtwork return early, so the app renders a bare
    // part with Export disabled while the surviving artwork sits in state unselected.
    expect(state.artworks).toHaveLength(1);
    expect(state.activeArtworkId).toBe(state.artworks[0].id);
    expect(state.parsed).not.toBeNull();
  });
});
