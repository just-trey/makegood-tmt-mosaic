import type { Loop, Mat6, ParsedSVG, SVGShape } from '../types';
import { Mat, parseTransformAttr } from './matrix';
import { ellipsePoints, parsePathD } from './path';
import { warn } from '../warnings';
import { rethrowStackOverflowAs } from '../errors';

// The tags that can carry a flat fill. One list, so the walk's test and the selector that counts
// past it for the warning numbers cannot drift apart.
const SHAPE_TAGS = ['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline'];
const SHAPE_SELECTOR = SHAPE_TAGS.join(',');

// Normalize any CSS color string to "#rrggbb" using a canvas as an oracle.
let colorCanvas: CanvasRenderingContext2D | null = null;
export function normalizeColor(str: string | null): string | null {
  if (!str) return null;
  str = str.trim();
  if (str === 'none' || str === 'transparent') return null;
  if (str === 'currentColor') str = '#000000';
  if (!colorCanvas) colorCanvas = document.createElement('canvas').getContext('2d');
  if (!colorCanvas) return null;
  colorCanvas.fillStyle = '#000';
  try {
    colorCanvas.fillStyle = str;
  } catch {
    return null;
  }
  const out = String(colorCanvas.fillStyle);
  if (/^#([0-9a-f]{6})$/i.test(out)) return out.toLowerCase();
  const m = out.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) {
    return '#' + [1, 2, 3].map((i) => (+m[i]).toString(16).padStart(2, '0')).join('');
  }
  return '#000000';
}

const PX_MM = 25.4 / 96;

export const SVG_LENGTH_UNIT_MM: Record<string, number> = {
  '': PX_MM, // unitless user units default to px
  px: PX_MM,
  pt: 25.4 / 72,
  pc: 25.4 / 6,
  mm: 1,
  cm: 10,
  in: 25.4,
};

/**
 * Units that state a real-world size. px and the unitless default are screen units at whatever DPI
 * the editor used.
 *
 * Listed, not derived by subtracting px from the table above. Derivation fails open: a unit added
 * there later (`em`, `vw`) would be trusted as a measurement without anyone deciding it is one,
 * which silently reinstates DPI-guessed sizing. Listing fails to an auto-fit and a notice instead.
 * `svgLengthToMM handles every table unit` in tests/parse.test.ts keeps the two from drifting.
 */
const PHYSICAL_UNITS = new Set(['pt', 'pc', 'mm', 'cm', 'in']);

