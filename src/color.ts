export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export interface Lab {
  l: number;
  a: number;
  b: number;
}

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/**
 * sRGB hex -> CIELAB (D65 white point). Used only to judge "how visually similar are these two
 * colors" for auto-merge clustering (see deltaE) — not for display or storage.
 */
export function hexToLab(hex: string): Lab {
  const { r, g, b } = hexToRgb(hex);
  const rl = srgbToLinear(r),
    gl = srgbToLinear(g),
    bl = srgbToLinear(b);
  const x = (rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) / 0.95047,
    y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.072175,
    z = (rl * 0.0193339 + gl * 0.119192 + bl * 0.9503041) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x),
    fy = f(y),
    fz = f(z);
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** CIE76 Euclidean distance in Lab space — coarse but adequate for grouping "visually similar"
 * colors; see the plan's threshold tuning against stubs/ sample artwork. */
export function deltaE(c1: Lab, c2: Lab): number {
  return Math.hypot(c1.l - c2.l, c1.a - c2.a, c1.b - c2.b);
}

/** Average several hex colors — preview swatch for a merged recess group. */
export function blendHexes(hexes: string[]): string {
  const rgbs = hexes.map(hexToRgb);
  const r = Math.round(rgbs.reduce((s, c) => s + c.r, 0) / rgbs.length);
  const g = Math.round(rgbs.reduce((s, c) => s + c.g, 0) / rgbs.length);
  const b = Math.round(rgbs.reduce((s, c) => s + c.b, 0) / rgbs.length);
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}
