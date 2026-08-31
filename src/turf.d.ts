// Minimal ambient typings for the @turf/turf 6.5 functions this app uses.
// Turf 6.5's package.json "exports" doesn't expose its bundled index.d.ts under
// moduleResolution "bundler", so TypeScript can't resolve the real typings — this shim
// declares just the surface we call. Delete it if/when Turf is upgraded to v7+.
declare module '@turf/turf' {
  import type { Feature, GeoJSON, MultiPolygon, Polygon } from 'geojson';

  type Poly = Feature<Polygon | MultiPolygon> | Polygon | MultiPolygon;

  export function union(
    poly1: Poly,
    poly2: Poly,
    options?: { properties?: object },
  ): Feature<Polygon | MultiPolygon> | null;
  export function difference(poly1: Poly, poly2: Poly): Feature<Polygon | MultiPolygon> | null;
  export function intersect(
    poly1: Poly,
    poly2: Poly,
    options?: { properties?: object },
  ): Feature<Polygon | MultiPolygon> | null;
  export function truncate<T>(
    geojson: T,
    options?: { precision?: number; coordinates?: number; mutate?: boolean },
  ): T;
  export function area(geojson: GeoJSON | Feature<Polygon | MultiPolygon>): number;
  export function polygon(
    coordinates: number[][][],
    properties?: object,
    options?: object,
  ): Feature<Polygon>;
  export function multiPolygon(
    coordinates: number[][][][],
    properties?: object,
    options?: object,
  ): Feature<MultiPolygon>;
  // Tests only: the chair suites pick an interior point of a baked region to place a design on,
  // and turf already owns the holes-aware containment rule that a hand-rolled ray cast keeps
  // getting subtly wrong. Nothing in src/ calls it, so the "surface we call" note above still
  // reads true of the app.
  export function booleanPointInPolygon(point: number[] | Feature, polygon: Poly): boolean;
}