/** value and unit of an SVG length, or null when it isn't one. The unit is '' when omitted. */
function splitSVGLength(value: string | null): { n: number; unit: string } | null {
  if (!value) return null;
  const m = value.trim().match(/^([+-]?[\d.eE]+)\s*([a-z%]*)$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? { n, unit: m[2].toLowerCase() } : null;
}

/** SVG length ("266mm", "1005.2", "10in") -> millimeters. Null for %, unknown units, or non-numeric. */
export function svgLengthToMM(value: string | null): number | null {
  const l = splitSVGLength(value);
  if (!l) return null;
  const factor = SVG_LENGTH_UNIT_MM[l.unit];
  return factor == null ? null : l.n * factor;
}

/**
 * An `<alpha-value>`: a number or a percentage, clamped to 0..1 as the spec says, so `-1` hides a
 * shape the way a browser does. Null when missing or invalid: a browser then uses the inherited
 * value for `fill-opacity`, and fully opaque for `opacity`, which does not inherit.
 */
function parseAlpha(raw: string | null): number | null {
  const m = /^([+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?)(%?)$/i.exec((raw ?? '').trim());
  if (!m) return null;
  const n = parseFloat(m[1]) / (m[2] ? 100 : 1);
  return Math.min(1, Math.max(0, n));
}

export function parseFillOpacity(raw: string | null): number {
  return parseAlpha(raw) ?? 1;
}

/**
 * A group that hides what is under it, and how many of those shapes would otherwise have been
 * imported, so it can raise one warning for all of them.
 */
interface HiddenGroup {
  name: string | null;
  firstShape: number;
  count: number;
}

/**
 * What an element takes from its ancestors. `display:none` and `opacity:0` hide the whole subtree
 * and nothing below can undo either (opacity multiplies, so a zero anywhere stays zero), so the
 * outermost one is kept. `fill-opacity` inherits and a child's own value replaces it, so it is the
 * nearest group that set it, and only while that value is 0: no other value hides anything.
 */
interface Inherited {
  hiddenBy: HiddenGroup | null;
  fillOpacityZeroFrom: HiddenGroup | null;
}

/**
 * Whether an SVG length claims a real-world size, as opposed to screen pixels.
 *
 * A `px` (or unitless) length is whatever DPI the editor happened to use: Affinity writes 72,
 * the CSS/SVG spec says 96. A 266mm template re-exported from Affinity comes back as "755px" and
 * reads 25% small at the spec's 96, so px alone is not a measurement.
 */
export function svgLengthIsPhysical(value: string | null): boolean {
  const l = splitSVGLength(value);
  return !!l && PHYSICAL_UNITS.has(l.unit);
}

interface StyleDecl {
  value: string;
  important: boolean;
}
type StyleDecls = Map<string, StyleDecl>;

const CSS_COMMENT = /\/\*[\s\S]*?\*\//g;
const IMPORTANT = /\s*!\s*important$/i;

/**
 * Declarations in one CSS block, with `!important` split off the value so no reader ever sees it.
 * Merged into `into`, where a later declaration wins unless it would demote an `!important` one.
 */
function parseDeclarations(block: string, into: StyleDecls = new Map()): StyleDecls {
  for (const decl of block.replace(CSS_COMMENT, '').split(';')) {
    const idx = decl.indexOf(':');
    if (idx < 0) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const raw = decl.slice(idx + 1).trim();
    const value = raw.replace(IMPORTANT, '');
    const important = value !== raw;
    if (!prop || !value) continue;
    if (into.get(prop)?.important && !important) continue;
    into.set(prop, { value, important });
  }
  return into;
}

/**
 * Collect `.className { prop: value; ... }` rules from every <style> block in the document.
 * Only class selectors are recognized (e.g. Illustrator/Inkscape's `.cls-1, .cls-2 {...}`
 * export pattern) — tag/id/combinator selectors are deliberately ignored so this can never
 * change the resolved fill of an SVG that has no `class` attributes on its shapes.
 */
function parseClassRules(doc: Document): Map<string, StyleDecls> {
  const rules = new Map<string, StyleDecls>();
  doc.querySelectorAll('style').forEach((styleEl) => {
    const css = (styleEl.textContent || '').replace(CSS_COMMENT, '');
    const blockRe = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(css))) {
      const classNames = m[1].match(/\.[-\w]+/g) || [];
      for (const c of classNames) {
        const name = c.slice(1);
        rules.set(name, parseDeclarations(m[2], rules.get(name)));
      }
    }
  });
  return rules;
}

/**
 * Resolves a presentation property through the cascade: `!important` inline style, then
 * `!important` class rule, then plain inline style, class rule, and finally the attribute.
 * No value it returns from a style declaration carries `!important`.
 */
export function createStyleResolver(doc: Document): (el: Element, prop: string) => string | null {
  const classRules = parseClassRules(doc);
  return (el, prop) => {
    const inline = parseDeclarations(el.getAttribute('style') ?? '').get(prop);
    if (inline?.important) return inline.value;
    let cls: StyleDecl | undefined;
    const classes = (el.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean);
    for (let i = classes.length - 1; i >= 0; i--) {
      const d = classRules.get(classes[i])?.get(prop);
      if (d && (!cls || (d.important && !cls.important))) cls = d;
    }
    if (cls?.important) return cls.value;
    // Not stripped here: `!important` is invalid in an attribute, so a browser ignores the whole
    // value. Stripping it turned `fill="none !important"`, which a browser draws black, into a drop.
    return inline?.value ?? cls?.value ?? el.getAttribute(prop);
  };
}

/**
 * Parse SVG markup into flat lists of {fill, loops} in SVG user-space units,
 * with all transforms (including viewBox translation) baked in.
 */
