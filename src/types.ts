import type { Feature, MultiPolygon, Polygon } from 'geojson';

export interface Pt {
  x: number;
  y: number;
}
export type Loop = Pt[];

/** 2D affine transform [a,b,c,d,e,f]: x' = a*x + c*y + e, y' = b*x + d*y + f */
export type Mat6 = [number, number, number, number, number, number];

/** The one geometry currency between SVG parsing, boolean ops, and extrusion. */
export type PolyFeature = Feature<Polygon | MultiPolygon>;

export interface SVGShape {
  fill: string;
  loops: Loop[];
  order: number;
}

export interface ParsedSVG {
  /** Treated as immutable once parsed — regions.ts memoizes computeNetRegionsByColor on its identity. */
  shapes: SVGShape[];
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  /** Largest <circle> in the document — assembly mode's design-boundary anchor. */
  rawSVGCircle: { cx: number; cy: number; r: number } | null;
  /**
   * Millimeters per SVG user (viewBox) unit, derived from the document's physical width/height.
   * Only rect assembly placement uses it — to map artwork 1:1 in mm regardless of the file's
   * internal coordinate resolution; null when the SVG declares no absolute size. Wheel mode
   * (which scales off the design circle) ignores it.
   */
  userUnitMM?: number | null;
  /**
   * The document's viewBox extent in user units (null when it declares no viewBox). Rect
   * placement uses it as a last resort when `userUnitMM` is null: an editor that dropped the
   * physical size (e.g. Affinity exporting `width="100%"`) still keeps the viewBox, so fitting
   * it to the part face recovers the intended scale.
   */
  viewBox?: { w: number; h: number } | null;
}

export type ShapeKind = 'assembly' | 'disc' | 'rect' | 'round' | 'stl';

export interface BaseParams {
  diameter?: number;
  width?: number;
  height?: number;
  corner?: number;
  thickness: number;
  marginPct: number;
  scaleMult: number;
  offsetX: number;
  offsetY: number;
  /** user horizontal mirror (fixes artwork that reads back-to-front) */
  flipX: boolean;
  /** user vertical mirror, on top of the built-in SVG y-down correction */
  flipY: boolean;
}

export interface FitTransform {
  scale: number;
  cx: number;
  cy: number;
  /** ±1 horizontal multiplier (−1 = user mirror) */
  xMul: number;
  /** ±1 vertical multiplier: base −1 (SVG y-down → plate y-up), flipped again by the user toggle */
  yMul: number;
  /** rings need winding reversal when the net transform is a reflection (odd # of axis flips) */
  reverse: boolean;
  offsetX: number;
  offsetY: number;
}

/** One recess region after user merges are applied (key is a hex or "merge:a,b"). */
export interface ResolvedRegion {
  key: string;
  members: string[];
  feature: PolyFeature;
  isMerge: boolean;
  previewColor: string;
}

export interface ColorSettings {
  [key: string]: { depth: number };
}

/** A coplanar triangle patch detected on a loaded mesh. */
export interface FlatPatch {
  area: number;
  normal: number[];
  offset: number;
  triIndices: number[];
}

export interface AssemblyPart {
  id: number;
  name: string;
  roleId: string;
  positions: Float32Array | null;
  /** part geometry minus the design face — preview context only */
  restPositions?: Float32Array;
  patches: FlatPatch[] | null;
  patchIdx: number;
  boundaryLoop: number[][] | null;
  patchNormal?: number[];
  topZ: number;
  baseDepth: number;
  isDuplicateOf: number | null;
  pivotX: number;
  pivotZ: number;
  angleDeg: number;
  loaded: boolean;
  /**
   * Project the design across the part's whole curved face instead of clipping to the small
   * flat patch used to place it (see AssemblyRole.cutThrough).
   */
  cutThrough: boolean;
  /**
   * Fixed cut depth (mm) for a cutThrough part, measured straight down from the face plane —
   * e.g. the cap's shell is only 3mm thick above its mounting boss, so cutting deeper would
   * breach into it. Undefined falls back to piercing the part's full vertical extent.
   */
  cutThroughDepth?: number;
}

export interface AssemblyRole {
  id: string;
  name: string;
  libraryPartId?: string;
  allowRotatedCopies: boolean;
  /** rotated copies auto-added beyond the primary by "load full assembly" */
  copies?: number;
  copyDefaults?: { pivotX: number; pivotZ: number; angleDeg: number };
  /**
   * Display name for a rotated copy of this role, e.g. a wheel's second Top half is
   * physically the Bottom half — falls back to "<role name> (rotated copy)" if unset.
   */
  copyName?: string;
  /** parts of this role get a through-cut (see AssemblyPart.cutThrough) instead of a recess */
  cutThrough?: boolean;
  /** see AssemblyPart.cutThroughDepth */
  cutThroughDepth?: number;
  /**
   * Preferred design face as a unit normal. When set, the loader defaults to the largest-area
   * detected patch pointing this way instead of the overall largest patch — needed when a part's
   * biggest flat face isn't the design face (e.g. the footrest's flat back outsizes its seat).
   */
  preferFaceNormal?: [number, number, number];
}

export interface AssemblyKind {
  id: string;
  name: string;
  roles: AssemblyRole[];
  /**
   * How SVG artwork maps onto the design face. 'wheel' (default) anchors on the design's circle
   * and scales by Design radius — right for the round wheel. 'rect' maps the SVG 1:1 in mm and
   * centers on the detected face, for rectangular parts like the footrest where a radius control
   * is meaningless.
   */
  designFit?: 'wheel' | 'rect';
  /**
   * Filename of this kind's true-to-size design template in `public/templates/`, offered as a
   * download in the Part panel. Templates are generated by `scripts/gen-templates.mjs`; a kind
   * without one just doesn't show the link.
   */
  templateFile?: string;
}

export interface LibraryEntry {
  id: string;
  name: string;
  file: string;
  baseDepth?: number;
}

export interface Filament {
  id: string;
  name: string;
  hex: string;
}

export interface AssemblyPaletteEntry {
  hex: string;
  key: string;
  members: string[];
  isMerge: boolean;
  feature: PolyFeature | null;
}

/** Indexed mesh: unique vertices (xyz interleaved) + 3 indices per triangle. */
export interface IndexedMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface AssemblyPartOutput {
  part: AssemblyPart;
  bodySoup: Float32Array;
  inlaySoups: Record<number, Float32Array>;
  /**
   * Manifold's native indexing, kept alongside the (flat-shaded) scene soup so 3MF export can
   * emit vertices/triangles directly instead of re-welding the soup. Absent on fallback parts
   * that never went through a boolean (export re-indexes their soup instead).
   */
  bodyIndexed?: IndexedMesh;
  inlayIndexed?: Record<number, IndexedMesh>;
}

/** One raw detected artwork color before any merge/base resolution — feeds the base-color picker. */
export interface DetectedColor {
  hex: string;
  areaPct: number;
}

export interface AssemblyBuild {
  partOutputs: AssemblyPartOutput[];
  palette: AssemblyPaletteEntry[];
  /** Y direction of the first primary part's design face — the camera opens from this side. */
  viewSign: number;
  /** every raw fill color detected, independent of current merge/base settings */
  detectedColors: DetectedColor[];
  /** the artwork color currently assigned to the base material, if any */
  baseAssigned: { hex: string; areaPct: number } | null;
}
