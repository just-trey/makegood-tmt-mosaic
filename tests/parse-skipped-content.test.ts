// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATE_INKS, parseSVGDocument } from '../src/svg/parse';
import { WARNINGS, clearWarnings } from '../src/warnings';
import { hubcapTemplateSvg } from '../src/geometry/hubcap';
import { insideEveryEdge } from '../src/svg/clip';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Read as text, not imported: the template generators' plain .mjs has no type declarations.
const svgStyle = readFileSync(path.join(REPO, 'scripts/lib/svgstyle.mjs'), 'utf8');
const inkOf = (name: string): string => {
  const m = new RegExp(`export const ${name} = '(#[0-9a-fA-F]{6})'`).exec(svgStyle);
  if (!m) throw new Error(`${name} not found in scripts/lib/svgstyle.mjs`);
  return m[1].toLowerCase();
};
const GRAY = inkOf('GRAY');
const ACCENT = inkOf('ACCENT');

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

const svg = (inner: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100">${inner}</svg>`;
const FILLED = '<rect x="60" y="60" width="10" height="10" fill="#00ff00"/>';
const messages = (): string[] => WARNINGS.map((w) => w.message);
const load = (inner: string): string[] => {
  parseSVGDocument(svg(inner));
  return messages();
};

const MASK = (n: string) =>
  `Masks aren't applied, so ${n} uncropped and can cover other colors. Crop the masked shapes in your editor.`;

describe('a clipping mask or mask', () => {
  const CLIP20 = '<clipPath id="c"><rect width="20" height="20"/></clipPath>';

  it('names a shape it would have cropped, which prints at full size', () => {
    const out = parseSVGDocument(
      svg(`${CLIP20}<g clip-path="url(#c)"><rect width="100" height="100" fill="#0000ff"/></g>`),
    );
    expect(out.shapes).toHaveLength(1);
    expect(messages()).toEqual([MASK('1 shape prints')]);
  });

  it('reads clip-path from style and from a class rule, and counts every cropped shape once', () => {
    expect(
      load(
        `<style>.k { clip-path: url(#c) }</style>${CLIP20}` +
          `<g style="clip-path:url(#c)"><rect width="50" height="50" fill="#0000ff"/>` +
          `<g class="k"><rect width="60" height="60" fill="#ff0000"/></g></g>`,
      ),
    ).toEqual([MASK('2 shapes print')]);
  });

  it('stays quiet when the clip is an artboard-sized rectangle that crops nothing', () => {
    expect(
      load(
        '<defs><clipPath id="a"><rect width="100" height="100"/></clipPath></defs>' +
          '<g clip-path="url(#a)"><rect width="100" height="100" fill="#0000ff"/>' +
          '<circle cx="50" cy="50" r="20" fill="#ff0000"/></g>',
      ),
    ).toEqual([]);
  });

  it('stays quiet when a shape edge meets the clip edge after rounding', () => {
    // 3 x 0.3 is 0.8999999999999999: the clip lands a hair inside the 0.9 edge it was drawn on.
    expect(
      load(
        '<clipPath id="s"><rect width="3" height="3" transform="scale(0.3)"/></clipPath>' +
          '<rect width="0.9" height="0.9" fill="#0000ff" clip-path="url(#s)"/>',
      ),
    ).toEqual([]);
  });

  it("places the clip in the element's own coordinates, transform included", () => {
    // The clip moves with the group, so nothing is cropped. Placed with the parent's matrix it
    // would sit at 0..20 while the rect is at 50..70.
    expect(
      load(
        `${CLIP20}<g transform="translate(50 0)" clip-path="url(#c)"><rect width="20" height="20" fill="#0000ff"/></g>`,
      ),
    ).toEqual([]);
  });

  it('counts only the shapes that reach outside the clip', () => {
    expect(
      load(
        `${CLIP20}<g clip-path="url(#c)"><rect width="10" height="10" fill="#0000ff"/>` +
          `<rect width="30" height="30" fill="#ff0000"/></g>`,
      ),
    ).toEqual([MASK('1 shape prints')]);
  });

  it('warns on any <mask>, which hides by brightness and is never proven harmless', () => {
    expect(
      load(
        '<mask id="m"><rect width="100" height="100" fill="#ffffff"/></mask>' +
          '<rect width="50" height="50" fill="#0000ff" mask="url(#m)"/>',
      ),
    ).toEqual([MASK('1 shape prints')]);
  });

  it('warns on a mask even beside a clip that crops nothing', () => {
    expect(
      load(
        '<clipPath id="a"><rect width="100" height="100"/></clipPath>' +
          '<mask id="m"><rect width="100" height="100" fill="#ffffff"/></mask>' +
          '<rect width="50" height="50" fill="#0000ff" clip-path="url(#a)" mask="url(#m)"/>',
      ),
    ).toEqual([MASK('1 shape prints')]);
  });

  it('warns on a clip it cannot measure: a CSS shape, or one sized to the shape', () => {
    expect(load('<rect width="50" height="50" fill="#0000ff" clip-path="inset(10px)"/>')).toEqual([
      MASK('1 shape prints'),
    ]);
    clearWarnings();
    expect(
      load(
        // Half the shape's own box, so it crops; read as plain units it would hold the whole shape.
        '<clipPath id="b" clipPathUnits="objectBoundingBox"><rect width="0.5" height="0.5"/></clipPath>' +
          '<rect width="0.4" height="0.4" fill="#0000ff" clip-path="url(#b)"/>',
      ),
    ).toEqual([MASK('1 shape prints')]);
  });

  it("warns under a clip that isn't convex, even with every corner of the shape inside it", () => {
    // An L-shaped clip; the triangle's long edge crosses the L's missing corner.
    expect(
      load(
        '<clipPath id="l"><polygon points="0,0 100,0 100,50 50,50 50,100 0,100"/></clipPath>' +
          '<polygon points="10,95 95,10 10,10" fill="#0000ff" clip-path="url(#l)"/>',
      ),
    ).toEqual([MASK('1 shape prints')]);
  });

  it("stays quiet under a clip that isn't convex when the shape sits clear of its missing corner", () => {
    expect(
      load(
        '<clipPath id="l"><polygon points="0,0 100,0 100,50 50,50 50,100 0,100"/></clipPath>' +
          '<rect width="40" height="40" fill="#0000ff" clip-path="url(#l)"/>',
      ),
    ).toEqual([]);
  });

  it('warns under a clip with a hole, whether the shape spans the hole or sits in it', () => {
    const holed = (rule: string) =>
      `<clipPath id="d"><path ${rule} d="M0 0H100V100H0Z M40 40H60V60H40Z"/></clipPath>`;
    expect(
      load(
        `${holed('clip-rule="evenodd"')}<rect width="100" height="100" fill="#0000ff" clip-path="url(#d)"/>`,
      ),
    ).toEqual([MASK('1 shape prints')]);
    clearWarnings();
    expect(
      load(
        `${holed('clip-rule="evenodd"')}<rect x="45" y="45" width="10" height="10" fill="#0000ff" clip-path="url(#d)"/>`,
      ),
    ).toEqual([MASK('1 shape prints')]);
  });

  it('stays quiet when clip-path or mask names an element of the wrong kind, which a browser ignores', () => {
    expect(
      load(
        '<defs><rect id="r" width="5" height="5"/><clipPath id="c"><rect width="5" height="5"/></clipPath></defs>' +
          '<rect width="50" height="50" fill="#0000ff" clip-path="url(#r)"/>' +
          '<rect width="50" height="50" fill="#ff0000" mask="url(#c)"/>',
      ),
    ).toEqual([]);
  });

  it('stays quiet when nothing under it imports, or the reference points nowhere', () => {
    expect(
      load(
        `${CLIP20}<g clip-path="url(#c)"><rect width="99" height="99" fill="#0000ff" opacity="0"/></g>${FILLED}`,
      ),
    ).toEqual([]);
    expect(load('<rect width="50" height="50" fill="#0000ff" clip-path="url(#nope)"/>')).toEqual(
      [],
    );
  });
});

describe('insideEveryEdge', () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
    { x: 0, y: 0 },
  ];

  it('accepts points inside or on the edge, in either winding', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 5, y: 10 },
      { x: 3, y: 4 },
    ];
    expect(insideEveryEdge(square, pts)).toBe(true);
    expect(insideEveryEdge([...square].reverse(), pts)).toBe(true);
    expect(insideEveryEdge(square, [{ x: 10.01, y: 5 }])).toBe(false);
  });

  it('proves nothing for a star drawn point to point, which turns one way but goes round twice', () => {
    const star = [0, 2, 4, 1, 3].map((k) => ({
      x: 50 + 40 * Math.cos((k * 2 * Math.PI) / 5),
      y: 50 + 40 * Math.sin((k * 2 * Math.PI) / 5),
    }));
    expect(insideEveryEdge(star, [{ x: 50, y: 50 }])).toBe(false);
  });
});

