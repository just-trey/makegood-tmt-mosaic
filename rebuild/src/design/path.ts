import type { Pt } from './poly';

export interface Subpath {
  points: Pt[];
  closed: boolean;
}

const NUM = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;

function tokenize(d: string): (string | number)[] {
  const out: (string | number)[] = [];
  const re = /([MmZzLlHhVvCcSsQqTtAa])|([-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) out.push(m[1] ? m[1] : parseFloat(m[2]));
  return out;
}

function cubicPts(p0: Pt, p1: Pt, p2: Pt, p3: Pt, tol: number, out: Pt[]): void {
  // Flatness estimate from the control polygon; recurse until it is under tol.
  const dx = p3[0] - p0[0];
  const dy = p3[1] - p0[1];
  const d1 = Math.abs((p1[0] - p3[0]) * dy - (p1[1] - p3[1]) * dx);
  const d2 = Math.abs((p2[0] - p3[0]) * dy - (p2[1] - p3[1]) * dx);
  const flat = (d1 + d2) * (d1 + d2) <= tol * tol * (dx * dx + dy * dy) * 16;
  const tiny = Math.abs(dx) + Math.abs(dy) < tol && Math.abs(p1[0] - p0[0]) + Math.abs(p1[1] - p0[1]) < tol;
  if (flat || tiny || out.length > 20000) {
    out.push(p3);
    return;
  }
  const p01: Pt = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
  const p12: Pt = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
  const p23: Pt = [(p2[0] + p3[0]) / 2, (p2[1] + p3[1]) / 2];
  const p012: Pt = [(p01[0] + p12[0]) / 2, (p01[1] + p12[1]) / 2];
  const p123: Pt = [(p12[0] + p23[0]) / 2, (p12[1] + p23[1]) / 2];
  const mid: Pt = [(p012[0] + p123[0]) / 2, (p012[1] + p123[1]) / 2];
  cubicPts(p0, p01, p012, mid, tol, out);
  cubicPts(mid, p123, p23, p3, tol, out);
}

function arcPts(p0: Pt, rx: number, ry: number, rot: number, large: boolean, sweep: boolean, p1: Pt, tol: number, out: Pt[]): void {
  if (rx === 0 || ry === 0 || (p0[0] === p1[0] && p0[1] === p1[1])) {
    out.push(p1);
    return;
  }
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (rot * Math.PI) / 180;
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);
  const hx = (p0[0] - p1[0]) / 2;
  const hy = (p0[1] - p1[1]) / 2;
  const x1 = cp * hx + sp * hy;
  const y1 = -sp * hx + cp * hy;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) coef = -coef;
  const cx1 = (coef * rx * y1) / ry;
  const cy1 = (-coef * ry * x1) / rx;
  const cx = cp * cx1 - sp * cy1 + (p0[0] + p1[0]) / 2;
  const cy = sp * cx1 + cp * cy1 + (p0[1] + p1[1]) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  const r = Math.max(rx, ry);
  const step = Math.min(Math.PI / 4, 2 * Math.acos(Math.max(0, 1 - tol / r)) || Math.PI / 4);
  const segs = Math.max(1, Math.ceil(Math.abs(dt) / step));
  for (let i = 1; i <= segs; i++) {
    const t = t1 + (dt * i) / segs;
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    out.push([cp * ex - sp * ey + cx, sp * ex + cp * ey + cy]);
  }
  out[out.length - 1] = p1;
}

