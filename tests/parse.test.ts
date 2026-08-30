// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import {
  SVG_LENGTH_UNIT_MM,
  normalizeColor,
  parseFillOpacity,
  parseSVGDocument,
  svgLengthIsPhysical,
  svgLengthToMM,
} from '../src/svg/parse';
import { designAnchor, placedFootprintMM } from '../src/geometry/assembly';
import { WARNINGS, clearWarnings, warn } from '../src/warnings';

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

  it('names two distinct gradient-filled elements separately, so one warning does not hide the other', () => {
    clearWarnings();
    parseSVGDocument(
      svg(
        '<rect width="4" height="4" fill="url(#a)"/>' +
          '<circle r="4" fill="url(#b)"/>' +
          '<rect width="4" height="4" fill="#00ff00"/>',
      ),
    );
    const messages = WARNINGS.map((w) => w.message);
    expect(messages).toContainEqual(expect.stringContaining('Shape 1'));
    expect(messages).toContainEqual(expect.stringContaining('Shape 2'));
  });

  it('drops a fully malformed <path> and warns, instead of shipping a NaN vertex', () => {
    clearWarnings();
    const out = parseSVGDocument(
      svg('<path d="M0 0 L10" fill="#ff0000"/><rect width="4" height="4" fill="#00ff00"/>'),
    );
    expect(out.shapes).toHaveLength(1);
    expect(out.shapes[0].fill).toBe('#00ff00');
    expect(WARNINGS.map((w) => w.message)).toContainEqual(expect.stringContaining('broken data'));
  });

  it('keeps a <path>’s completed subpaths when only a later one is malformed', () => {
    clearWarnings();
    const out = parseSVGDocument(svg('<path d="M0 0 L10 0 L10 10 Z M20 20 L30" fill="#ff0000"/>'));
    expect(out.shapes).toHaveLength(1);
    expect(out.shapes[0].loops).toHaveLength(1);
    expect(WARNINGS.map((w) => w.message)).toContainEqual(expect.stringContaining('broken data'));
  });

  it('names two distinct malformed <path>s separately, so one warning does not hide the other', () => {
    clearWarnings();
    // Both paths are fully malformed, so no shape survives and parseSVGDocument itself throws;
    // what this test checks is that it warned about each one, by name, before doing so.
    expect(() =>
      parseSVGDocument(
        svg('<path d="M0 0 L10" fill="#ff0000"/><path d="M5 5 L20" fill="#00ff00"/>'),
      ),
    ).toThrow();
    const messages = WARNINGS.map((w) => w.message);
    expect(messages).toContainEqual(expect.stringContaining('Path 1'));
    expect(messages).toContainEqual(expect.stringContaining('Path 2'));
  });

  it('counts a real-fill <path> with no d attribute, so a later broken one is still named correctly', () => {
    clearWarnings();
    expect(() =>
      parseSVGDocument(svg('<path fill="#ff0000"/><path d="M0 0 L10" fill="#00ff00"/>')),
    ).toThrow();
    expect(WARNINGS.map((w) => w.message)).toContainEqual(expect.stringContaining('Path 2'));
  });

  it('counts a <path> it can never import, so a later broken one is named by its position in the file', () => {
    clearWarnings();
    // A clip-mask path, then hidden four ways, then the broken one. Someone counting <path>
    // elements in their editor cannot skip any of those, so Path N has to agree with that count.
    expect(() =>
      parseSVGDocument(
        svg(
          '<defs><clipPath id="c"><path d="M0 0 L1 1"/></clipPath></defs>' +
            '<path d="M0 0 L1 1" fill="#ff0000" fill-opacity="0"/>' +
            '<path d="M0 0 L1 1" fill="none"/>' +
            '<path d="M0 0 L1 1" fill="url(#a)"/>' +
            '<path d="M0 0 L1 1" fill="#ff0000" display="none"/>' +
            '<path d="M0 0 L10" fill="#00ff00"/>',
        ),
      ),
    ).toThrow();
    expect(WARNINGS.map((w) => w.message)).toContainEqual(expect.stringContaining('Path 6'));
  });

  it('numbers a gradient-filled shape on the same basis, counting the ones it never imported', () => {
    clearWarnings();
    parseSVGDocument(
      svg(
        '<defs><rect width="9" height="9" fill="#111111"/></defs>' +
          '<rect width="4" height="4" fill="#ff0000" display="none"/>' +
          '<rect width="4" height="4" fill="url(#a)"/>' +
          '<rect width="4" height="4" fill="#00ff00"/>',
      ),
    );
    expect(WARNINGS.map((w) => w.message)).toContainEqual(expect.stringContaining('Shape 3'));
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

  it('reports the largest circle, leaving the anchor decision to designAnchor', () => {
    const out = parseSVGDocument(
      svg(
        '<circle cx="1" cy="1" r="2" fill="#ff0000"/>' +
          '<circle cx="50" cy="40" r="30" fill="#00ff00"/>',
      ),
    );
    expect(out.rawSVGCircle).toEqual({ cx: 50, cy: 40, r: 30 });
  });

  it('bakes the viewBox origin into the anchor circle, like every other shape', () => {
    const out = parseSVGDocument(
      svg('<circle cx="150" cy="140" r="30" fill="#00ff00"/>', 'viewBox="100 100 200 200"'),
    );
    expect(out.rawSVGCircle).toEqual({ cx: 50, cy: 40, r: 30 });
  });

  it('bakes a nested group transform into the anchor circle center and radius', () => {
    const out = parseSVGDocument(
      svg(
        '<g transform="translate(5,7) scale(2)"><circle cx="10" cy="10" r="3" fill="#00ff00"/></g>',
      ),
    );
    expect(out.rawSVGCircle).toEqual({ cx: 25, cy: 27, r: 6 });
  });

  it('ignores a larger circle nested inside defs/clipPath when picking the anchor', () => {
    const out = parseSVGDocument(
      svg(
        '<defs><clipPath id="c"><circle cx="0" cy="0" r="1000" /></clipPath></defs>' +
          '<circle cx="50" cy="40" r="30" fill="#00ff00"/>',
      ),
    );
    expect(out.rawSVGCircle).toEqual({ cx: 50, cy: 40, r: 30 });
  });

  it('reports no anchor circle when the only <circle> is nested inside defs', () => {
    const out = parseSVGDocument(
      svg(
        '<defs><clipPath id="c"><circle cx="0" cy="0" r="1000" /></clipPath></defs>' +
          '<rect width="4" height="4" fill="#00ff00"/>',
      ),
    );
    expect(out.rawSVGCircle).toBeNull();
  });

  it('throws when no flat-filled shapes exist', () => {
    expect(() => parseSVGDocument(svg('<rect width="4" height="4" fill="none"/>'))).toThrow(
      /No flat-filled shapes/,
    );
  });

  // depth is empirically tuned (walk overflows ~3000 on this machine/Node version, via jsdom's
  // heavier per-element traversal) with ~2x headroom; a future Node/V8 stack-size change could
  // shift the real threshold enough to need retuning.
  it('names deeply nested groups instead of a raw stack overflow', () => {
    const depth = 6000;
    let inner = '<rect width="4" height="4" fill="#ff0000"/>';
    for (let i = 0; i < depth; i++) inner = `<g>${inner}</g>`;
    const doc = svg(inner);
    expect(() => parseSVGDocument(doc)).toThrow(/nested.*group|group.*nested/i);
    try {
      parseSVGDocument(doc);
    } catch (e) {
      expect((e as Error).message).not.toMatch(/call stack/i);
    }
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

  it('exposes the viewBox extent so rect placement can fit a size-less SVG to the face', () => {
    // Affinity's SVG export: real mm size stripped to width/height="100%", viewBox rescaled to px.
    // userUnitMM is unknowable, but the viewBox extent lets rect placement fit it to the part face.
    const out = parseSVGDocument(
      svg(
        '<rect width="10" height="10" fill="#ff0000"/>',
        'width="100%" height="100%" viewBox="0 0 755 525"',
      ),
    );
    expect(out.userUnitMM).toBeNull();
    expect(out.viewBox).toEqual({ w: 755, h: 525 });
  });

  it('rejects a px-only size with no viewBox as a print size, but keeps it as the canvas', () => {
    // Affinity's other export shape: viewBox dropped, size written as px at the document's own DPI
    // (72 here, so 755px IS 266mm). Trusting the spec's 96dpi lands our 266mm footrest template at
    // 199.8mm, exactly 75%. Null userUnitMM sends rect placement to the fit-the-canvas branch.
    const out = parseSVGDocument(
      svg('<rect width="10" height="10" fill="#ff0000"/>', 'width="755px" height="525px"'),
    );
    expect(out.userUnitMM).toBeNull();
    expect(out.canvas).toEqual({ w: 755, h: 525 });
  });

  it('rejects a unitless size with no viewBox the same way', () => {
    const out = parseSVGDocument(
      svg('<rect width="10" height="10" fill="#ff0000"/>', 'width="755" height="525"'),
    );
    expect(out.userUnitMM).toBeNull();
    expect(out.canvas).toEqual({ w: 755, h: 525 });
  });

  it('rejects a px size that comes WITH a viewBox, which is the same 75% bug', () => {
    // Affinity's export with "Set viewBox" ticked. widthMM/vbW cancels to exactly the 96dpi
    // constant, so the ratio carries no information the px reading did not already assume: our
    // 266mm template came out at 199.5mm here too, and silently, until this branch rejected it.
    for (const attrs of [
      'width="755px" height="525px" viewBox="0 0 755 525"',
      'width="755" height="525" viewBox="0 0 755 525"',
    ]) {
      const out = parseSVGDocument(svg('<rect width="10" height="10" fill="#ff0000"/>', attrs));
      expect(out.userUnitMM).toBeNull();
      expect(out.canvas).toEqual({ w: 755, h: 525 }); // still fits to the face
    }
  });

  it('mixes a physical axis with a px one by taking only the physical axis', () => {
    const out = parseSVGDocument(
      svg(
        '<rect width="10" height="10" fill="#ff0000"/>',
        'width="266mm" height="525px" viewBox="0 0 266 185"',
      ),
    );
    expect(out.userUnitMM).toBeCloseTo(1, 9); // 266mm / 266 units, ignoring the px height
  });

  it('still trusts a physical size with no viewBox', () => {
    // mm/cm/in/pt/pc are measurements whatever the editor's DPI, so these keep mapping user px
    // at 96dpi rather than being auto-fit to the face.
    for (const attrs of ['width="266mm" height="185mm"', 'width="10in" height="7in"']) {
      const out = parseSVGDocument(svg('<rect width="10" height="10" fill="#ff0000"/>', attrs));
      expect(out.userUnitMM).toBeCloseTo(25.4 / 96, 12);
    }
  });

  it('claims no size from a single px axis either, so the notice still fires', () => {
    // No second axis means no canvas to fit, so this lands on the 1:1 branch and prints 3x
    // oversized. That is wrong and loud. Keeping the 96dpi reading here instead put it at 199.5mm
    // on a 266mm face with nothing said, which is this whole fix's failure mode.
    for (const attrs of ['width="755px"', 'width="755px" height="100%"']) {
      const out = parseSVGDocument(svg('<rect width="10" height="10" fill="#ff0000"/>', attrs));
      expect(out.userUnitMM).toBeNull();
      expect(out.canvas).toBeNull();
    }
  });

  it('classifies every unit the length table knows, so the two cannot drift', () => {
    // PHYSICAL_UNITS is a list, not a subtraction, so a unit added to the table is auto-fit rather
    // than silently trusted as a measurement. This is what stops that list going stale unnoticed.
    for (const unit of Object.keys(SVG_LENGTH_UNIT_MM)) {
      const physical = svgLengthIsPhysical(`10${unit}`);
      expect(physical).toBe(unit !== '' && unit !== 'px');
      expect(svgLengthToMM(`10${unit}`)).not.toBeNull();
    }
    expect(svgLengthIsPhysical('10em')).toBe(false); // not in the table, so not a measurement
  });

  it('reports a null viewBox when the SVG declares none', () => {
    const out = parseSVGDocument(svg('<rect width="10" height="10" fill="#ff0000"/>'));
    expect(out.viewBox).toBeNull();
  });

  it('reports the canvas rect placement anchors on: the viewBox when there is one', () => {
    const out = parseSVGDocument(
      svg('<rect width="10" height="10" fill="#ff0000"/>', 'width="266mm" viewBox="0 0 266 185"'),
    );
    expect(out.canvas).toEqual({ w: 266, h: 185 });
  });

  it('falls back to the declared mm box as the canvas when there is no viewBox', () => {
    // No viewBox, so coordinates are user px at 96dpi — the declared physical size still states a
    // canvas, and without it a design drawn away from the origin would re-center on the part.
    const out = parseSVGDocument(
      svg('<rect width="10" height="10" fill="#ff0000"/>', 'width="25.4mm" height="12.7mm"'),
    );
    expect(out.canvas?.w).toBeCloseTo(96, 6);
    expect(out.canvas?.h).toBeCloseTo(48, 6);
  });

  it('reports no canvas when the SVG declares neither a viewBox nor both dimensions', () => {
    expect(
      parseSVGDocument(svg('<rect width="10" height="10" fill="#ff0000"/>')).canvas,
    ).toBeNull();
    // A lone width leaves the canvas height unknown, which is not an anchor.
    const oneAxis = parseSVGDocument(
      svg('<rect width="10" height="10" fill="#ff0000"/>', 'width="25.4mm"'),
    );
    expect(oneAxis.canvas).toBeNull();
  });

  it.each([
    ['truncated', 'viewBox="0 0 100"'],
    ['non-numeric', 'viewBox="none"'],
    ['empty', 'viewBox=""'],
  ])('treats a %s viewBox as absent rather than trusting NaN', (_label, attr) => {
    // Translating rootM by NaN would poison every coordinate downstream, and a partial box
    // leaves the extent undefined — both must read as "no viewBox", not as a usable one.
    const out = parseSVGDocument(
      svg('<rect x="2" y="3" width="10" height="4" fill="#ff0000"/>', attr),
    );
    expect(out.viewBox).toBeNull();
    expect(out.shapes[0].loops[0][0]).toEqual({ x: 2, y: 3 });
    expect(out.bbox).toEqual({ minX: 2, minY: 3, maxX: 12, maxY: 7 });
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

  // A parser must not own UI state: clearing WARNINGS is the caller's job (the user-initiated
  // load in ui/artworkPanel.ts), not this function's. The restore loop in state/persist.ts calls
  // this once per SVG source and must not have an earlier source's standing warning wiped by a
  // later one's parse.
  it('does not clear a warning that was already standing before it ran', () => {
    clearWarnings();
    warn('a standing warning from something else entirely', 'pre-existing');
    parseSVGDocument(svg('<rect width="4" height="4" fill="#00ff00"/>'));
    expect(WARNINGS.some((w) => w.key === 'pre-existing')).toBe(true);
  });
});

describe('parseFillOpacity', () => {
  it('falls back to fully opaque on a non-numeric value, instead of NaN', () => {
    expect(parseFillOpacity('abc')).toBe(1);
    expect(parseFillOpacity(null)).toBe(1);
  });

  it('still reads a valid value through', () => {
    expect(parseFillOpacity('0.5')).toBeCloseTo(0.5, 9);
    expect(parseFillOpacity('0')).toBe(0);
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

/**
 * The reported bug, end to end: our own 266x185mm footrest template, edited in Affinity and
 * re-exported. The viewBox is gone, the size is "755px x 525px" at the document's 72dpi, and the
 * mm coordinates survive only inside a matrix(72/25.4) group. Read as 96dpi px the artwork landed
 * at 199.8mm, exactly 75% of the face. The 0.35mm shortfall now is Affinity rounding the sheet
 * from 754.02px up to a whole 755.
 */
describe('an Affinity re-export of a design template', () => {
  const affinityFootrest = () =>
    parseSVGDocument(
      '<svg xmlns="http://www.w3.org/2000/svg" width="755px" height="525px">' +
        '<g transform="matrix(2.834646,0,0,2.834646,0,0)">' +
        '<path d="M0,0L266,0L266,185L0,185Z" style="fill:rgb(200,200,200);"/>' +
        '</g></svg>',
    );

  it('lands life-size on the footrest face instead of at 75%', () => {
    const parsed = affinityFootrest();
    const placed = placedFootprintMM(parsed, 1, 0, {
      isRect: true,
      radius: 138,
      designFace: () => ({ w: 266, h: 185 }),
    });
    expect(placed.w).toBeCloseTo(265.65, 2);
    expect(placed.h).toBeCloseTo(184.76, 2);
    expect(placed.w).not.toBeCloseTo(199.8, 1); // the regression this replaces
  });

  it('anchors on the sheet, so the design keeps where it sat on the page', () => {
    // canvasAnchor centres on the 755x525 sheet, not on the drawn content, so a mark in one
    // corner of the page still lands in that corner of the face.
    expect(designAnchor(affinityFootrest(), true)).toEqual({ cx: 377.5, cy: 262.5, r: 377.5 });
  });
});