describe('a linked copy (<use>)', () => {
  const DEF = '<defs><rect id="r" width="30" height="30" fill="#ff0000"/></defs>';

  it('is named with a count, never imported', () => {
    expect(() => parseSVGDocument(svg(`${DEF}<use href="#r" x="10" y="10"/>`))).toThrow();
    expect(load(`${DEF}<use href="#r"/><use xlink:href="#r" x="40"/>${FILLED}`)).toEqual([
      '2 linked copies were skipped. Unlink clones and symbols in your editor to print them.',
    ]);
  });

  it('stays quiet inside defs or a hidden group', () => {
    expect(
      load(
        `<defs><rect id="r" width="3" height="3"/><use href="#r"/></defs>` +
          `<g display="none"><use href="#r"/></g><use href="#r" opacity="0"/>` +
          `<use href="#r" display="none"/>${FILLED}`,
      ),
    ).toEqual([]);
  });
});

describe('text', () => {
  it('is named once per text object, tspans included', () => {
    expect(
      load(
        `<text fill="#ffffff">TMT</text><text>A<tspan>B</tspan><tspan>C</tspan></text>${FILLED}`,
      ),
    ).toEqual([
      '2 text objects were skipped. Convert text to outlines in your editor to print it.',
    ]);
  });

  it('stays quiet when the text would draw nothing', () => {
    expect(
      load(
        '<text display="none">a</text><text opacity="0">b</text><text fill="none">c</text>' +
          `<g style="display:none"><text>d</text></g><text fill="#000" fill-opacity="0">e</text>${FILLED}`,
      ),
    ).toEqual([]);
  });

  it('counts outline-only text: a stroke draws it', () => {
    expect(load(`<text fill="none" stroke="#000000">a</text>${FILLED}`)).toEqual([
      '1 text object was skipped. Convert text to outlines in your editor to print it.',
    ]);
  });
});

