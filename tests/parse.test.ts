// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { normalizeColor, parseSVGDocument } from '../src/svg/parse';

// jsdom has no 2d canvas without the native `canvas` package, so normalizeColor's color
// oracle would return null and every fill would collapse to #000000. Stub just enough of
// the canvas fillStyle contract (normalize valid hex, keep previous value on invalid input)
// to exercise the parser's cascade/fallback logic with hex fills.
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
        else if (/^#[0-9a-f]{3}$/.test(str))
          value =
            '#' +
            str
              .slice(1)
              .split('')
              .map((c) => c + c)
              .join('');
      },
    };
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

const svg = (inner: string, attrs = ''): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`;

describe('parseSVGDocument', () => {
  it('parses a filled rect into one closed loop with the right bbox', () => {
    const out = parseSVGDocument(svg('<rect x="2" y="3" width="10" height="4" fill="#ff0000"/>'));
    expect(out.shapes).toHaveLength(1);
    expect(out.shapes[0].fill).toBe('#ff0000');
    expect(out.shapes[0].loops[0][0]).toEqual({ x: 2, y: 3 });
    expect(out.bbox).toEqual({ minX: 2, minY: 3, maxX: 12, maxY: 7 });
  });

  it('bakes the viewBox origin into coordinates', () => {
    const out = parseSVGDocument(
      svg('<rect x="10" y="20" width="5" height="5" fill="#ff0000"/>', 'viewBox="10 20 100 100"'),
    );
    expect(out.shapes[0].loops[0][0]).toEqual({ x: 0, y: 0 });
  });

  it('bakes nested group transforms into coordinates', () => {
    const out = parseSVGDocument(
      svg(
        '<g transform="translate(5,7)"><rect x="0" y="0" width="2" height="2" fill="#ff0000"/></g>',
      ),
    );
    expect(out.shapes[0].loops[0][0]).toEqual({ x: 5, y: 7 });
  });

  it('ignores shapes inside defs and shapes with gradient or no fill', () => {
    const out = parseSVGDocument(
      svg(
        '<defs><rect width="9" height="9" fill="#111111"/></defs>' +
          '<rect width="4" height="4" fill="url(#grad)"/>' +
          '<rect width="4" height="4" fill="none"/>' +
          '<rect width="4" height="4" fill="#ff0000" fill-opacity="0"/>' +
          '<rect width="4" height="4" fill="#00ff00"/>',
      ),
    );
    expect(out.shapes).toHaveLength(1);
    expect(out.shapes[0].fill).toBe('#00ff00');
  });

  it('resolves fills through <style> class rules, with inline style winning', () => {
    const out = parseSVGDocument(
      svg(
        '<style>.a { fill: #00ff00; }</style>' +
          '<rect class="a" width="4" height="4"/>' +
          '<rect class="a" style="fill:#0000ff" width="4" height="4"/>',
      ),
    );
    expect(out.shapes.map((s) => s.fill)).toEqual(['#00ff00', '#0000ff']);
  });

  it('inherits fill from an ancestor group', () => {
    const out = parseSVGDocument(svg('<g fill="#123456"><rect width="4" height="4"/></g>'));
    expect(out.shapes[0].fill).toBe('#123456');
  });

  it('closes polygon point lists into loops', () => {
    const out = parseSVGDocument(svg('<polygon points="0,0 10,0 10,10" fill="#ff0000"/>'));
    const loop = out.shapes[0].loops[0];
    expect(loop[0]).toEqual(loop[loop.length - 1]);
    expect(loop).toHaveLength(4);
  });

  it('reports the largest circle for assembly-mode anchoring', () => {
    const out = parseSVGDocument(
      svg(
        '<circle cx="1" cy="1" r="2" fill="#ff0000"/>' +
          '<circle cx="50" cy="40" r="30" fill="#00ff00"/>',
      ),
    );
    expect(out.rawSVGCircle).toEqual({ cx: 50, cy: 40, r: 30 });
  });

  it('throws when no flat-filled shapes exist', () => {
    expect(() => parseSVGDocument(svg('<rect width="4" height="4" fill="none"/>'))).toThrow(
      /No flat-filled shapes/,
    );
  });
});

describe('normalizeColor', () => {
  it('normalizes hex forms and treats none/transparent as null', () => {
    expect(normalizeColor('#FF0000')).toBe('#ff0000');
    expect(normalizeColor('#0f0')).toBe('#00ff00');
    expect(normalizeColor('none')).toBeNull();
    expect(normalizeColor('transparent')).toBeNull();
    expect(normalizeColor(null)).toBeNull();
  });
});
