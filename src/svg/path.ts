import type { Loop, Pt } from '../types';

// Max perpendicular deviation (SVG user units) a subdivided chord may have from the true
// curve before we stop splitting. ~500-unit-wide artwork is typical (see stubs/*.svg), so this
// stays well under print-visible error at any reasonable final mm scale while letting flat/small
// curves bail out after 1-2 segments instead of the old fixed 18.
const BEZIER_TOLERANCE = 0.15;
// Recursion cap: bounds worst case at 2**6 = 64 segments per curve (in line with flattenArc's
// existing 48-segment cap for a full circle) so a degenerate curve can't blow up rebuild time.
const BEZIER_MAX_DEPTH = 6;

function midpoint(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

// Perpendicular distance from p to the line through a-b (falls back to point distance if a===b).
function pointLineDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(dx * (p.y - a.y) - dy * (p.x - a.x)) / len;
}

export function flattenCubic(
  p0: Pt,
  p1: Pt,
  p2: Pt,
  p3: Pt,
  out: Pt[],
  tol: number = BEZIER_TOLERANCE,
  depth = 0,
): void {
  const flat =
    depth >= BEZIER_MAX_DEPTH ||
    (pointLineDist(p1, p0, p3) <= tol && pointLineDist(p2, p0, p3) <= tol);
  if (flat) {
    out.push(p3);
    return;
  }
  const p01 = midpoint(p0, p1),
    p12 = midpoint(p1, p2),
    p23 = midpoint(p2, p3);
  const p012 = midpoint(p01, p12),
    p123 = midpoint(p12, p23);
  const p0123 = midpoint(p012, p123);
  flattenCubic(p0, p01, p012, p0123, out, tol, depth + 1);
  flattenCubic(p0123, p123, p23, p3, out, tol, depth + 1);
}

export function flattenQuad(
  p0: Pt,
  p1: Pt,
  p2: Pt,
  out: Pt[],
  tol: number = BEZIER_TOLERANCE,
  depth = 0,
): void {
  const flat = depth >= BEZIER_MAX_DEPTH || pointLineDist(p1, p0, p2) <= tol;
  if (flat) {
    out.push(p2);
    return;
  }
  const p01 = midpoint(p0, p1),
    p12 = midpoint(p1, p2);
  const p012 = midpoint(p01, p12);
  flattenQuad(p0, p01, p012, out, tol, depth + 1);
  flattenQuad(p012, p12, p2, out, tol, depth + 1);
}

/** SVG elliptical arc -> polyline, via center parameterization (SVG spec F.6.5). */
export function flattenArc(
  p0: Pt,
  rx: number,
  ry: number,
  xRotDeg: number,
  largeArc: boolean,
  sweep: boolean,
  p1: Pt,
  out: Pt[],
): void {
  if (rx === 0 || ry === 0) {
    out.push(p1);
    return;
  }
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (xRotDeg * Math.PI) / 180,
    cosPhi = Math.cos(phi),
    sinPhi = Math.sin(phi);
  const dx2 = (p0.x - p1.x) / 2,
    dy2 = (p0.y - p1.y) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const sign = largeArc !== sweep ? 1 : -1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, num / den) || 0);
  const cxp = co * ((rx * y1p) / ry);
  const cyp = co * ((-ry * x1p) / rx);
  const cx = cosPhi * cxp - sinPhi * cyp + (p0.x + p1.x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (p0.y + p1.y) / 2;
  function angle(ux: number, uy: number, vx: number, vy: number): number {
    const dot = ux * vx + uy * vy,
      len = Math.sqrt(ux * ux + uy * uy) * Math.sqrt(vx * vx + vy * vy);
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  }
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;
  const segs = Math.max(4, Math.ceil(Math.abs(dTheta) / (Math.PI / 24)));
  for (let i = 1; i <= segs; i++) {
    const t = theta1 + dTheta * (i / segs);
    const ex = cx + rx * Math.cos(t) * cosPhi - ry * Math.sin(t) * sinPhi;
    const ey = cy + rx * Math.cos(t) * sinPhi + ry * Math.sin(t) * cosPhi;
    out.push({ x: ex, y: ey });
  }
}

/**
 * Flatten an SVG path `d` string into polyline loops (one per subpath).
 * Handles M/L/H/V/C/S/Q/T/A/Z, relative commands, and implicit command repetition.
 */
