// polygon-clipping ships typings that declare named exports, but the ESM build a bundler picks up
// exports only a default. Merged into the package's own ambient declaration (TypeScript unions
// `declare module` blocks) rather than replacing it, so the named types stay available.
//
// Coordinates are declared as plain nested number arrays rather than the package's `Pair` tuple:
// GeoJSON positions arrive from Turf and this app as `number[]`, and a tuple would force a cast at
// every boundary to say nothing.
declare module 'polygon-clipping' {
  type LooseGeom = number[][][] | number[][][][];
  const polygonClipping: {
    union(geom: LooseGeom, ...geoms: LooseGeom[]): number[][][][];
    difference(subjectGeom: LooseGeom, ...clipGeoms: LooseGeom[]): number[][][][];
    intersection(geom: LooseGeom, ...geoms: LooseGeom[]): number[][][][];
  };
  export default polygonClipping;
}