describe('a stroke with no fill', () => {
  const STROKES = (n: string, v: string) =>
    `${n} with no fill ${v} skipped. Convert strokes to paths in your editor to print them.`;

  it('is named with a count', () => {
    expect(load(`<rect width="40" height="40" fill="none" stroke="#000"/>${FILLED}`)).toEqual([
      STROKES('1 stroke', 'was'),
    ]);
  });

  it('takes its stroke from a group, as a browser draws it', () => {
    expect(
      load(
        `<g stroke="#000000" stroke-width="2"><path d="M0 0 L10 10" fill="none"/>` +
          `<rect width="5" height="5" fill="none"/></g>${FILLED}`,
      ),
    ).toEqual([STROKES('2 strokes', 'were')]);
  });

  it('stays quiet when the stroke draws nothing', () => {
    expect(
      load(
        '<rect width="4" height="4" fill="none"/>' +
          '<rect width="4" height="4" fill="none" stroke="none"/>' +
          '<rect width="4" height="4" fill="none" stroke="#000" stroke-width="0"/>' +
          '<rect width="4" height="4" fill="none" stroke="#000" stroke-opacity="0"/>' +
          '<rect width="4" height="4" fill="none" stroke="#000" opacity="0"/>' +
          '<g stroke-width="0"><rect width="4" height="4" fill="none" stroke="#000"/></g>' +
          `<g display="none"><rect width="4" height="4" fill="none" stroke="#000"/></g>${FILLED}`,
      ),
    ).toEqual([]);
  });

  it('leaves out the design-boundary circle, and counts a smaller outlined circle', () => {
    const out = parseSVGDocument(
      svg(
        '<circle cx="50" cy="50" r="48" fill="none" stroke="#000000"/>' +
          '<circle cx="50" cy="50" r="10" fill="none" stroke="#000000"/>' +
          '<rect x="30" y="30" width="40" height="40" fill="#ff0000"/>',
      ),
    );
    expect(out.rawSVGCircle?.r).toBe(48);
    expect(messages()).toEqual([STROKES('1 stroke', 'was')]);
  });
});

