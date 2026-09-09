import { parseXml, type XmlNode } from '../lib/xml';
import { flattenPath } from './path';
import type { Pt, Ring } from './poly';

/** One filled SVG shape in document mm, y down, in paint order. */
export interface Shape {
  color: string;
  fillRule: 'nonzero' | 'evenodd';
  rings: Ring[];
}

export interface SvgDesign {
  widthMm: number;
  heightMm: number;
  shapes: Shape[];
  warnings: string[];
}

type Mat = [number, number, number, number, number, number];
const I: Mat = [1, 0, 0, 1, 0, 0];

function mul(a: Mat, b: Mat): Mat {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function apply(m: Mat, p: Pt): Pt {
  return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}

export function parseTransform(s: string | undefined): Mat {
  if (!s) return I;
  let m: Mat = I;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let x: RegExpExecArray | null;
  while ((x = re.exec(s))) {
    const a = x[2]
      .trim()
      .split(/[\s,]+/)
      .filter((v) => v.length)
      .map(parseFloat);
    let t: Mat = I;
    switch (x[1]) {
      case 'matrix':
        if (a.length >= 6) t = [a[0], a[1], a[2], a[3], a[4], a[5]];
        break;
      case 'translate':
        t = [1, 0, 0, 1, a[0] || 0, a[1] || 0];
        break;
      case 'scale':
        t = [a[0] ?? 1, 0, 0, a.length > 1 ? a[1] : (a[0] ?? 1), 0, 0];
        break;
      case 'rotate': {
        const r = ((a[0] || 0) * Math.PI) / 180;
        const c = Math.cos(r);
        const sn = Math.sin(r);
        t = [c, sn, -sn, c, 0, 0];
        if (a.length >= 3) t = mul(mul([1, 0, 0, 1, a[1], a[2]], t), [1, 0, 0, 1, -a[1], -a[2]]);
        break;
      }
      case 'skewX':
        t = [1, 0, Math.tan(((a[0] || 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case 'skewY':
        t = [1, Math.tan(((a[0] || 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    m = mul(m, t);
  }
  return m;
}

const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00',
  cyan: '#00ffff', aqua: '#00ffff', magenta: '#ff00ff', fuchsia: '#ff00ff', gray: '#808080', grey: '#808080',
  silver: '#c0c0c0', maroon: '#800000', olive: '#808000', lime: '#00ff00', teal: '#008080', navy: '#000080',
  purple: '#800080', orange: '#ffa500', pink: '#ffc0cb', brown: '#a52a2a', gold: '#ffd700', darkgray: '#a9a9a9',
  darkgrey: '#a9a9a9', lightgray: '#d3d3d3', lightgrey: '#d3d3d3', darkred: '#8b0000', darkgreen: '#006400',
  darkblue: '#00008b', lightblue: '#add8e6', skyblue: '#87ceeb', tan: '#d2b48c', beige: '#f5f5dc', ivory: '#fffff0',
  violet: '#ee82ee', indigo: '#4b0082', crimson: '#dc143c', coral: '#ff7f50', salmon: '#fa8072', khaki: '#f0e68c',
  turquoise: '#40e0d0', chocolate: '#d2691e', tomato: '#ff6347', orchid: '#da70d6', plum: '#dda0dd', lavender: '#e6e6fa',
};

/** Normalise a CSS color to #rrggbb, or null when it is not a flat color. */
export function normalizeColor(s: string | undefined): string | null {
  if (!s) return null;
  const v = s.trim().toLowerCase();
  if (v === 'none' || v === 'transparent') return null;
  if (v.startsWith('url(')) return null;
  if (NAMED[v]) return NAMED[v];
  if (v[0] === '#') {
    const h = v.slice(1);
    if (h.length === 3 || h.length === 4) return '#' + h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length === 6 || h.length === 8) return '#' + h.slice(0, 6);
    return null;
  }
  const m = /^rgba?\(([^)]*)\)$/.exec(v);
  if (m) {
    const parts = m[1].split(/[\s,\/]+/).filter((p) => p.length);
    const ch = parts.slice(0, 3).map((p) => {
      const pct = p.endsWith('%');
      const n = parseFloat(p);
      const b = pct ? (n / 100) * 255 : n;
      return Math.max(0, Math.min(255, Math.round(b)));
    });
    if (ch.length === 3 && ch.every((c) => Number.isFinite(c))) return '#' + ch.map((c) => c.toString(16).padStart(2, '0')).join('');
  }
  return null;
}

function styleOf(node: XmlNode): Record<string, string> {
  const out: Record<string, string> = {};
  const st = node.attrs.style;
  if (st)
    for (const decl of st.split(';')) {
      const i = decl.indexOf(':');
      if (i > 0) out[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim();
    }
  return out;
}

function prop(node: XmlNode, name: string): string | undefined {
  const st = styleOf(node);
  return st[name] ?? node.attrs[name];
}

const UNIT_MM: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, '': 25.4 / 96 };

function lengthMm(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^\s*([-+]?[\d.]+(?:e[-+]?\d+)?)\s*([a-z%]*)\s*$/i.exec(s);
  if (!m) return null;
  if (m[2] === '%') return null;
  const k = UNIT_MM[m[2].toLowerCase()];
  if (k === undefined) return null;
  return parseFloat(m[1]) * k;
}

const NON_RENDERED = new Set(['defs', 'clippath', 'mask', 'symbol', 'marker', 'pattern', 'lineargradient', 'radialgradient', 'style', 'title', 'desc', 'metadata', 'filter']);

interface Ctx {
  m: Mat;
  fill: string | undefined;
  fillRule: 'nonzero' | 'evenodd';
  visible: boolean;
}

export function parseSvg(text: string): SvgDesign {
  const doc = parseXml(text);
  const svg = doc.children.find((c) => c.local === 'svg');
  const warnings: string[] = [];
  if (!svg) return { widthMm: 0, heightMm: 0, shapes: [], warnings: ["This file isn't an SVG. Export it again as SVG and reload."] };

  const vb = (svg.attrs.viewBox ?? svg.attrs.viewbox)?.trim().split(/[\s,]+/).map(parseFloat);
  const hasVb = !!vb && vb.length === 4 && vb.every((v) => Number.isFinite(v)) && vb[2] > 0 && vb[3] > 0;
  let wMm = lengthMm(svg.attrs.width);
  let hMm = lengthMm(svg.attrs.height);
  let vbx = 0, vby = 0, vbw = 0, vbh = 0;
  if (hasVb) [vbx, vby, vbw, vbh] = vb!;
  if (wMm === null || hMm === null) {
    if (hasVb) {
      if (wMm !== null && hMm === null) hMm = (wMm * vbh) / vbw;
      else if (hMm !== null && wMm === null) wMm = (hMm * vbw) / vbh;
      else {
        wMm = vbw;
        hMm = vbh;
        warnings.push(`The SVG has no size in mm, so its drawing units are read as mm: ${fmt(vbw)} × ${fmt(vbh)} mm. Set a size in your editor if that's wrong.`);
      }
    } else {
      return { widthMm: 0, heightMm: 0, shapes: [], warnings: ['The SVG has no width, height or viewBox, so nothing can be sized. Set a document size in your editor and export again.'] };
    }
  }
  if (!hasVb) {
    // No viewBox: user units are CSS px.
    vbw = wMm! / UNIT_MM.px;
    vbh = hMm! / UNIT_MM.px;
  }
  // Document units -> mm, y down, origin at the top-left of the viewBox.
  const root: Mat = mul([wMm! / vbw, 0, 0, hMm! / vbh, 0, 0], [1, 0, 0, 1, -vbx, -vby]);
  const shapes: Shape[] = [];
  const byId = new Map<string, XmlNode>();
  (function index(n: XmlNode) {
    if (n.attrs.id) byId.set(n.attrs.id, n);
    for (const c of n.children) index(c);
  })(svg);
  let skippedPaint = 0;
  let strokeOnly = 0;
  let useDepth = 0;

  const walk = (node: XmlNode, ctx: Ctx) => {
    const tag = node.local.toLowerCase();
    if (NON_RENDERED.has(tag)) return;
    const st = styleOf(node);
    if ((st.display ?? node.attrs.display) === 'none') return;
    const visible = ctx.visible && (st.visibility ?? node.attrs.visibility) !== 'hidden';
    const m = mul(ctx.m, parseTransform(node.attrs.transform));
    const fillAttr = st.fill ?? node.attrs.fill;
    const fill = fillAttr !== undefined ? fillAttr : ctx.fill;
    const frAttr = (st['fill-rule'] ?? node.attrs['fill-rule'])?.trim();
    const fillRule = frAttr === 'evenodd' ? 'evenodd' : frAttr === 'nonzero' ? 'nonzero' : ctx.fillRule;
    const c: Ctx = { m, fill, fillRule, visible };
    if (tag === 'g' || tag === 'svg' || tag === 'a' || tag === 'switch') {
      for (const ch of node.children) walk(ch, c);
      return;
    }
    if (tag === 'use') {
      const href = node.attrs.href ?? node.attrs['xlink:href'];
      const target = href && href.startsWith('#') ? byId.get(href.slice(1)) : undefined;
      if (target && useDepth < 8) {
        useDepth++;
        const ux = parseFloat(node.attrs.x ?? '0') || 0;
        const uy = parseFloat(node.attrs.y ?? '0') || 0;
        walk(target, { ...c, m: mul(m, [1, 0, 0, 1, ux, uy]) });
        useDepth--;
      }
      return;
    }
    const rings = shapeRings(node, tag, m);
    if (!rings) return;
    if (!visible) return;
    const resolved = fill === undefined ? '#000000' : normalizeColor(fill);
    if (resolved === null) {
      if (fill && fill.trim().toLowerCase().startsWith('url(')) skippedPaint++;
      else if (prop(node, 'stroke') && normalizeColor(prop(node, 'stroke'))) strokeOnly++;
      return;
    }
    const tr = rings.map((r) => r.map((p) => apply(m, p)));
    shapes.push({ color: resolved, fillRule, rings: tr });
  };
  walk(svg, { m: root, fill: undefined, fillRule: 'nonzero', visible: true });

  if (skippedPaint) warnings.push(`${skippedPaint} shape${skippedPaint === 1 ? '' : 's'} with a gradient or pattern fill ${skippedPaint === 1 ? 'was' : 'were'} skipped. Give ${skippedPaint === 1 ? 'it' : 'them'} a flat color to print ${skippedPaint === 1 ? 'it' : 'them'}.`);
  if (strokeOnly) warnings.push(`${strokeOnly} outline-only shape${strokeOnly === 1 ? '' : 's'} (stroke, no fill) ${strokeOnly === 1 ? 'was' : 'were'} skipped. Convert strokes to filled shapes in your editor to print them.`);
  if (shapes.length === 0 && !warnings.some((w) => w.startsWith('This file'))) warnings.push('No filled shapes were found in the SVG.');
  return { widthMm: wMm!, heightMm: hMm!, shapes, warnings };
}

function fmt(v: number): string {
  return (Math.round(v * 100) / 100).toString();
}

function num(node: XmlNode, name: string, dflt = 0): number {
  const v = parseFloat(node.attrs[name] ?? '');
  return Number.isFinite(v) ? v : dflt;
}

function ellipseRing(cx: number, cy: number, rx: number, ry: number, m: Mat): Ring {
  // Segment count from the transformed radius, so a scaled-up circle stays round.
  const sc = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
  const r = Math.max(rx, ry) * sc;
  const n = Math.max(24, Math.min(360, Math.ceil((2 * Math.PI) / (2 * Math.acos(Math.max(0, 1 - 0.05 / Math.max(r, 0.05)))))));
  const ring: Ring = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    ring.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return ring;
}

function shapeRings(node: XmlNode, tag: string, m: Mat): Ring[] | null {
  const sc = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
  const tol = 0.03 / sc;
  switch (tag) {
    case 'path': {
      const d = node.attrs.d;
      if (!d) return null;
      return flattenPath(d, tol)
        .filter((s) => s.points.length >= 3)
        .map((s) => s.points);
    }
    case 'rect': {
      const x = num(node, 'x'), y = num(node, 'y'), w = num(node, 'width'), h = num(node, 'height');
      if (w <= 0 || h <= 0) return null;
      let rx = num(node, 'rx', NaN), ry = num(node, 'ry', NaN);
      if (isNaN(rx) && isNaN(ry)) rx = ry = 0;
      else if (isNaN(rx)) rx = ry;
      else if (isNaN(ry)) ry = rx;
      rx = Math.min(rx, w / 2);
      ry = Math.min(ry, h / 2);
      if (rx <= 0 || ry <= 0)
        return [
          [
            [x, y],
            [x + w, y],
            [x + w, y + h],
            [x, y + h],
          ],
        ];
      const d = `M${x + rx},${y}H${x + w - rx}A${rx},${ry} 0 0 1 ${x + w},${y + ry}V${y + h - ry}A${rx},${ry} 0 0 1 ${x + w - rx},${y + h}H${x + rx}A${rx},${ry} 0 0 1 ${x},${y + h - ry}V${y + ry}A${rx},${ry} 0 0 1 ${x + rx},${y}Z`;
      return flattenPath(d, tol).map((s) => s.points);
    }
    case 'circle': {
      const r = num(node, 'r');
      if (r <= 0) return null;
      return [ellipseRing(num(node, 'cx'), num(node, 'cy'), r, r, m)];
    }
    case 'ellipse': {
      const rx = num(node, 'rx'), ry = num(node, 'ry');
      if (rx <= 0 || ry <= 0) return null;
      return [ellipseRing(num(node, 'cx'), num(node, 'cy'), rx, ry, m)];
    }
    case 'polygon':
    case 'polyline': {
      const nums = (node.attrs.points ?? '').match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g)?.map(parseFloat) ?? [];
      const ring: Ring = [];
      for (let i = 0; i + 1 < nums.length; i += 2) ring.push([nums[i], nums[i + 1]]);
      return ring.length >= 3 ? [ring] : null;
    }
    default:
      return null;
  }
}
