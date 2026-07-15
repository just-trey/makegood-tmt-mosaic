import * as THREE from 'three';
import * as turf from '@turf/turf';
import type {
  BaseParams,
  ColorSettings,
  FitTransform,
  ParsedSVG,
  PolyFeature,
  ShapeKind,
} from '../types';
import { applyColorMerges, safeDiff, safeUnion, computeNetRegionsByColor } from './regions';

type Ring = number[][];

export const BACKGROUND_KEY = '__background__';

export interface ColorMeshEntry {
  color: string;
  key: string;
  members: string[];
  isMergeGroup: boolean;
  depth: number;
  mesh: THREE.Mesh;
  area: number;
  areaPct: number;
  isBackground: boolean;
}

export interface FlatBuild {
  baseGroup: THREE.Group;
  colorMeshes: ColorMeshEntry[];
  thickness: number;
  footW: number;
  footH: number;
}

export interface FlatBuildInput {
  parsed: ParsedSVG;
  colorSettings: ColorSettings;
  baseParams: BaseParams;
  shapeKind: ShapeKind;
  globalDepth: number;
  recessBg: boolean;
  mergeGroups: string[][];
  baseColorHex: string;
}

function ringToShapePoints(ring: Ring): THREE.Vector2[] {
  // drop duplicate closing point; three.Shape doesn't want it repeated
  const pts = ring.map((c) => new THREE.Vector2(c[0], c[1]));
  if (pts.length > 1 && pts[0].distanceTo(pts[pts.length - 1]) < 1e-6) pts.pop();
  return pts;
}

export function featureToShapes(feature: PolyFeature | null): THREE.Shape[] {
  if (!feature) return [];
  const polys =
    feature.geometry.type === 'Polygon'
      ? [feature.geometry.coordinates as Ring[]]
      : (feature.geometry.coordinates as Ring[][]);
  const shapes: THREE.Shape[] = [];
  polys.forEach((poly) => {
    if (!poly.length) return;
    const outer = poly[0];
    const shape = new THREE.Shape(ringToShapePoints(outer));
    for (let i = 1; i < poly.length; i++) {
      shape.holes.push(new THREE.Path(ringToShapePoints(poly[i])));
    }
    shapes.push(shape);
  });
  return shapes;
}

export function footprintFeature(kind: ShapeKind, params: BaseParams): PolyFeature {
  let ring: Ring = [];
  if (kind === 'disc') {
    const r = (params.diameter || 0) / 2,
      segs = 128,
      pts: Ring = [];
    for (let i = 0; i < segs; i++) {
      const t = (i / segs) * Math.PI * 2;
      pts.push([r * Math.cos(t), r * Math.sin(t)]);
    }
    pts.push(pts[0]);
    ring = pts;
  } else if (kind === 'rect' || kind === 'stl') {
    const w = (params.width || 0) / 2,
      h = (params.height || 0) / 2;
    ring = [
      [-w, -h],
      [w, -h],
      [w, h],
      [-w, h],
      [-w, -h],
    ];
  } else if (kind === 'round') {
    const w = (params.width || 0) / 2,
      h = (params.height || 0) / 2;
    const r = Math.min(params.corner || 0, w, h),
      seg = 12,
      pts: Ring = [];
    const corners: [number, number, number, number][] = [
      [w - r, -h + r, -90, 0],
      [w - r, h - r, 0, 90],
      [-w + r, h - r, 90, 180],
      [-w + r, -h + r, 180, 270],
    ];
    corners.forEach(([ccx, ccy, a0, a1]) => {
      for (let k = 0; k <= seg; k++) {
        const t = ((a0 + ((a1 - a0) * k) / seg) * Math.PI) / 180;
        pts.push([ccx + r * Math.cos(t), ccy + r * Math.sin(t)]);
      }
    });
    pts.push(pts[0]);
    ring = pts;
  }
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [ring] },
  } as PolyFeature;
}

