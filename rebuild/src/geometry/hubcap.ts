import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import type { MultiPolygon } from '../design/poly';
import { HUBCAP_CHAMFER_MM, HUBCAP_THICKNESS_MM } from '../parts/catalog';

/**
 * Frame matches the reference cap and its clips: disc axis +Y, underside at y=24.3 (the wheel
 * face), top 3mm above, centred on x=z=0. The surface frame for the cap has U = -X and V = +Z,
 * so a local outline point (u, v) lands at world (X, Z) = (-u, v).
 */
export const HUBCAP_BASE_Y = 24.3;

export type HubcapShape = { kind: 'circle'; diameterMm: number } | { kind: 'silhouette'; outline: MultiPolygon };

/** The hubcap solid. A round disc gets its 1mm 45° top chamfer; a silhouette gets vertical edges, since a free-form outline has no clean inset. */
export function hubcapSolid(wasm: ManifoldToplevel, shape: HubcapShape): Manifold {
  const { Manifold, CrossSection } = wasm;
  let solid: Manifold;
  if (shape.kind === 'circle') {
    const r = shape.diameterMm / 2;
    const lower = Manifold.cylinder(HUBCAP_THICKNESS_MM - HUBCAP_CHAMFER_MM, r, r, 256);
    const upper = Manifold.cylinder(HUBCAP_CHAMFER_MM, r, r - HUBCAP_CHAMFER_MM, 256).translate([0, 0, HUBCAP_THICKNESS_MM - HUBCAP_CHAMFER_MM]);
    solid = Manifold.union(lower, upper);
    lower.delete();
    upper.delete();
  } else {
    const polys = shape.outline.flatMap((poly) => poly.map((ring) => ring.map(([u, v]) => [-u, -v] as [number, number])));
    const cs = new CrossSection(polys, 'EvenOdd');
    solid = cs.extrude(HUBCAP_THICKNESS_MM);
    cs.delete();
  }
  // Extrusion runs along +Z; stand it up so it runs along +Y, then lift it onto the wheel face.
  const placed = solid.rotate([-90, 0, 0]).translate([0, HUBCAP_BASE_Y, 0]);
  solid.delete();
  return placed;
}
