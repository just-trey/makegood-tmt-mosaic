// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseSVGDocument } from '../src/svg/parse';
import { WARNINGS, clearWarnings } from '../src/warnings';

// Hex-only canvas oracle, as in parse.test.ts: jsdom has no 2d context.
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

beforeEach(() => clearWarnings());

const svg = (inner: string, rootAttrs = ''): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" ${rootAttrs}>${inner}</svg>`;
const GREEN = '<rect x="60" y="60" width="10" height="10" fill="#00ff00"/>';
const OUTLINE = '<rect width="40" height="40" stroke="#ff00ff" stroke-width="2"/>';
const ONE_STROKE =
  '1 stroke with no fill was skipped. Convert strokes to paths in your editor to print them.';
const messages = (): string[] => WARNINGS.map((w) => w.message);
const fills = (inner: string, rootAttrs = ''): string[] =>
  parseSVGDocument(svg(inner, rootAttrs)).shapes.map((s) => s.fill);

describe('an inherited fill="none"', () => {
  it('skips a Figma outline under the root fill="none", and keeps the filled shape beside it', () => {
    expect(
      fills(
        '<rect width="100" height="100" fill="#ff0000"/>' +
          '<path d="M10 10 L90 10 L90 90 L10 90 Z" stroke="#0000ff" stroke-width="4"/>',
        'fill="none"',
      ),
    ).toEqual(['#ff0000']);
    expect(messages()).toEqual([ONE_STROKE]);
  });

  it.each([
    ['a group attribute', '<g fill="none">', '</g>'],
    ['a group style', '<g style="fill: none">', '</g>'],
    ['a class rule on a group', '<style>.n { fill: none; }</style><g class="n">', '</g>'],
    ['a transparent group', '<g fill="transparent">', '</g>'],
    ['a keyword in another case, with spaces', '<g fill=" NONE ">', '</g>'],
    ['a grandparent', '<g fill="none"><g>', '</g></g>'],
    ['a nearer none overriding a farther colour', '<g fill="#123456"><g fill="none">', '</g></g>'],
    ['the shape saying inherit', '<g fill="none"><g fill="inherit">', '</g></g>'],
  ])('comes from %s, and the outline is skipped like an own fill="none"', (_n, open, close) => {
    expect(fills(`${open}${OUTLINE}${close}${GREEN}`)).toEqual(['#00ff00']);
    expect(messages()).toEqual([ONE_STROKE]);
  });

  it('skips a shape whose own fill="inherit" reaches a fill="none"', () => {
    expect(
      fills(`<g fill="none"><rect fill="inherit" width="4" height="4" stroke="#000"/></g>${GREEN}`),
    ).toEqual(['#00ff00']);
    expect(messages()).toEqual([ONE_STROKE]);
  });

  it('gives way to a nearer group colour, which the shape then prints in', () => {
    expect(fills('<g fill="none"><g fill="#123456"><rect width="4" height="4"/></g></g>')).toEqual([
      '#123456',
    ]);
    expect(fills('<rect width="4" height="4" fill="#123456"/>', 'fill="none"')).toEqual([
      '#123456',
    ]);
  });

  it('leaves the design-boundary circle out of the print and out of the stroke count', () => {
    const out = parseSVGDocument(
      svg(
        '<circle cx="50" cy="50" r="48" stroke="#000000"/>' +
          '<rect x="30" y="30" width="40" height="40" fill="#ff0000"/>',
        'fill="none"',
      ),
    );
    expect(out.rawSVGCircle?.r).toBe(48);
    expect(out.shapes.map((s) => s.fill)).toEqual(['#ff0000']);
    expect(messages()).toEqual([]);
  });

  it('raises the no-shapes error, naming the strokes, when every shape is an outline', () => {
    expect(() =>
      parseSVGDocument(svg(`${OUTLINE}<path d="M0 0 L9 9" stroke="#000"/>`, 'fill="none"')),
    ).toThrow(
      'No flat-filled shapes were found in this SVG. Skipped: 2 strokes with no fill. Convert or unlink them in your editor.',
    );
  });

  it('is not counted as a shape a hidden group took out of the print', () => {
    parseSVGDocument(
      svg(
        `<g id="h" display="none"><g fill="none"><rect width="4" height="4"/></g>` +
          `<rect width="4" height="4" fill="#ff0000"/></g>${GREEN}`,
      ),
    );
    expect(messages()).toEqual([
      'The hidden group "h" starting at shape 1 was skipped, with its 1 shape. Show it in your editor to print it.',
    ]);
  });
});

describe('the rest of the fill cascade', () => {
  it('resolves fill="inherit" to the parent\'s colour, not black', () => {
    expect(fills('<g fill="#123456"><rect fill="inherit" width="4" height="4"/></g>')).toEqual([
      '#123456',
    ]);
  });

  it("resolves currentColor to the shape's own inherited color", () => {
    expect(
      fills('<g color="#123456"><rect fill="currentColor" width="4" height="4"/></g>'),
    ).toEqual(['#123456']);
    // An inherited currentColor stays the keyword, so it reads the shape's color, not the group's.
    expect(
      fills(
        '<g fill="currentColor" color="#ff0000"><rect color="#123456" width="4" height="4"/></g>',
      ),
    ).toEqual(['#123456']);
    expect(
      fills(
        '<g color="#123456"><rect color="currentColor" fill="currentColor" width="4" height="4"/></g>',
      ),
    ).toEqual(['#123456']);
  });

  it('prints currentColor black when no color is set, as a browser does', () => {
    expect(fills('<rect fill="currentColor" width="4" height="4"/>')).toEqual(['#000000']);
  });

  it('names a gradient fill inherited from a group, instead of printing the shape black', () => {
    expect(
      fills(
        '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs>' +
          `<g fill="url(#g)"><rect width="4" height="4"/></g>${GREEN}`,
      ),
    ).toEqual(['#00ff00']);
    expect(messages()).toEqual([
      'Shape 1 (a <rect>) has a gradient/pattern fill (not a flat color), so it was skipped.',
    ]);
  });

  it('reads none in any case for text and strokes too, so neither is counted', () => {
    expect(
      fills(
        '<g fill="None"><text>a</text></g>' +
          `<rect width="4" height="4" fill="none" stroke=" NONE "/>${GREEN}`,
      ),
    ).toEqual(['#00ff00']);
    expect(messages()).toEqual([]);
  });

  it('still prints a shape with no fill anywhere above it in black', () => {
    expect(fills('<g><rect width="4" height="4"/></g>')).toEqual(['#000000']);
  });
});
