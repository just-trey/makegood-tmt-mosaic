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

function linearToSrgb(v: number): number {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

/**
 * sRGB hex -> CIELAB (D65 white point). Used with deltaE wherever "how visually similar are
 * these two colors" needs a real answer: auto-merge clustering, and the nearest-owned-filament
 * match shown on screen. Not for storage; every consumer downstream speaks hex.
 */
export function hexToLab(hex: string): Lab {
  const { r, g, b } = hexToRgb(hex);
  return rgbToLab(r, g, b);
}

/** hexToLab's channel-wise form — the raster quantizer clusters over pixels, which have no hex. */
export function rgbToLab(r: number, g: number, b: number): Lab {
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

/**
 * The inverse of rgbToLab, as `#rrggbb`. The raster quantizer averages colors in Lab (where a mean
 * is perceptually sensible) but every consumer downstream — SVGShape.fill, the swatches, the 3MF
 * materials — speaks hex, so a cluster centroid has to come back out here.
 */
export function labToHex(lab: Lab): string {
  const fy = (lab.l + 16) / 116;
  const fx = fy + lab.a / 500;
  const fz = fy - lab.b / 200;
  const finv = (t: number) => (t * t * t > 0.008856 ? t * t * t : (t - 16 / 116) / 7.787);
  const x = finv(fx) * 0.95047,
    y = finv(fy),
    z = finv(fz) * 1.08883;
  const r = linearToSrgb(3.2404542 * x - 1.5371385 * y - 0.4985314 * z);
  const g = linearToSrgb(-0.969266 * x + 1.8760108 * y + 0.041556 * z);
  const b = linearToSrgb(0.0556434 * x - 0.2040259 * y + 1.0572252 * z);
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
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