export function parseSVGDocument(svgText: string): ParsedSVG {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const perr = doc.querySelector('parsererror');
  if (perr) throw new Error('SVG could not be parsed. Check the file is valid XML.');
  const svgEl = doc.documentElement;

  // Root transform from the viewBox origin. viewBox coordinate space is treated directly as
  // our working units; width/height attributes are ignored for scale purposes since artwork
  // is re-fit to the physical footprint later anyway.
  // A viewBox that isn't four finite numbers is treated as absent rather than trusted: a
  // truncated box (`0 0 100`) leaves the extent undefined, and a non-numeric one would translate
  // rootM by NaN — poisoning every coordinate downstream instead of failing where it went wrong.
  let rootM = Mat.identity();
  const vbNums = (svgEl.getAttribute('viewBox') || '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const vb = vbNums.length === 4 && vbNums.every((n) => Number.isFinite(n)) ? vbNums : null;
  let vbW = 0,
    vbH = 0;
  if (vb) {
    rootM = Mat.translate(-vb[0], -vb[1]);
    vbW = vb[2];
    vbH = vb[3];
  }

  // Physical scale for rect placement (mm per working/viewBox unit), from the file's declared
  // width/height. Wheel mode ignores this — it scales artwork off the design <circle> — but rect
  // mode maps SVG units straight to mm, so we must honor the real-world size: an editor round-trip
  // (e.g. re-export from Affinity) can rewrite the viewBox to a different internal resolution while
  // keeping the same physical width, and without this the design comes out mis-scaled. Null when
  // the SVG declares no size a printer could act on (rect mode then fits the canvas to the design
  // face, with a notice).
  const widthAttr = svgEl.getAttribute('width');
  const heightAttr = svgEl.getAttribute('height');
  const widthMM = svgLengthToMM(widthAttr);
  const heightMM = svgLengthToMM(heightAttr);

  // The document's own canvas, which rect placement anchors artwork on, and fits to the design
  // face when there is no mm size. A viewBox states it directly; without one, the declared
  // width/height does, converted at 96dpi because with no viewBox a user unit *is* a px by
  // definition (independent of whether that px count is trustworthy as a print size). Both axes
  // are required in that second case: a lone width leaves the canvas height unknown, and half a
  // canvas is not an anchor.
  let canvas: { w: number; h: number } | null = null;
  if (vb && vbW > 0 && vbH > 0) {
    canvas = { w: vbW, h: vbH };
  } else if (!vb && widthMM != null && heightMM != null && widthMM > 0 && heightMM > 0) {
    canvas = { w: widthMM / PX_MM, h: heightMM / PX_MM };
  }

  // Only an axis declared in a real unit sets the scale. A px (or unitless) length is the editor's
  // own DPI and states no size at all: Affinity writes px at 72, the spec reads them at 96, and
  // our own 266mm footrest template comes back from Affinity as "755px" either with no viewBox or
  // with a matching one. Both readings land it at ~75%, so both are rejected here and fitted to
  // the design face instead.
  const wMM = svgLengthIsPhysical(widthAttr) ? widthMM : null;
  const hMM = svgLengthIsPhysical(heightAttr) ? heightMM : null;
  let userUnitMM: number | null = null;
  if (vb) {
    // mm-per-unit from each declared axis independently. Guard `> 0` so a width="0"/height="0"
    // doesn't collapse to a scale of 0 (which would map every point onto the face origin). When
    // both axes are present but disagree — the file's width/height proportions differ from its
    // viewBox aspect — there's no single true scale, so take the smaller: that matches SVG's
    // default "meet" fitting, which uniformly scales the design to sit inside the declared box
    // rather than stretching one axis to match the other.
    const sx = vbW > 0 && wMM != null && wMM > 0 ? wMM / vbW : null;
    const sy = vbH > 0 && hMM != null && hMM > 0 ? hMM / vbH : null;
    userUnitMM = sx != null && sy != null ? Math.min(sx, sy) : (sx ?? sy);
  } else if ((wMM != null && wMM > 0) || (hMM != null && hMM > 0)) {
    userUnitMM = PX_MM; // no viewBox: coords are user px, and the declared mm size is real
  }

  const shapes: SVGShape[] = [];
  let order = 0;
  // Both numbers are positions in the file as an editor shows it, not positions among the
  // elements that survived import: someone counting elements to find the one a warning named
  // cannot skip the hidden, unfilled or <defs>-bound ones. warn() dedupes by exact message, so an
  // unnumbered "Path has broken data" would collapse a second offender into the first one's pill
  // and under-report how much was dropped, which is why they are numbered at all.
  let pathCount = 0;
  let shapeCount = 0;

  // Largest <circle> found by the same visible-subtree walk as shapes below (assembly mode's
  // design-boundary anchor) — tracked here, not via a separate querySelectorAll, so it inherits
  // the defs/clipPath/mask/pattern/symbol exclusion and the accumulated transform M for free.
  let rawSVGCircle: ParsedSVG['rawSVGCircle'] = null;
  let bestR = -1;

  // Elements with no `class` attribute (i.e. every shape in SVGs we already support) fall
  // straight through the empty class-rule step to the inline style and the attribute.
  const resolveProp = createStyleResolver(doc);

  function getAncestorFill(el: Element): string | null {
    let p = el.parentElement;
    while (p) {
      const f = resolveProp(p, 'fill');
      if (f && !/url\(/.test(f)) return f;
      p = p.parentElement;
    }
    return null;
  }

  function walk(el: Element, parentM: Mat6, inherited: Inherited): void {
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (!tag) return;
    if (
      [
        'defs',
        'symbol',
        'clippath',
        'mask',
        'pattern',
        'title',
        'desc',
        'style',
        'metadata',
      ].includes(tag)
    ) {
      // Nothing in here is imported, but the warning numbers still have to count it: a clip mask
      // puts real <path> elements in <defs>, and someone opening the file to find the element we
      // named counts those too.
      shapeCount += el.querySelectorAll(SHAPE_SELECTOR).length;
      pathCount += el.querySelectorAll('path').length;
      return;
    }

    const localM = parseTransformAttr(el.getAttribute('transform'));
    const M = Mat.multiply(parentM, localM);

    if (tag === 'circle') {
      // Anchor candidacy ignores fill/display-none — a design-boundary marker circle is
      // commonly fill="none". rawSVGCircle is a scalar {cx,cy,r}, unlike shape loops (which
      // stay exact under any transform by mapping every point individually); a skew or
      // non-uniform scale turns a circle into an ellipse, so r is necessarily approximated via
      // the transform's x-axis scale — exact for translate/rotate/uniform-scale, approximate
      // otherwise.
      const cxA = +(el.getAttribute('cx') || 0);
      const cyA = +(el.getAttribute('cy') || 0);
      const rAttr = +(el.getAttribute('r') || 0);
      const scale = Math.hypot(M[0], M[1]);
      const r = rAttr * scale;
      if (r > bestR) {
        bestR = r;
        const c = Mat.apply(M, cxA, cyA);
        rawSVGCircle = { cx: c.x, cy: c.y, r };
      }
    }

    const fillRaw = resolveProp(el, 'fill');
    const fillUrl = fillRaw && /url\(/.test(fillRaw);
    const ownOpacity = parseFillOpacity(resolveProp(el, 'opacity'));
    const ownFillOpacity = parseAlpha(resolveProp(el, 'fill-opacity'));
    const opacity = (ownFillOpacity ?? 1) * ownOpacity;
    const displayNone = resolveProp(el, 'display') === 'none';

    if (SHAPE_TAGS.includes(tag)) {
      shapeCount++;
      if (tag === 'path') pathCount++;
      const hiddenBy =
        inherited.hiddenBy ?? (ownFillOpacity == null ? inherited.fillOpacityZeroFrom : null);
      if (displayNone) {
        // Silent, for the reason on the `opacity === 0` branch below.
      } else if (hiddenBy) {
        // Counted only when nothing else would have dropped it, so the warning's count is what
        // the hidden group took out of the print.
        if (!fillUrl && fillRaw !== 'none' && ownOpacity !== 0 && ownFillOpacity !== 0) {
          hiddenBy.count++;
        }
      } else {
        if (fillUrl) {
          warn(
            `Shape ${shapeCount} (a <${tag}>) has a gradient/pattern fill (not a flat color), so it was skipped.`,
          );
        } else if (fillRaw === 'none') {
          // no fill, e.g. stroke-only outline — ignored for inlay purposes
        } else if (opacity === 0) {
          // Deliberately silent, unlike the gradient branch above: fill-opacity="0" is how an
          // artist hides a shape, and a pill per hidden shape would nag on a file behaving as
          // drawn.
        } else {
          const hex = normalizeColor(fillRaw || getAncestorFill(el) || '#000000');
          let loops: Loop[] = [];
          if (tag === 'path') {
            const n = pathCount;
            const d = el.getAttribute('d');
            if (d) {
              loops = parsePathD(d, () =>
                warn(
                  `Path ${n} has broken data partway through its outline. Everything from that point on was dropped.`,
                ),
              );
            }
          } else if (tag === 'rect') {
            const x = +(el.getAttribute('x') || 0),
              y = +(el.getAttribute('y') || 0);
            const w = +(el.getAttribute('width') || 0),
              h = +(el.getAttribute('height') || 0);
            const rxAttr = el.getAttribute('rx'),
              ryAttr = el.getAttribute('ry');
            let rx = rxAttr ? +rxAttr : ryAttr ? +ryAttr : 0;
            let ry = ryAttr ? +ryAttr : rx;
            if (w > 0 && h > 0) {
              if (rx > 0 && ry > 0) {
                rx = Math.min(rx, w / 2);
                ry = Math.min(ry, h / 2);
                const seg = 12,
                  pts: Loop = [];
                const corners: [number, number, number, number][] = [
                  [x + w - rx, y + ry, -90, 0],
                  [x + w - rx, y + h - ry, 0, 90],
                  [x + rx, y + h - ry, 90, 180],
                  [x + rx, y + ry, 180, 270],
                ];
                corners.forEach(([ccx, ccy, a0, a1]) => {
                  for (let k = 0; k <= seg; k++) {
                    const t = ((a0 + ((a1 - a0) * k) / seg) * Math.PI) / 180;
                    pts.push({ x: ccx + rx * Math.cos(t), y: ccy + ry * Math.sin(t) });
                  }
                });
                pts.push(pts[0]);
                loops = [pts];
              } else {
                loops = [
                  [
                    { x, y },
                    { x: x + w, y },
                    { x: x + w, y: y + h },
                    { x, y: y + h },
                    { x, y },
                  ],
                ];
              }
            }
          } else if (tag === 'circle') {
            const cxA = +(el.getAttribute('cx') || 0),
              cyA = +(el.getAttribute('cy') || 0),
              r = +(el.getAttribute('r') || 0);
            if (r > 0) loops = [ellipsePoints(cxA, cyA, r, r)];
          } else if (tag === 'ellipse') {
            const cxA = +(el.getAttribute('cx') || 0),
              cyA = +(el.getAttribute('cy') || 0);
            const rx = +(el.getAttribute('rx') || 0),
              ry = +(el.getAttribute('ry') || 0);
            if (rx > 0 && ry > 0) loops = [ellipsePoints(cxA, cyA, rx, ry)];
          } else if (tag === 'polygon' || tag === 'polyline') {
            const pts = (el.getAttribute('points') || '')
              .trim()
              .split(/[\s,]+/)
              .map(Number);
            const loop: Loop = [];
            for (let k = 0; k < pts.length - 1; k += 2) loop.push({ x: pts[k], y: pts[k + 1] });
            if (tag === 'polygon' && loop.length) loop.push(loop[0]);
            loops = [loop];
          }
          loops = loops
            .filter((l) => l.length >= 3)
            .map((l) => l.map((p) => Mat.apply(M, p.x, p.y)));
          if (loops.length) {
            shapes.push({ fill: hex || '#000000', loops, order: order++ });
          }
        }
      }
    }
    if (!el.children.length) return;
    const own: HiddenGroup = {
      // An Inkscape layer's name is its label, and Illustrator writes one with spaces as data-name.
      name:
        el.getAttribute('inkscape:label') ||
        el.getAttribute('data-name') ||
        el.getAttribute('id') ||
        null,
      firstShape: shapeCount + 1,
      count: 0,
    };
    const next: Inherited = {
      hiddenBy: inherited.hiddenBy ?? (displayNone || ownOpacity === 0 ? own : null),
      fillOpacityZeroFrom:
        ownFillOpacity == null ? inherited.fillOpacityZeroFrom : ownFillOpacity === 0 ? own : null,
    };
    for (const child of el.children) walk(child, M, next);
    if (own.count) {
      // The shape number stays even with a name: warn() dedupes by message, and two layers can
      // share one. Both ternaries inline, so check:troubleshooting reads every wording it ships.
      warn(
        `The hidden group ${own.name ? `"${own.name}" ` : ''}starting at shape ${own.firstShape} was skipped, with its ${own.count === 1 ? '1 shape' : `${own.count} shapes`}. Show it in your editor to print it.`,
      );
    }
  }

  try {
    for (const child of svgEl.children)
      walk(child, rootM, { hiddenBy: null, fillOpacityZeroFrom: null });
  } catch (e) {
    rethrowStackOverflowAs(
      e,
      "This SVG has unusually deeply nested groups (elements nested past a normal depth) and couldn't be processed.",
    );
  }

  if (!shapes.length) throw new Error('No flat-filled shapes were found in this SVG.');

  // bbox across everything
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  shapes.forEach((s) =>
    s.loops.forEach((l) =>
      l.forEach((p) => {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }),
    ),
  );

  return {
    shapes,
    bbox: { minX, minY, maxX, maxY },
    rawSVGCircle,
    userUnitMM,
    viewBox: vb ? { w: vbW, h: vbH } : null,
    canvas,
  };
}
