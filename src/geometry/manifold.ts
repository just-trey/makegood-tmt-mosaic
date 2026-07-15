import * as THREE from 'three';
import type ManifoldModule from 'manifold-3d';
import type { PolyFeature } from '../types';
import { featureToShapes } from './flat';

export type ManifoldAPI = Awaited<ReturnType<typeof ManifoldModule>>;
export type ManifoldSolid = InstanceType<ManifoldAPI['Manifold']>;

type Ring = number[][];

// Lazy-init the Manifold WASM boolean engine. Assembly mode cuts pockets into real part
// meshes via true 3D booleans; flat-plate mode never touches it, so the dynamic import keeps
// the WASM chunk out of the initial page load until Assembly geometry is actually built.
let _manifoldWasm: ManifoldAPI | null = null;
export async function getManifold(): Promise<ManifoldAPI> {
  if (_manifoldWasm) return _manifoldWasm;
  const { default: loadManifold } = await import('manifold-3d');
  const wasm = await loadManifold();
  wasm.setup();
  _manifoldWasm = wasm;
  return wasm;
}

/**
 * Triangle soup (Float32Array, N*9 interleaved xyz) -> Manifold, welding coincident vertices
 * first. STL/3MF/ExtrudeGeometry are all unindexed soups, so their shared edges are split —
 * merge() re-stitches them so the result reads as a closed solid.
 */
export function soupToManifold(wasm: ManifoldAPI, soup: Float32Array): ManifoldSolid {
  const { Manifold, Mesh } = wasm;
  const triCount = soup.length / 9;
  const triVerts = new Uint32Array(triCount * 3);
  for (let i = 0; i < triCount * 3; i++) triVerts[i] = i;
  // clone positions: Manifold copies into the WASM heap, but never share a buffer we reuse
  const mesh = new Mesh({ numProp: 3, vertProperties: Float32Array.from(soup), triVerts });
  if (typeof mesh.merge === 'function') mesh.merge();
  return new Manifold(mesh);
}

/**
 * Manifold returns an empty solid when given input it can't make watertight (open edges,
 * flipped/duplicated faces, etc.), so a non-empty result is the reliable "this mesh is usable"
 * signal — more version-robust than comparing the status() enum.
 */
export function manifoldIsValid(man: ManifoldSolid): boolean {
  try {
    return man.numTri() > 0;
  } catch {
    return false;
  }
}

export function manifoldToSoup(man: ManifoldSolid): Float32Array {
  const mesh = man.getMesh();
  const { numProp, vertProperties, triVerts } = mesh;
  const out = new Float32Array(triVerts.length * 3);
  for (let t = 0; t < triVerts.length; t++) {
    const vi = triVerts[t] * numProp;
    out[t * 3] = vertProperties[vi];
    out[t * 3 + 1] = vertProperties[vi + 1];
    out[t * 3 + 2] = vertProperties[vi + 2];
  }
  return out;
}

export function manifoldDelete(m: ManifoldSolid | null | undefined): void {
  if (m && typeof m.delete === 'function') {
    try {
      m.delete();
    } catch {
      /* already freed */
    }
  }
}

/** Deep-map every coordinate pair of a turf Polygon/MultiPolygon feature. */
export function mapFeatureCoords(
  feature: PolyFeature,
  fn: (pt: number[]) => number[],
): PolyFeature {
  const g = feature.geometry;
  const ring = (r: Ring) => r.map(fn);
  const poly = (p: Ring[]) => p.map(ring);
  const coords =
    g.type === 'Polygon' ? poly(g.coordinates as Ring[]) : (g.coordinates as Ring[][]).map(poly);
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: g.type, coordinates: coords },
  } as PolyFeature;
}

/** Signed area of a [[x,y],...] ring (>0 = CCW in standard math orientation). */
export function ringSignedArea2(ring: Ring): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}

/**
 * Force each polygon's outer ring CCW and holes CW. Turf boolean ops (e.g. the clip to the
 * face boundary) don't guarantee GeoJSON winding, and THREE.ExtrudeGeometry builds an
 * inside-out solid from a CW outer contour — which would make Manifold subtract the region's
 * COMPLEMENT. Normalizing here keeps every prism a proper outward solid.
 */
export function normalizeFeatureWinding(feature: PolyFeature): PolyFeature {
  const g = feature.geometry;
  const fixPoly = (poly: Ring[]) =>
    poly.map((ring, ri) => {
      const wantCCW = ri === 0;
      const isCCW = ringSignedArea2(ring) > 0;
      return isCCW !== wantCCW ? ring.slice().reverse() : ring;
    });
  const coords =
    g.type === 'Polygon'
      ? fixPoly(g.coordinates as Ring[])
      : (g.coordinates as Ring[][]).map(fixPoly);
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: g.type, coordinates: coords },
  } as PolyFeature;
}

/**
 * Extrude a turf feature (coordinates already in the part's native X/Z mm frame) into a solid
 * prism triangle soup. `sign` is the face's outward direction along Y (+1 = face points +Y,
 * -1 = points -Y). The prism spans from `overshoot` mm OUTSIDE the face plane (faceY) to
 * `depth` mm INTO the material — the overshoot guarantees the pocket opens cleanly at the
 * surface (a coplanar cut can leave a zero-thickness skin); the part mesh caps the overshoot
 * back to the surface when intersected for the flush inlay.
 */
export function extrudeRegionToSoup(
  feature: PolyFeature,
  faceY: number,
  depth: number,
  overshoot: number,
  sign: number,
): Float32Array | null {
  sign = sign < 0 ? -1 : 1;
  const shapes = featureToShapes(normalizeFeatureWinding(feature)); // THREE.Shape in (x = worldX, y = worldZ)
  if (!shapes.length) return null;
  const total = depth + overshoot;
  const geo = new THREE.ExtrudeGeometry(shapes, {
    depth: total,
    bevelEnabled: false,
    curveSegments: 1,
  });
  // local (x, y, z∈[0,total]) -> world (x, faceY + sign*(overshoot - z), y).
  // z=0 -> faceY + sign*overshoot (just outside the surface); z=total -> faceY - sign*depth (into material).
  const m = new THREE.Matrix4().set(
    1,
    0,
    0,
    0,
    0,
    0,
    -sign,
    faceY + sign * overshoot,
    0,
    1,
    0,
    0,
    0,
    0,
    0,
    1,
  );
  geo.applyMatrix4(m);
  const soup = Float32Array.from(geo.attributes.position.array as Float32Array);
  geo.dispose();
  // The transform's determinant equals `sign`; when sign<0 it's a reflection that flips every
  // normal inward, which would make Manifold subtract the region's complement. Swap two corners
  // of each triangle to restore outward (CCW-from-outside) winding.
  if (sign < 0) {
    for (let i = 0; i < soup.length; i += 9) {
      for (let k = 0; k < 3; k++) {
        const t = soup[i + 3 + k];
        soup[i + 3 + k] = soup[i + 6 + k];
        soup[i + 6 + k] = t;
      }
    }
  }
  return soup;
}
