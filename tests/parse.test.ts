// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { normalizeColor, parseSVGDocument, svgLengthToMM } from '../src/svg/parse';

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

  it('derives userUnitMM from physical size / viewBox (rect placement scale)', () => {
    // 266mm wide across a 266-unit viewBox -> 1mm per unit
    const oneToOne = parseSVGDocument(
      svg('<rect width="10" height="10" fill="#ff0000"/>', 'width="266mm" viewBox="0 0 266 185"'),
    );
    expect(oneToOne.userUnitMM).toBeCloseTo(1, 9);

    // same physical width but an editor re-exported the viewBox at ~96dpi px -> ~0.2646mm per unit,
    // so the artwork still lands life-size instead of ~3.78x too big
    const pxReexport = parseSVGDocument(
      svg(
        '<rect width="10" height="10" fill="#ff0000"/>',
        'width="266mm" viewBox="0 0 1005.165 699.212"',
      ),
    );
    expect(pxReexport.userUnitMM).toBeCloseTo(266 / 1005.165, 9);
  });

  it('leaves userUnitMM null when the SVG declares no absolute size', () => {
    const out = parseSVGDocument(
      svg('<rect width="10" height="10" fill="#ff0000"/>', 'viewBox="0 0 100 100"'),
    );
    expect(out.userUnitMM).toBeNull();
  });

  it('does not collapse to a zero scale when width/height is 0', () => {
    // width="0" must not derive userUnitMM = 0/vbW = 0 (which maps all artwork onto one point);
    // it falls back to the other axis, or null when neither gives a usable size.
    const heightFallback = parseSVGDocument(
      svg(
        '<rect width="10" height="10" fill="#ff0000"/>',
        'width="0" height="185mm" viewBox="0 0 266 185"',
      ),
    );
    expect(heightFallback.userUnitMM).toBeCloseTo(1, 9);

    const both = parseSVGDocument(
      svg('<rect width="10" height="10" fill="#ff0000"/>', 'width="0" viewBox="0 0 266 185"'),
    );
    expect(both.userUnitMM).toBeNull();
  });

  it('uses the smaller (meet) scale when width/height proportions disagree with the viewBox', () => {
    // 266mm/266 = 1 across, 100mm/185 ≈ 0.54 down — no single true scale, so uniform-fit ("meet")
    // takes the smaller so the design lands inside the declared box rather than stretched by width.
    const out = parseSVGDocument(
      svg(
        '<rect width="10" height="10" fill="#ff0000"/>',
        'width="266mm" height="100mm" viewBox="0 0 266 185"',
      ),
    );
    expect(out.userUnitMM).toBeCloseTo(100 / 185, 9);
  });
});

describe('svgLengthToMM', () => {
  it('converts absolute units to mm', () => {
    expect(svgLengthToMM('266mm')).toBeCloseTo(266, 9);
    expect(svgLengthToMM('2cm')).toBeCloseTo(20, 9);
    expect(svgLengthToMM('1in')).toBeCloseTo(25.4, 9);
    expect(svgLengthToMM('96px')).toBeCloseTo(25.4, 9);
    expect(svgLengthToMM('96')).toBeCloseTo(25.4, 9); // unitless = px
    expect(svgLengthToMM('72pt')).toBeCloseTo(25.4, 9);
  });

  it('returns null for relative, empty, or non-numeric lengths', () => {
    expect(svgLengthToMM('100%')).toBeNull();
    expect(svgLengthToMM('')).toBeNull();
    expect(svgLengthToMM(null)).toBeNull();
    expect(svgLengthToMM('auto')).toBeNull();
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
