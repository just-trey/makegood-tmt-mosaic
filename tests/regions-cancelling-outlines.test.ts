// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSVGDocument } from '../src/svg/parse';
import { computeNetRegionsByColor } from '../src/geometry/regions';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// jsdom has no 2d canvas; a hex-only fillStyle oracle is all these fixtures need.
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

const svg = (inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${inner}</svg>`;
const BOW_TIE = '<polygon points="10,10 90,90 90,10 10,90" fill="#ff0000"/>';
const SQUARE = '<rect x="0" y="0" width="5" height="5" fill="#00ff00"/>';
// Two circles' worth of lemniscate, one subpath: the lobes wind opposite ways and cancel exactly.
const infinity = (cx: number, cy: number) => {
  const pts: string[] = [];
  for (let i = 0; i < 64; i++) {
    const t = (i / 64) * 2 * Math.PI;
    pts.push(`${cx + 20 * Math.sin(t)} ${cy + 10 * Math.sin(t) * Math.cos(t)}`);
  }
  return `M${pts.join(' L')} Z`;
};

const build = async (inner: string) =>
  computeNetRegionsByColor(parseSVGDocument(svg(inner)).shapes, () => {});

describe('outlines whose halves cancel out', () => {
  it('counts an equal bow-tie that leaves nothing to cut', async () => {
    const { byColor, cancelledOutlines } = await build(BOW_TIE);
    expect(Object.keys(byColor)).toEqual([]);
    expect(cancelledOutlines).toBe(1);
  });

  it('counts it beside other shapes, which still cut', async () => {
    const { byColor, cancelledOutlines } = await build(SQUARE + BOW_TIE);
    expect(Object.keys(byColor)).toEqual(['#00ff00']);
    expect(cancelledOutlines).toBe(1);
  });

  it('counts every cancelled outline', async () => {
    const r = await build(BOW_TIE + `<path d="${infinity(50, 20)}" fill="#0000ff"/>` + BOW_TIE);
    expect(r.cancelledOutlines).toBe(3);
  });

  it('counts one cancelled subpath inside a path that otherwise cuts', async () => {
    const d = `M0 0 L40 0 L40 40 L0 40 Z ${infinity(70, 70)}`;
    const { byColor, cancelledOutlines } = await build(`<path d="${d}" fill="#ff0000"/>`);
    expect(Object.keys(byColor)).toEqual(['#ff0000']);
    expect(cancelledOutlines).toBe(1);
  });

  it.each([
    ['an unequal bow-tie', '<polygon points="10,10 90,90 90,30 10,90" fill="#ff0000"/>'],
    ['a pentagram', '<polygon points="50,5 79,95 2,40 98,40 21,95" fill="#ff0000"/>'],
    [
      'overlapping subpaths',
      '<path d="M0 0 L40 0 L40 40 L0 40 Z M20 20 L60 20 L60 60 L20 60 Z" fill="#ff0000"/>',
    ],
    // Empty in a browser too: a line and an out-and-back trace fill nothing.
    ['a zero-width line subpath', '<path d="M0 0 L40 0 L40 40 Z M50 50 L90 50 Z" fill="#ff0000"/>'],
    [
      'a square traced there and back',
      '<path d="M0 0 L40 0 L40 40 L0 40 L0 0 L0 40 L40 40 L40 0 Z" fill="#ff0000"/>',
    ],
  ])('counts none in %s', async (_name, inner) => {
    expect((await build(inner)).cancelledOutlines).toBe(0);
  });

  it('keeps the count on a cache hit, so a rebuild with the same shapes still says it', async () => {
    const shapes = parseSVGDocument(svg(SQUARE + BOW_TIE)).shapes;
    const first = await computeNetRegionsByColor(shapes, () => {});
    const second = await computeNetRegionsByColor(shapes, () => {});
    expect(second).toBe(first);
    expect(second.cancelledOutlines).toBe(1);
  });

  it.each(readdirSync(path.join(REPO, 'tests/fixtures/patterns')))(
    'counts none in the shipped %s pattern',
    async (file) => {
      const text = readFileSync(path.join(REPO, 'tests/fixtures/patterns', file), 'utf8');
      const { cancelledOutlines } = await computeNetRegionsByColor(
        parseSVGDocument(text).shapes,
        () => {},
      );
      expect(cancelledOutlines).toBe(0);
    },
  );
});
