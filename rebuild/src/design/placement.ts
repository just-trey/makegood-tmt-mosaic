import { intersection, isEmpty, mapMp, unionAll, type Bounds, type MultiPolygon, type Pt } from './poly';
import type { ColorRegion } from './regions';

export interface Placement {
  /** Centre of the design on the surface, local mm. */
  x: number;
  y: number;
  scale: number;
  rotationDeg: number;
  flipH: boolean;
  flipV: boolean;
}

export type DesignMode = 'sticker' | 'fill';

export interface DesignSource {
  id: string;
  name: string;
  kind: 'svg' | 'image';
  widthMm: number;
  heightMm: number;
  /** In design mm, y down, origin at the design's top-left. */
  regions: ColorRegion[];
  warnings: string[];
}

export interface PlacedDesign {
  id: string;
  source: DesignSource;
  surfaceId: string;
  placement: Placement;
  mode: DesignMode;
  /** Fill only: gap between tiles, mm. */
  tileGapMm: number;
  mirror: boolean;
}

export const MAX_FILL_TILES = 400;

export function defaultPlacement(): Placement {
  return { x: 0, y: 0, scale: 1, rotationDeg: 0, flipH: false, flipV: false };
}

/** Design mm (y down, top-left origin) -> surface local mm (y up), through the placement. */
export function designToLocalPoint(d: { widthMm: number; heightMm: number }, p: Placement, pt: Pt): Pt {
  let dx = pt[0] - d.widthMm / 2;
  let dy = -(pt[1] - d.heightMm / 2);
  if (p.flipH) dx = -dx;
  if (p.flipV) dy = -dy;
  const r = (p.rotationDeg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return [p.x + p.scale * (c * dx - s * dy), p.y + p.scale * (s * dx + c * dy)];
}

export function localToDesignPoint(d: { widthMm: number; heightMm: number }, p: Placement, pt: Pt): Pt {
  const r = (p.rotationDeg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  const ux = (pt[0] - p.x) / p.scale, uy = (pt[1] - p.y) / p.scale;
  let dx = c * ux + s * uy;
  let dy = -s * ux + c * uy;
  if (p.flipH) dx = -dx;
  if (p.flipV) dy = -dy;
  return [dx + d.widthMm / 2, -dy + d.heightMm / 2];
}

/** The design's four corners on the surface, for the frame drawn in the 3D view. */
export function designCorners(d: { widthMm: number; heightMm: number }, p: Placement): Pt[] {
  return [
    [0, 0],
    [d.widthMm, 0],
    [d.widthMm, d.heightMm],
    [0, d.heightMm],
  ].map((c) => designToLocalPoint(d, p, c as Pt));
}

export interface LocalRegions {
  byColor: Map<string, MultiPolygon>;
  warnings: string[];
}

/**
 * Every color's region in surface-local mm, placed. A fill repeats the design across the
 * surface's bounds in the design's own rotated grid; the tile count is capped so a tiny tile on
 * the chair cannot run the machine out of memory, and the cap is reported.
 */
export function placedRegions(d: PlacedDesign, surface: Bounds): LocalRegions {
  const warnings: string[] = [];
  const byColor = new Map<string, MultiPolygon>();
  const place = (offset: Pt) => (pt: Pt): Pt => {
    const q = designToLocalPoint(d.source, d.placement, pt);
    return [q[0] + offset[0], q[1] + offset[1]];
  };
  if (d.mode === 'sticker') {
    for (const r of d.source.regions) byColor.set(r.color, mapMp(r.region, place([0, 0])));
    return { byColor, warnings };
  }
  const p = d.placement;
  const tw = d.source.widthMm * p.scale + d.tileGapMm;
  const th = d.source.heightMm * p.scale + d.tileGapMm;
  if (tw <= 0.5 || th <= 0.5) {
    warnings.push(`${d.source.name}: the tile is too small to repeat, so it was placed once.`);
    for (const r of d.source.regions) byColor.set(r.color, mapMp(r.region, place([0, 0])));
    return { byColor, warnings };
  }
  const r = (p.rotationDeg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  // Cover the surface's bounding box, whatever the grid rotation: walk the box's corners into
  // grid space to find the index range.
  const corners: Pt[] = [
    [surface.minX, surface.minY],
    [surface.maxX, surface.minY],
    [surface.maxX, surface.maxY],
    [surface.minX, surface.maxY],
  ];
  let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity;
  for (const [x, y] of corners) {
    const gx = (c * (x - p.x) + s * (y - p.y)) / tw;
    const gy = (-s * (x - p.x) + c * (y - p.y)) / th;
    i0 = Math.min(i0, Math.floor(gx) - 1);
    i1 = Math.max(i1, Math.ceil(gx) + 1);
    j0 = Math.min(j0, Math.floor(gy) - 1);
    j1 = Math.max(j1, Math.ceil(gy) + 1);
  }
  const count = (i1 - i0 + 1) * (j1 - j0 + 1);
  if (count > MAX_FILL_TILES) {
    warnings.push(`${d.source.name}: a ${fmt(tw - d.tileGapMm)} mm tile would repeat ${count} times here, more than the ${MAX_FILL_TILES} this tool can cut. It was placed once. Raise Scale to fill with fewer, larger tiles.`);
    for (const reg of d.source.regions) byColor.set(reg.color, mapMp(reg.region, place([0, 0])));
    return { byColor, warnings };
  }
  const clip: MultiPolygon = [[[[surface.minX - 1, surface.minY - 1], [surface.maxX + 1, surface.minY - 1], [surface.maxX + 1, surface.maxY + 1], [surface.minX - 1, surface.maxY + 1]]]];
  for (const reg of d.source.regions) {
    const tiles: MultiPolygon[] = [];
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const ox = c * i * tw - s * j * th;
        const oy = s * i * tw + c * j * th;
        const t = mapMp(reg.region, place([ox, oy]));
        const clipped = intersection(t, clip);
        if (!isEmpty(clipped)) tiles.push(clipped);
      }
    try {
      byColor.set(reg.color, unionAll(tiles));
    } catch {
      warnings.push(`${d.source.name}: the ${reg.color} tiles couldn't be joined, so that color was placed once.`);
      byColor.set(reg.color, mapMp(reg.region, place([0, 0])));
    }
  }
  return { byColor, warnings };
}

function fmt(v: number): string {
  return (Math.round(v * 10) / 10).toString();
}

/** The reflected placement a mirrored copy takes on the paired surface. */
export function mirroredPlacement(p: Placement): Placement {
  return { ...p, x: -p.x, flipH: !p.flipH, rotationDeg: -p.rotationDeg };
}
