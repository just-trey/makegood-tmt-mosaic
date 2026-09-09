import { difference, isEmpty, mpArea, ringsToMp, union, unionAll, type MultiPolygon } from './poly';
import type { Shape } from './svg';

export interface ColorRegion {
  color: string;
  region: MultiPolygon;
  areaMm2: number;
}

export interface RegionResult {
  regions: ColorRegion[];
  /** Colors present in the file but fully hidden under later shapes. They cost no slot. */
  hidden: string[];
  warnings: string[];
}

/**
 * Resolve what is visible of each color after paint order: a shape covers everything painted
 * before it. Walking from the last shape backwards keeps one running "covered" region, so each
 * shape costs one difference and one union instead of a union over every later shape.
 */
export function resolveRegions(shapes: Shape[]): RegionResult {
  const warnings: string[] = [];
  const perColor = new Map<string, MultiPolygon[]>();
  const seen = new Set<string>();
  let covered: MultiPolygon = [];
  let failed = 0;
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    seen.add(s.color);
    let mp: MultiPolygon;
    try {
      mp = ringsToMp(s.rings, s.fillRule);
      if (isEmpty(mp)) continue;
      const visible = difference(mp, covered);
      if (!isEmpty(visible)) {
        const list = perColor.get(s.color) ?? [];
        list.push(visible);
        perColor.set(s.color, list);
      }
      covered = union(covered, mp);
    } catch {
      failed++;
      warnings.push(`One ${s.color} shape couldn't be read and was left out. Simplify or redraw that shape in your editor.`);
    }
  }
  const regions: ColorRegion[] = [];
  const hidden: string[] = [];
  // Keep first-painted order for a stable list.
  const order: string[] = [];
  for (const s of shapes) if (!order.includes(s.color)) order.push(s.color);
  for (const color of order) {
    const parts = perColor.get(color);
    if (!parts) {
      if (seen.has(color)) hidden.push(color);
      continue;
    }
    try {
      const region = unionAll(parts);
      const areaMm2 = mpArea(region);
      if (areaMm2 <= 0) hidden.push(color);
      else regions.push({ color, region, areaMm2 });
    } catch {
      failed++;
      warnings.push(`The ${color} shapes couldn't be combined and were left out. Simplify that color in your editor.`);
    }
  }
  if (failed > 3) warnings.push(`${failed} shapes were left out. This file may be too complex to trace; try simplifying it.`);
  return { regions, hidden, warnings };
}
