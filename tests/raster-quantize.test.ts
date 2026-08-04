import { describe, expect, it } from 'vitest';
import { quantize } from '../src/raster/quantize';
import { BACKGROUND } from '../src/raster/types';
import type { RasterImage } from '../src/raster/types';
import { deltaE, hexToLab, labToHex } from '../src/color';

/** Build an image from ASCII rows; '.' is fully transparent, other chars index into `colors`. */
function img(rows: string[], colors: Record<string, string>): RasterImage {
  const h = rows.length;
  const w = rows[0].length;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const ch = rows[y][x];
      if (ch === '.') continue;
      const n = parseInt(colors[ch].slice(1), 16);
      data[i] = (n >> 16) & 255;
      data[i + 1] = (n >> 8) & 255;
      data[i + 2] = n & 255;
      data[i + 3] = 255;
    }
  return { data, w, h };
}

const near = (a: string, b: string) => deltaE(hexToLab(a), hexToLab(b));

describe('labToHex', () => {
  it('round-trips sRGB exactly — a cluster of one color must come back as that color', () => {
    const cases = [
      '#000000',
      '#ffffff',
      '#ff0000',
      '#00ff00',
      '#0000ff',
      '#e63c3c',
      '#2882dc',
      '#facd50',
      '#141414',
      '#7f7f7f',
    ];
    for (const hex of cases) expect(labToHex(hexToLab(hex))).toBe(hex);
  });

  it('clamps a Lab value outside the sRGB gamut instead of emitting a malformed hex', () => {
    expect(labToHex({ l: 200, a: 120, b: -120 })).toMatch(/^#[0-9a-f]{6}$/);
    expect(labToHex({ l: -50, a: 0, b: 0 })).toBe('#000000');
  });
});

describe('quantize', () => {
  it('recovers the exact colors of a two-color image', () => {
    const map = quantize(img(['rrbb', 'rrbb'], { r: '#ff0000', b: '#0000ff' }), 2);
    expect(map.palette).toHaveLength(2);
    const sorted = [...map.palette].sort();
    expect(near(sorted[0], '#0000ff')).toBeLessThan(1);
    expect(near(sorted[1], '#ff0000')).toBeLessThan(1);
  });

  it('returns fewer colors than asked for rather than splitting one, and never duplicates', () => {
    const map = quantize(img(['rgb', 'rgb'], { r: '#ff0000', g: '#00ff00', b: '#0000ff' }), 12);
    expect(map.palette.length).toBeLessThanOrEqual(3);
    expect(new Set(map.palette).size).toBe(map.palette.length);
  });

  it('separates the palette by ΔE so the auto-merge slider has nothing to undo at its default', () => {
    // Two reds far enough apart to land in different histogram bins, but closer than the "Slight"
    // auto-merge cutoff of ΔE 3 — the case that would otherwise make the Colors slider lie.
    expect(near('#ff0000', '#ff0800')).toBeLessThan(3);
    const map = quantize(img(['rrss', 'bbbb'], { r: '#ff0000', s: '#ff0800', b: '#0000ff' }), 4);
    expect(map.palette).toHaveLength(2);
    for (let i = 0; i < map.palette.length; i++)
      for (let j = i + 1; j < map.palette.length; j++)
        expect(near(map.palette[i], map.palette[j])).toBeGreaterThanOrEqual(3);
  });

  it('leaves transparent pixels unlabelled', () => {
    const map = quantize(img(['r.r', '.r.'], { r: '#ff0000' }), 2);
    expect([...map.labels]).toEqual([0, BACKGROUND, 0, BACKGROUND, 0, BACKGROUND]);
  });

  it('throws nothing and yields an empty palette for a fully transparent image', () => {
    const map = quantize(img(['..', '..'], {}), 4);
    expect(map.palette).toEqual([]);
    expect([...map.labels].every((l) => l === BACKGROUND)).toBe(true);
  });

  it('spends no palette entry on a colour the blur invented', () => {
    // The blur exists to stop anti-aliased fringe pixels being assigned alternately (a cartoon eye
    // came back striped blue and white). It must not also decide the palette: blending two colours
    // produces a third that is nowhere in the source, and letting it win an entry costs a filament
    // slot and breaks the promise the readout makes — "a three-colour logo stays three".
    const rows = Array.from({ length: 12 }, () => 'aaaabbbbcccc');
    const source = img(rows, { a: '#ff0000', b: '#00ff00', c: '#0000ff' });

    for (const radius of [0, 1, 2]) {
      const { palette } = quantize(source, 6, radius);
      expect(palette).toHaveLength(3);
    }
  });

  it('still labels every opaque pixel when the blur shifts colours off the palette', () => {
    // Blurred fringe tones are not in the source histogram. If the lookup is built from the source
    // bins alone they miss it, fall through as BACKGROUND, and punch a transparent seam along every
    // colour boundary — a hole in the cut, not a cosmetic issue.
    const rows = Array.from({ length: 12 }, () => 'aaaaaabbbbbb');
    const { labels } = quantize(img(rows, { a: '#ff0000', b: '#0000ff' }), 4, 2);
    expect([...labels].every((l) => l !== BACKGROUND)).toBe(true);
  });

  it('is deterministic — no random seeding', () => {
    const rows = ['rgbk', 'kbgr', 'rrgg', 'bbkk'];
    const colors = { r: '#c81e1e', g: '#1ec83c', b: '#1e3cc8', k: '#141414' };
    const a = quantize(img(rows, colors), 4);
    const b = quantize(img(rows, colors), 4);
    expect(a.palette).toEqual(b.palette);
    expect([...a.labels]).toEqual([...b.labels]);
  });

  it('spreads centroids across a ramp instead of piling them at one end', () => {
    const ramp = Array.from({ length: 8 }, (_, i) => {
      const v = Math.round((i / 7) * 255);
      return labToHex(hexToLab('#' + v.toString(16).padStart(2, '0').repeat(3)));
    });
    const colors = Object.fromEntries(ramp.map((hex, i) => [String(i), hex]));
    const map = quantize(img(['01234567', '01234567'], colors), 4);
    expect(map.palette).toHaveLength(4);
    const ls = map.palette.map((h) => hexToLab(h).l).sort((a, b) => a - b);
    expect(ls[0]).toBeLessThan(30);
    expect(ls[3]).toBeGreaterThan(70);
  });
});