/** Fit the SVG bbox into the footprint bbox (uniform scale, centered). */
export function fitTransform(
  svgBBox: ParsedSVG['bbox'],
  targetW: number,
  targetH: number,
  marginPct: number,
  scaleMult: number,
  offsetX: number,
  offsetY: number,
  flipX: boolean,
  flipY: boolean,
): FitTransform {
  const svgW = svgBBox.maxX - svgBBox.minX,
    svgH = svgBBox.maxY - svgBBox.minY;
  // marginPct is a per-side percent of the footprint, applied on both sides -> /50
  const mW = targetW * (1 - marginPct / 50),
    mH = targetH * (1 - marginPct / 50);
  const autoScale = Math.min(mW / svgW, mH / svgH);
  const scale = autoScale * (scaleMult || 1);
  const cx = (svgBBox.minX + svgBBox.maxX) / 2,
    cy = (svgBBox.minY + svgBBox.maxY) / 2;
  // SVG y grows downward; the physical plate has +Y "up" on the printed face, so the base Y
  // multiplier is -1. The user flip toggles mirror on top of that (horizontal, and vertical
  // over the built-in correction).
  const xMul = flipX ? -1 : 1;
  const yMul = flipY ? 1 : -1;
  return {
    scale,
    cx,
    cy,
    xMul,
    yMul,
    reverse: xMul * yMul < 0,
    offsetX: offsetX || 0,
    offsetY: offsetY || 0,
  };
}

export function transformFeature(feature: PolyFeature, fit: FitTransform): PolyFeature {
  function tp(pt: number[]): number[] {
    const x = (pt[0] - fit.cx) * fit.scale * fit.xMul + fit.offsetX;
    const y = (pt[1] - fit.cy) * fit.scale * fit.yMul + fit.offsetY;
    return [x, y];
  }
  // A reflection (an odd number of axis flips) reverses every ring's winding order. That's fine
  // topologically (exterior/hole relationships are unaffected by a uniform mirror) but it would
  // flip the extruded mesh's face normals inward. Re-reverse each ring to restore the original
  // winding sense so extrusion produces outward-facing normals.
  function fixRing(ring: Ring): Ring {
    const m = ring.map(tp);
    return fit.reverse ? m.slice().reverse() : m;
  }
  const g = feature.geometry;
  const geom =
    g.type === 'Polygon'
      ? { type: 'Polygon' as const, coordinates: (g.coordinates as Ring[]).map(fixRing) }
      : {
          type: 'MultiPolygon' as const,
          coordinates: (g.coordinates as Ring[][]).map((poly) => poly.map(fixRing)),
        };
  return { type: 'Feature', properties: feature.properties, geometry: geom } as PolyFeature;
}