describe('template guide ink', () => {
  it('matches the ink the template generators draw with', () => {
    expect([...TEMPLATE_INKS].sort()).toEqual([ACCENT, GRAY].sort());
  });

  it("keeps a template's labels and guide lines quiet, and still names the same marks in another color", () => {
    const marks = (ink: string) =>
      `<text fill="${ink}">Left fender</text><path d="M0 0 L9 9" fill="none" stroke="${ink}"/>${FILLED}`;
    expect(load(marks(ACCENT))).toEqual([]);
    expect(load(marks(GRAY))).toEqual([]);
    expect(load(marks('#1a4f8e'))).toHaveLength(2);
  });
});

describe('the no-shapes error', () => {
  it('names what was skipped when that is why nothing imported', () => {
    expect(() =>
      parseSVGDocument(
        svg(
          '<defs><rect id="r" width="3" height="3"/></defs><text>TMT</text><text>x</text>' +
            '<use href="#r"/><rect width="4" height="4" fill="none" stroke="#000"/>',
        ),
      ),
    ).toThrow(
      'No flat-filled shapes were found in this SVG. Skipped: 2 text objects, 1 linked copy, 1 stroke with no fill. Convert or unlink them in your editor.',
    );
  });

  it('keeps the plain message when nothing was skipped', () => {
    expect(() => parseSVGDocument(svg('<rect width="4" height="4" fill="none"/>'))).toThrow(
      /^No flat-filled shapes were found in this SVG\.$/,
    );
  });
});

describe('files that print as drawn', () => {
  const NEW_WARNING = /Masks aren't applied|linked cop|text object|with no fill/;
  const files = (dir: string): [string, string][] =>
    readdirSync(path.join(REPO, dir))
      .filter((f) => f.endsWith('.svg'))
      .map((f) => [`${dir}/${f}`, readFileSync(path.join(REPO, dir, f), 'utf8')]);

  it.each([
    ...files('public/templates'),
    ...files('tests/fixtures/patterns'),
    ['hubcap circle template', hubcapTemplateSvg({ kind: 'circle', diameterMm: 220 })],
  ])('%s raises none of the skipped-content warnings', (_name, text) => {
    parseSVGDocument(text);
    expect(messages().filter((m) => NEW_WARNING.test(m))).toEqual([]);
  });

  it('the files above do carry the marks those warnings name', () => {
    // Guards the test above against passing because the files changed shape, not the parser.
    const all = files('public/templates')
      .map(([, t]) => t)
      .join('');
    expect(all).toMatch(/<text\b/);
    expect(all).toMatch(/fill="none"[^>]*stroke="#1a4f8f"/);
  });
});
