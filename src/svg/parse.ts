import type { Loop, Mat6, ParsedSVG, SVGShape } from '../types';
import { Mat, parseTransformAttr } from './matrix';
import { ellipsePoints, parsePathD } from './path';
import { clearWarnings, warn } from '../warnings';

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
  try { colorCanvas.fillStyle = str; } catch { return null; }
  const out = String(colorCanvas.fillStyle);
  if (/^#([0-9a-f]{6})$/i.test(out)) return out.toLowerCase();
  const m = out.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) {
    return '#' + [1, 2, 3].map(i => (+m[i]).toString(16).padStart(2, '0')).join('');
  }
  return '#000000';
}

/** Read a presentation property from the style attribute first, then the attribute. */
export function getStyleProp(el: Element, prop: string): string | null {
  const style = el.getAttribute('style');
  if (style) {
    const m = style.match(new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)'));
    if (m) return m[1].trim();
  }
  return el.getAttribute(prop);
}

/**
 * Parse SVG markup into flat lists of {fill, loops} in SVG user-space units,
 * with all transforms (including viewBox translation) baked in.
 */
export function parseSVGDocument(svgText: string): ParsedSVG {
  clearWarnings();
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const perr = doc.querySelector('parsererror');
  if (perr) throw new Error('SVG could not be parsed — check the file is valid XML.');
  const svgEl = doc.documentElement;

  // Root transform from the viewBox origin. viewBox coordinate space is treated directly as
  // our working units; width/height attributes are ignored for scale purposes since artwork
  // is re-fit to the physical footprint later anyway.
  let rootM = Mat.identity();
  const vb = svgEl.getAttribute('viewBox');
  if (vb) {
    const [vx, vy] = vb.trim().split(/[\s,]+/).map(Number);
    rootM = Mat.translate(-vx, -vy);
  }

  const shapes: SVGShape[] = [];
  let order = 0;

  function getAncestorFill(el: Element): string | null {
    let p = el.parentElement;
    while (p) {
      const f = getStyleProp(p, 'fill');
      if (f && !/url\(/.test(f)) return f;
      p = p.parentElement;
    }
    return null;
  }

  function walk(el: Element, parentM: Mat6): void {
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (!tag) return;
    if (['defs', 'symbol', 'clippath', 'mask', 'pattern', 'title', 'desc', 'style', 'metadata'].includes(tag)) return;

    const localM = parseTransformAttr(el.getAttribute('transform'));
    const M = Mat.multiply(parentM, localM);

    const fillRaw = getStyleProp(el, 'fill');
    const fillUrl = fillRaw && /url\(/.test(fillRaw);
    const opacity = parseFloat(getStyleProp(el, 'fill-opacity') || '');
    const displayNone = getStyleProp(el, 'display') === 'none';

    if (tag === 'path' || tag === 'rect' || tag === 'circle' || tag === 'ellipse' || tag === 'polygon' || tag === 'polyline') {
      if (!displayNone) {
        if (fillUrl) {
          warn('Skipped a <' + tag + '> with a gradient/pattern fill (not a flat color) — element ignored.');
        } else if (fillRaw === 'none') {
          // no fill, e.g. stroke-only outline — ignored for inlay purposes
        } else if (opacity === 0) {
          // invisible, ignore
        } else {
          const hex = normalizeColor(fillRaw || getAncestorFill(el) || '#000000');
          let loops: Loop[] = [];
          if (tag === 'path') {
            const d = el.getAttribute('d');
            if (d) loops = parsePathD(d);
          } else if (tag === 'rect') {
            const x = +(el.getAttribute('x') || 0), y = +(el.getAttribute('y') || 0);
            const w = +(el.getAttribute('width') || 0), h = +(el.getAttribute('height') || 0);
            const rxAttr = el.getAttribute('rx'), ryAttr = el.getAttribute('ry');
            let rx = rxAttr ? +rxAttr : (ryAttr ? +ryAttr : 0);
            let ry = ryAttr ? +ryAttr : rx;
            if (w > 0 && h > 0) {
              if (rx > 0 && ry > 0) {
                rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
                const seg = 12, pts: Loop = [];
                const corners: [number, number, number, number][] = [
                  [x + w - rx, y + ry, -90, 0], [x + w - rx, y + h - ry, 0, 90],
                  [x + rx, y + h - ry, 90, 180], [x + rx, y + ry, 180, 270],
                ];
                corners.forEach(([ccx, ccy, a0, a1]) => {
                  for (let k = 0; k <= seg; k++) {
                    const t = (a0 + (a1 - a0) * k / seg) * Math.PI / 180;
                    pts.push({ x: ccx + rx * Math.cos(t), y: ccy + ry * Math.sin(t) });
                  }
                });
                pts.push(pts[0]);
                loops = [pts];
              } else {
                loops = [[{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y }]];
              }
            }
          } else if (tag === 'circle') {
            const cxA = +(el.getAttribute('cx') || 0), cyA = +(el.getAttribute('cy') || 0), r = +(el.getAttribute('r') || 0);
            if (r > 0) loops = [ellipsePoints(cxA, cyA, r, r)];
          } else if (tag === 'ellipse') {
            const cxA = +(el.getAttribute('cx') || 0), cyA = +(el.getAttribute('cy') || 0);
            const rx = +(el.getAttribute('rx') || 0), ry = +(el.getAttribute('ry') || 0);
            if (rx > 0 && ry > 0) loops = [ellipsePoints(cxA, cyA, rx, ry)];
          } else if (tag === 'polygon' || tag === 'polyline') {
            const pts = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
            const loop: Loop = [];
            for (let k = 0; k < pts.length - 1; k += 2) loop.push({ x: pts[k], y: pts[k + 1] });
            if (tag === 'polygon' && loop.length) loop.push(loop[0]);
            loops = [loop];
          }
          loops = loops.filter(l => l.length >= 3).map(l => l.map(p => Mat.apply(M, p.x, p.y)));
          if (loops.length) {
            shapes.push({ fill: hex || '#000000', loops, order: order++ });
          }
        }
      }
    }
    for (const child of el.children) walk(child, M);
  }

  for (const child of svgEl.children) walk(child, rootM);

  if (!shapes.length) throw new Error('No flat-filled shapes were found in this SVG.');

  // bbox across everything
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  shapes.forEach(s => s.loops.forEach(l => l.forEach(p => {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  })));

  // For assembly mode: the largest <circle> (typically the design's outer/background boundary)
  // lets real-mesh parts be mapped hub-centered without re-deriving a bbox fit.
  let rawSVGCircle: ParsedSVG['rawSVGCircle'] = null;
  let bestR = -1;
  doc.querySelectorAll('circle').forEach(c => {
    const r = parseFloat(c.getAttribute('r') || '');
    if (r > bestR) {
      bestR = r;
      rawSVGCircle = { cx: parseFloat(c.getAttribute('cx') || '0'), cy: parseFloat(c.getAttribute('cy') || '0'), r };
    }
  });

  return { shapes, bbox: { minX, minY, maxX, maxY }, rawSVGCircle };
}