/** Build the full flat-plate mesh set: slab-stack base + one plug mesh per recess region. */
export function buildGeometry(input: FlatBuildInput): FlatBuild | null {
  const {
    parsed,
    colorSettings,
    baseParams,
    shapeKind,
    globalDepth,
    recessBg,
    mergeGroups,
    baseColorHex,
  } = input;
  if (!parsed) return null;

  const { byColor } = computeNetRegionsByColor(parsed.shapes);

  let footW: number, footH: number;
  if (shapeKind === 'disc') {
    footW = baseParams.diameter || 0;
    footH = baseParams.diameter || 0;
  } else {
    footW = baseParams.width || 0;
    footH = baseParams.height || 0;
  }

  const fit = fitTransform(
    parsed.bbox,
    footW,
    footH,
    baseParams.marginPct,
    baseParams.scaleMult,
    baseParams.offsetX,
    baseParams.offsetY,
    baseParams.flipX,
    baseParams.flipY,
  );
  const footprint = footprintFeature(shapeKind, baseParams);
  const thickness = baseParams.thickness;

  const clampDepth = (d: number) => Math.min(Math.max(d, 0.02), thickness - 0.05);

  // transform + collect active color/merged-group regions with their depth
  const resolvedRegions = applyColorMerges(byColor, mergeGroups);
  interface Entry {
    color: string;
    key: string;
    members: string[];
    isMerge: boolean;
    feature: PolyFeature;
    depth: number;
    isBackground?: boolean;
  }
  const colorEntries: Entry[] = [];
  resolvedRegions.forEach((r) => {
    const feat = transformFeature(r.feature, fit);
    const depth = clampDepth((colorSettings[r.key] && colorSettings[r.key].depth) || globalDepth);
    colorEntries.push({
      color: r.previewColor,
      key: r.key,
      members: r.members,
      isMerge: r.isMerge,
      feature: feat,
      depth,
    });
  });

  // leftover background region
  let unionAll: PolyFeature | null = null;
  colorEntries.forEach((c) => {
    unionAll = safeUnion(unionAll, c.feature);
  });
  const leftover = unionAll ? safeDiff(footprint, unionAll) : footprint;

  if (recessBg && leftover) {
    // the background recess honors its own per-region depth override, like any color
    const bgDepth =
      (colorSettings[BACKGROUND_KEY] && colorSettings[BACKGROUND_KEY].depth) || globalDepth;
    colorEntries.push({
      color: '#cfd6dc',
      key: BACKGROUND_KEY,
      members: [BACKGROUND_KEY],
      isMerge: false,
      feature: leftover,
      depth: clampDepth(bgDepth),
      isBackground: true,
    });
  }

  // ---- base/plinth: stacked slabs between distinct depth boundaries ----
  const boundarySet = new Set<number>([0, thickness]);
  colorEntries.forEach((c) => boundarySet.add(c.depth));
  const boundaries = Array.from(boundarySet).sort((a, b) => a - b);

  const baseGroup = new THREE.Group();
  baseGroup.name = 'base';
  const baseMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(baseColorHex),
    roughness: 0.75,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });

  for (let i = 0; i < boundaries.length - 1; i++) {
    const uA = boundaries[i],
      uB = boundaries[i + 1];
    if (uB - uA < 1e-6) continue;
    const openRegions = colorEntries.filter((c) => c.depth > uA + 1e-6);
    let removed: PolyFeature | null = null;
    openRegions.forEach((c) => {
      removed = safeUnion(removed, c.feature);
    });
    const layerPoly = removed ? safeDiff(footprint, removed) : footprint;
    if (!layerPoly) continue;
    const shapes = featureToShapes(layerPoly);
    if (!shapes.length) continue;
    const geo = new THREE.ExtrudeGeometry(shapes, {
      depth: uB - uA,
      bevelEnabled: false,
      curveSegments: 1,
    });
    const mesh = new THREE.Mesh(geo, baseMat);
    mesh.position.z = thickness - uB;
    baseGroup.add(mesh);
  }

  // ---- per-color plugs ----
  const colorMeshes = colorEntries
    .map((c) => {
      const shapes = featureToShapes(c.feature);
      if (!shapes.length) return null;
      const geo = new THREE.ExtrudeGeometry(shapes, {
        depth: c.depth,
        bevelEnabled: false,
        curveSegments: 1,
      });
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(c.color),
        roughness: 0.55,
        metalness: 0.05,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.z = thickness - c.depth;
      mesh.name = c.key;
      return {
        color: c.color,
        key: c.key,
        members: c.members,
        isMergeGroup: c.isMerge,
        depth: c.depth,
        mesh,
        area: turf.area(c.feature),
        areaPct: 0,
        isBackground: !!c.isBackground,
      } as ColorMeshEntry;
    })
    .filter((c): c is ColorMeshEntry => !!c);

  const totalArea = colorMeshes.reduce((s, c) => s + c.area, 0) || 1;
  colorMeshes.forEach((c) => {
    c.areaPct = (100 * c.area) / totalArea;
  });

  return { baseGroup, colorMeshes, thickness, footW, footH };
}