export function parsePathD(d: string): Loop[] {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
  let i = 0;
  function nums(n: number): number[] {
    const r: number[] = [];
    for (let k = 0; k < n; k++) r.push(parseFloat(tokens[i++]));
    return r;
  }
  const loops: Loop[] = [];
  let cur: Loop = [];
  let cx = 0,
    cy = 0,
    startX = 0,
    startY = 0;
  let prevCmd: string | null = null,
    prevCtrl: Pt | null = null;
  while (i < tokens.length) {
    let cmd: string | null = tokens[i];
    if (/^[a-zA-Z]$/.test(cmd)) i++;
    else cmd = prevCmd; // implicit repeat
    if (!cmd) break;
    const rel: boolean = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (C === 'M') {
      const [x, y] = nums(2);
      const nx = rel ? cx + x : x,
        ny = rel ? cy + y : y;
      if (cur.length) loops.push(cur);
      cur = [{ x: nx, y: ny }];
      cx = nx;
      cy = ny;
      startX = nx;
      startY = ny;
      prevCmd = rel ? 'l' : 'L';
    } else if (C === 'L') {
      const [x, y] = nums(2);
      const nx = rel ? cx + x : x,
        ny = rel ? cy + y : y;
      cur.push({ x: nx, y: ny });
      cx = nx;
      cy = ny;
      prevCmd = cmd;
    } else if (C === 'H') {
      const [x] = nums(1);
      const nx = rel ? cx + x : x;
      cur.push({ x: nx, y: cy });
      cx = nx;
      prevCmd = cmd;
    } else if (C === 'V') {
      const [y] = nums(1);
      const ny = rel ? cy + y : y;
      cur.push({ x: cx, y: ny });
      cy = ny;
      prevCmd = cmd;
    } else if (C === 'C') {
      const [x1, y1, x2, y2, x, y] = nums(6);
      const p1 = { x: rel ? cx + x1 : x1, y: rel ? cy + y1 : y1 };
      const p2 = { x: rel ? cx + x2 : x2, y: rel ? cy + y2 : y2 };
      const p3 = { x: rel ? cx + x : x, y: rel ? cy + y : y };
      flattenCubic({ x: cx, y: cy }, p1, p2, p3, cur);
      cx = p3.x;
      cy = p3.y;
      prevCtrl = p2;
      prevCmd = cmd;
    } else if (C === 'S') {
      const [x2, y2, x, y] = nums(4);
      const p1: Pt = prevCtrl
        ? { x: 2 * cx - prevCtrl.x, y: 2 * cy - prevCtrl.y }
        : { x: cx, y: cy };
      const p2 = { x: rel ? cx + x2 : x2, y: rel ? cy + y2 : y2 };
      const p3 = { x: rel ? cx + x : x, y: rel ? cy + y : y };
      flattenCubic({ x: cx, y: cy }, p1, p2, p3, cur);
      cx = p3.x;
      cy = p3.y;
      prevCtrl = p2;
      prevCmd = cmd;
    } else if (C === 'Q') {
      const [x1, y1, x, y] = nums(4);
      const p1 = { x: rel ? cx + x1 : x1, y: rel ? cy + y1 : y1 };
      const p2 = { x: rel ? cx + x : x, y: rel ? cy + y : y };
      flattenQuad({ x: cx, y: cy }, p1, p2, cur);
      cx = p2.x;
      cy = p2.y;
      prevCtrl = p1;
      prevCmd = cmd;
    } else if (C === 'T') {
      const [x, y] = nums(2);
      const p1: Pt = prevCtrl
        ? { x: 2 * cx - prevCtrl.x, y: 2 * cy - prevCtrl.y }
        : { x: cx, y: cy };
      const p2 = { x: rel ? cx + x : x, y: rel ? cy + y : y };
      flattenQuad({ x: cx, y: cy }, p1, p2, cur);
      cx = p2.x;
      cy = p2.y;
      prevCtrl = p1;
      prevCmd = cmd;
    } else if (C === 'A') {
      const [rx, ry, rot, laf, sf, x, y] = nums(7);
      const p1 = { x: rel ? cx + x : x, y: rel ? cy + y : y };
      flattenArc({ x: cx, y: cy }, rx, ry, rot, !!laf, !!sf, p1, cur);
      cx = p1.x;
      cy = p1.y;
      prevCmd = cmd;
    } else if (C === 'Z') {
      cur.push({ x: startX, y: startY });
      cx = startX;
      cy = startY;
      prevCmd = cmd;
    } else {
      i++;
      continue;
    }
    if (C !== 'C' && C !== 'S' && C !== 'Q' && C !== 'T' && C !== 'A') prevCtrl = null;
  }
  if (cur.length) loops.push(cur);
  return loops;
}

/** Signed area of a loop (>0 = CCW in standard math orientation). */
export function signedArea(loop: Loop): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i],
      q = loop[(i + 1) % loop.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function ellipsePoints(cx: number, cy: number, rx: number, ry: number, segs = 64): Loop {
  const pts: Loop = [];
  for (let i = 0; i < segs; i++) {
    const t = (i / segs) * Math.PI * 2;
    pts.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
  }
  pts.push(pts[0]);
  return pts;
}
