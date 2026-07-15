export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Average several hex colors — preview swatch for a merged recess group. */
export function blendHexes(hexes: string[]): string {
  const rgbs = hexes.map(hexToRgb);
  const r = Math.round(rgbs.reduce((s, c) => s + c.r, 0) / rgbs.length);
  const g = Math.round(rgbs.reduce((s, c) => s + c.g, 0) / rgbs.length);
  const b = Math.round(rgbs.reduce((s, c) => s + c.b, 0) / rgbs.length);
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}
