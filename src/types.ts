import type { Feature, MultiPolygon, Polygon } from 'geojson';
import type { ConformalChart } from './geometry/conformal';

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
  /**
   * The document's own canvas in user units, origin at (0,0) — the viewBox extent when it declares
   * one, else the declared physical width/height at the same 96dpi `userUnitMM` assumes for a
   * viewBox-less file. Rect placement anchors artwork on this rather than on the drawn content, so
   * a design positioned within its sheet keeps that position on the part. Null when the file
   * declares neither, leaving nothing but the content to anchor on.
   *
   * Distinct from `viewBox`, which stays the viewBox alone because the scale fallback and the fill
   * tile cell both mean specifically that.
   */
  canvas?: { w: number; h: number } | null;
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
  /** design rotation about its center, in degrees (0 = as authored) */
  rotationDeg: number;
}

export interface FitTransform {
  scale: number;
  cx: number;
  cy: number;
  /** ±1 horizontal multiplier (−1 = user mirror) */
  xMul: number;
  /** ±1 vertical multiplier: base −1 (SVG y-down → plate y-up), flipped again by the user toggle */
  yMul: number;
  /** sin/cos of the design rotation, applied after scale/mirror and before offset */
  rotSin: number;
  rotCos: number;
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

/**
 * A design zone on a part: one baked UV chart the artwork maps into, letting a part carry more
 * than one design surface (and eventually wrap artwork around edges). Populated by the zone bake
 * pipeline (see the chair-body plan). A part with no zones uses an implicit flat zone derived
 * from its chosen patch — see `implicitZoneFor` in geometry/zones.ts. Kept minimal here; the
 * runtime chart + mapper detail lives in geometry/zones.ts.
 */
export interface DesignZone {
  id: string;
  name: string;
  /**
   * The baked UV chart this zone's artwork wraps onto, reconstructed against the part's loaded
   * mesh (see geometry/zoneCharts.ts). Present on a conformal zone; absent means the zone is cut
   * with the flat projection instead.
   */
  chart?: ConformalChart;
  /**
   * Filename of this zone's true-to-size design template in `public/templates/` — the per-zone
   * counterpart to `AssemblyKind.templateFile` for a kind whose parts each carry more than one
   * design surface, so each surface needs its own template rather than one for the whole kind.
   */
  templateFile?: string;
}

/** Identifies one design zone: which part it lives on, and the zone's stable id within that part. */
export interface ZoneRef {
  partId: number;
  zoneId: string;
}

/** One user-loaded (or, later, pattern-library) artwork source, independent of where it's placed. */
export interface DesignSource {
  id: string;
  kind: 'upload' | 'pattern';
  name: string;
  parsed: ParsedSVG;
  /**
   * The raw SVG text `parsed` came from. Kept alongside it (not just derived) because `ParsedSVG`
   * is a one-way parse — session persistence re-derives `parsed` from this on restore via
   * `parseSVGDocument()` rather than trying to serialize the parsed form itself, which regions.ts
   * also memoizes on object identity (see the note on `ParsedSVG`).
   */
  svgText: string;
}

/**
 * One placement of a DesignSource onto a zone — the unit the on-face gizmo and fit sliders
 * ultimately target. `zone: null` means the part's single implicit zone (every part has exactly
 * one today; see `implicitZoneFor` in geometry/zones.ts). Multiple instances per source/zone will
 * become reachable once the artwork list panel (Phase 2b) exists; today there is always exactly
 * one, auto-created alongside its source.
 */
export interface ArtworkInstance {
  id: string;
  sourceId: string;
  zone: ZoneRef | null;
  offsetU: number;
  offsetV: number;
  scalePct: number;
  rotationDeg: number;
  flipX: boolean;
  flipY: boolean;
  mode: 'sticker' | 'fill';
}

export interface AssemblyPart {
  id: number;
  name: string;
  roleId: string;
  positions: Float32Array | null;
  /**
   * The packed mesh's unique vertex list (file order, xyz interleaved) when the part came from a
   * 3MF — what a baked zone chart's vertex indices address. Absent for an STL upload, which has
   * no packed vertex order to index into.
   */
  vertices?: Float32Array;
  /** which stl/parts.json entry this part was loaded from; absent for a drag-and-drop upload */
  libraryPartId?: string;
  /**
   * True when the *current* mesh came from a user drag-and-drop rather than the parts library.
   * Not derivable from `libraryPartId`: dropping a file onto a role that already auto-loaded its
   * library part deliberately leaves that id in place (attachBakedZones still needs it to find the
   * kind's baked charts), so the id alone can't say where the loaded geometry came from. Export
   * placement reads this to tell "our asset drifted", a repo defect, from "the user brought their
   * own mesh", which is supported — see resolvePlacement in src/export/placement.ts.
   */
  meshFromUpload?: boolean;
  /** part geometry minus the design face — preview context only */
  restPositions?: Float32Array;
  patches: FlatPatch[] | null;
  patchIdx: number;
  boundaryLoop: number[][] | null;
  patchNormal?: number[];
  /**
   * Baked design zones for a part of a kind that ships a zone sidecar (`AssemblyKind.zonesFile`).
   * Undefined means no sidecar applies, so the part uses one implicit flat zone from its chosen
   * patch — the single-design-face behavior every part had before conformal zones. An *empty*
   * array is meaningful and different: the sidecar loaded but bakes no zone onto this piece
   * (e.g. the chair's caster mounts), so it takes no artwork at all rather than falling back to
   * stamping its largest flat patch.
   */
  zones?: DesignZone[];
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
  /**
   * Variant-dependent library part: for a role whose physical piece differs by hardware variant
   * (the chair's caster mounts come in Standard and Kit), maps each `AssemblyKind.variants` id to
   * the library part loaded for that variant. Takes precedence over `libraryPartId`; resolved via
   * `roleLibraryPartId(role, variantId)`.
   */
  libraryPartIdByVariant?: Record<string, string>;
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

/**
 * How an assembly is posed in the *viewport*, in native part coordinates: `up` renders as world
 * up, `front` faces the default camera.
 *
 * Needed because the app has one implicit part-frame convention — "the design face is a Y-plane"
 * — which doubles as a display pose for a plate-like kind (the wheel and footrest stand up facing
 * the camera for free). A 3D body has no single design face, so it is packed in its CAD frame
 * instead and that convention misreads it: the chair's CAD up is +Y, which the Z-up scene renders
 * horizontal, laying it on its back.
 *
 * Display only. Part meshes, the cut pipeline, the baked zone charts and export plate placement
 * all keep native coordinates. Per the add-part skill the viewport pose and the plate pose are
 * deliberately different; this is a third frame, not a unification of them.
 */
export interface DisplayFrame {
  up: [number, number, number];
  front: [number, number, number];
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
  /**
   * Mutually-exclusive hardware variants of this assembly (the chair is all-Standard or all-Kit,
   * never mixed). When set, `state.assembly.variantId` holds the choice and roles with a
   * `libraryPartIdByVariant` load the matching piece. The first entry is the default.
   */
  variants?: { id: string; name: string }[];
  /**
   * Filename of this kind's design-zone sidecar in `public/stl/` (baked by
   * `scripts/bake-zones.mjs`). Present on multi-face kinds whose parts carry baked conformal
   * charts instead of a single implicit flat zone; absent kinds use the flat path.
   */
  zonesFile?: string;
  /**
   * Viewport pose for this kind. Omitted for kinds already packed design-face-up (the wheel and
   * footrest), which render correctly with no transform at all.
   */
  displayFrame?: DisplayFrame;
  /**
   * Kept in ASSEMBLY_KINDS (and fully functional) but left out of the Part dropdown — for a
   * part that isn't ready to offer to users yet.
   */
  hidden?: boolean;
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

/** One entry in the built-in tileable pattern library (public/patterns/patterns.json). */
export interface PatternEntry {
  id: string;
  name: string;
  file: string;
}

export interface AssemblyPaletteEntry {
  hex: string;
  key: string;
  members: string[];
  isMerge: boolean;
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