/** Flatten an SVG path's `d` into polylines. `tol` is the chord tolerance in path units. */
export function flattenPath(d: string, tol = 0.05): Subpath[] {
  const t = tokenize(d);
  const subs: Subpath[] = [];
  let cur: Subpath | null = null;
  let cmd = '';
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let px = 0;
  let py = 0;
  let i = 0;
  const num = (): number => {
    const v = t[i++];
    return typeof v === 'number' ? v : NaN;
  };
  const start = (nx: number, ny: number) => {
    cur = { points: [[nx, ny]], closed: false };
    subs.push(cur);
    sx = x = nx;
    sy = y = ny;
  };
  const lineTo = (nx: number, ny: number) => {
    if (!cur) start(x, y);
    cur!.points.push([nx, ny]);
    x = nx;
    y = ny;
  };
  while (i < t.length) {
    const tok = t[i];
    if (typeof tok === 'string') {
      cmd = tok;
      i++;
      if (cmd === 'Z' || cmd === 'z') {
        const open = cur as Subpath | null;
        if (open) open.closed = true;
        x = sx;
        y = sy;
        cur = null;
        continue;
      }
    } else if (!cmd) {
      i++;
      continue;
    }
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case 'M': {
        const nx = num() + ox;
        const ny = num() + oy;
        if (isNaN(nx) || isNaN(ny)) return subs;
        start(nx, ny);
        cmd = rel ? 'l' : 'L';
        break;
      }
      case 'L': {
        const nx = num() + ox;
        const ny = num() + oy;
        if (isNaN(nx) || isNaN(ny)) return subs;
        lineTo(nx, ny);
        break;
      }
      case 'H': {
        const nx = num() + ox;
        if (isNaN(nx)) return subs;
        lineTo(nx, y);
        break;
      }
      case 'V': {
        const ny = num() + oy;
        if (isNaN(ny)) return subs;
        lineTo(x, ny);
        break;
      }
      case 'C': {
        const x1 = num() + ox, y1 = num() + oy, x2 = num() + ox, y2 = num() + oy, nx = num() + ox, ny = num() + oy;
        if (isNaN(ny)) return subs;
        if (!cur) start(x, y);
        cubicPts([x, y], [x1, y1], [x2, y2], [nx, ny], tol, cur!.points);
        px = x2;
        py = y2;
        x = nx;
        y = ny;
        break;
      }
      case 'S': {
        const x2 = num() + ox, y2 = num() + oy, nx = num() + ox, ny = num() + oy;
        if (isNaN(ny)) return subs;
        const prevC = 'CcSs'.includes(t[i - 5] as string) ? false : true;
        const x1 = prevC ? x : 2 * x - px;
        const y1 = prevC ? y : 2 * y - py;
        if (!cur) start(x, y);
        cubicPts([x, y], [x1, y1], [x2, y2], [nx, ny], tol, cur!.points);
        px = x2;
        py = y2;
        x = nx;
        y = ny;
        break;
      }
      case 'Q': {
        const x1 = num() + ox, y1 = num() + oy, nx = num() + ox, ny = num() + oy;
        if (isNaN(ny)) return subs;
        if (!cur) start(x, y);
        const c1: Pt = [x + (2 / 3) * (x1 - x), y + (2 / 3) * (y1 - y)];
        const c2: Pt = [nx + (2 / 3) * (x1 - nx), ny + (2 / 3) * (y1 - ny)];
        cubicPts([x, y], c1, c2, [nx, ny], tol, cur!.points);
        px = x1;
        py = y1;
        x = nx;
        y = ny;
        break;
      }
      case 'T': {
        const nx = num() + ox, ny = num() + oy;
        if (isNaN(ny)) return subs;
        const x1 = 2 * x - px;
        const y1 = 2 * y - py;
        if (!cur) start(x, y);
        const c1: Pt = [x + (2 / 3) * (x1 - x), y + (2 / 3) * (y1 - y)];
        const c2: Pt = [nx + (2 / 3) * (x1 - nx), ny + (2 / 3) * (y1 - ny)];
        cubicPts([x, y], c1, c2, [nx, ny], tol, cur!.points);
        px = x1;
        py = y1;
        x = nx;
        y = ny;
        break;
      }
      case 'A': {
        const rx = num(), ry = num(), rot = num(), large = num(), sweep = num(), nx = num() + ox, ny = num() + oy;
        if (isNaN(ny)) return subs;
        if (!cur) start(x, y);
        arcPts([x, y], rx, ry, rot, large !== 0, sweep !== 0, [nx, ny], tol, cur!.points);
        x = nx;
        y = ny;
        break;
      }
      default:
        i++;
    }
    if (!'CcSsQqTt'.includes(cmd)) {
      px = x;
      py = y;
    }
  }
  return subs;
}

export const NUMBER_RE = NUM;
