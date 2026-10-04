import type { RasterImage } from './raster/types';
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
  /** Immutable once parsed: regions.ts memoizes computeNetRegionsByColor on its identity. */
  shapes: SVGShape[];
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  /** Largest <circle> in the document, assembly mode's design-boundary anchor. */
  rawSVGCircle: { cx: number; cy: number; r: number } | null;
  /**
   * Millimeters per SVG user (viewBox) unit, from the document's physical size. Only rect assembly
   * placement reads it (artwork 1:1 in mm whatever the file's resolution). Null when the SVG
   * declares no printable size, including px-only with no viewBox (px is the editor's DPI, not a
   * measurement). Wheel mode scales off the circle.
   */
  userUnitMM?: number | null;
  /** The viewBox extent in user units, null when none declared. The fill tile period; falls back to the artwork bbox. */
  viewBox?: { w: number; h: number } | null;
  /**
   * The document's canvas in user units, origin (0,0): the viewBox extent, else the declared
   * width/height at 96dpi (no viewBox makes a user unit a px). Rect placement anchors on this, not
   * drawn content, so a design keeps its position within its sheet (and fits to the face when
   * `userUnitMM` is null). Null when neither is declared. Separate from `viewBox`, which stays the
   * viewBox alone because the fill tile cell means specifically that.
   */
  canvas?: { w: number; h: number } | null;
  /**
   * Which producer built this; absent means the SVG parser. Only assembly.ts's sizing advice reads
   * it: "set your document size in millimetres" is right for an SVG and impossible for a PNG.
   */
  origin?: 'svg' | 'raster';
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
 * How a zone reflects across its kind's mirror plane: `twin` names the zone on the other side,
 * `self` says the plane runs through this zone, so its own centre line is the mirror.
 */
export type ZoneMirror = { twin: string } | { self: true };

/**
 * A design zone on a part: one baked UV chart the artwork maps into, so a part can carry several
 * design surfaces. A part with no zones uses an implicit flat zone from its chosen patch
 * (`implicitZoneFor` in geometry/zones.ts, which also holds the runtime chart and mapper detail).
 */
export interface DesignZone {
  id: string;
  name: string;
  /** Baked mirror relation (see ZoneMirror); absent on a zone the kind offers no mirror for. */
  mirror?: ZoneMirror;
  /** The baked UV chart this zone's artwork wraps onto, rebuilt against the loaded mesh (geometry/zoneCharts.ts). Absent means flat projection. */
  chart?: ConformalChart;
  /** Filename in `public/templates/` of this zone's true-size template — the per-zone `AssemblyKind.templateFile`. */
  templateFile?: string;
}

/** Identifies one design zone: which part it lives on, and the zone's stable id within that part. */
export interface ZoneRef {
  partId: number;
  zoneId: string;
}

/**
 * What a raster source keeps so its palette can be recomputed without re-reading the file.
 * Decoding is the expensive, async, DOM-bound part; the Colors and Detail sliders re-run only
 * quantize/trace. At working resolution that is at most ~1MB per image, against three.js, the
 * Manifold WASM and a 1.7MB zone sidecar.
 */
export interface RasterState {
  /** The working image, as `RasterImage` so `edgeDensity` rides along: it can't be re-derived from these pixels and restore must put it back or every threshold hanging off it moves. */
  image: RasterImage;
  colors: number;
  detail: number;
  /**
   * mm per working pixel at the placement traced for, which put the despeckle floor in printable
   * units (`rasterMmPerPixel`). Saved so a restore reproduces the trace — it re-traces before the
   * parts are back and can't derive this. Absent on older sessions.
   */
  mmPerPixel?: number;
  /** The palette the current `parsed` was built with; can be shorter than `colors` asked for. */
  palette: string[];
  regions: number;
}

/**
 * One user-loaded (or pattern-library) artwork source, independent of where it's placed.
 *
 * Invariant: `kind === 'raster'` exactly when `raster` is present.
 */
export interface DesignSource {
  id: string;
  kind: 'upload' | 'pattern' | 'raster';
  name: string;
  parsed: ParsedSVG;
  /**
   * The raw SVG text `parsed` came from, kept because `ParsedSVG` is a one-way parse; persistence
   * re-derives `parsed` via `parseSVGDocument()` (regions.ts memoizes on object identity, so the
   * parsed form isn't serialized). Empty for a raster source, whose pixels are stored re-encoded
   * and re-traced on restore.
   */
  svgText: string;
  raster?: RasterState;
}

/**
 * One placement of a DesignSource onto a zone: what the on-face gizmo and fit sliders target.
 * `zone: null` means the part's single implicit zone (`implicitZoneFor` in geometry/zones.ts).
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
  /** Also cut this design reflected onto the zone's mirror; absent (a session saved before it existed) means off. */
  mirror?: boolean;
}

export interface AssemblyPart {
  id: number;
  name: string;
  roleId: string;
  positions: Float32Array | null;
  /** The packed mesh's unique vertex list (xyz interleaved) when the part came from a 3MF — what a baked zone chart's indices address. Absent for an STL upload. */
  vertices?: Float32Array;
  /**
   * The packed mesh as an index: unique vertices plus 3 indices per triangle, as the 3MF stores it.
   * `positions` is this expanded corner for corner, so display shading reads the vertex sharing
   * instead of rehashing it.
   *
   * **Must be set or cleared wherever `positions` is replaced**, or it describes the previous mesh:
   * both branches of `asmLoadPartBuffer` and the `buildMesh` branch of `asmAdoptMesh`.
   * `indexMatchesSoup` is the backstop and only catches the crash-shaped half. Absent for a part
   * from an `.stl` manifest entry.
   */
  indexed?: IndexedMesh;
  /** which stl/parts.json entry this part was loaded from */
  libraryPartId?: string;
  /** The library asset as fetched, for a role whose mesh is *built* from it (AssemblyRole.buildMesh); kept so a changed parameter regenerates without a network trip. */
  assetPositions?: Float32Array;
  /**
   * The warning the last buildMesh raised, retracted before the next rebuild so fixing the
   * parameter clears it. A standing fact (nothing re-derives it per rebuild, so clearBuildWarnings
   * doesn't apply) the user can act on, hence dismissNotice.
   */
  buildWarning?: string;
  /** part geometry minus the design face; preview context only */
  restPositions?: Float32Array;
  patches: FlatPatch[] | null;
  patchIdx: number;
  /**
   * Every closed boundary loop of the chosen patch, ordered by X/Z area so the face outline is
   * first. Outer-vs-hole is resolved where used, by containment depth, never winding or vertex
   * count: a hole rim is as much outer wall as the outline, and an intricate cut-out can out-vertex
   * what encloses it.
   */
  boundaryLoops: number[][][] | null;
  patchNormal?: number[];
  /**
   * Baked design zones for a kind shipping a zone sidecar (`AssemblyKind.zonesFile`). Undefined: no
   * sidecar, so one implicit flat zone from the chosen patch. An *empty* array differs: the sidecar
   * bakes no zone onto this piece (the chair's caster mounts), so it takes no artwork rather than
   * falling back to its largest flat patch.
   */
  zones?: DesignZone[];
  topZ: number;
  baseDepth: number;
  isDuplicateOf: number | null;
  pivotX: number;
  pivotZ: number;
  angleDeg: number;
  loaded: boolean;
  /** Project the design across the part's whole curved face instead of clipping to the small flat patch used to place it (see AssemblyRole.cutThrough). */
  cutThrough: boolean;
  /** Fixed cut depth (mm) for a cutThrough part, from the face plane. The cap's shell is 3mm thick above its mounting boss, so deeper breaches it. Undefined pierces the full vertical extent. */
  cutThroughDepth?: number;
  /**
   * Cut depth (mm) for artwork regions *touching this part's design-face boundary*; interior
   * regions keep their per-color recess depth. Undefined means no such rule.
   *
   * The per-region counterpart to cutThrough: a hubcap cut to its artwork's shape wants the outline
   * in the artwork's color all the way down, not a 2mm band of base color around the picture.
   * Set from GeneratedMesh.edgeCutThroughDepth at adopt time, not from the role: whether it applies
   * depends on what the generator built (a silhouette, not the circle it falls back to).
   */
  edgeCutThroughDepth?: number;
}

export interface AssemblyRole {
  id: string;
  name: string;
  libraryPartId?: string;
  /** Variant-dependent library part, for a role whose piece differs by hardware variant (chair caster mounts: Standard, Kit). Maps `AssemblyKind.variants` ids to library parts; wins over `libraryPartId` (`roleLibraryPartId`). */
  libraryPartIdByVariant?: Record<string, string>;
  allowRotatedCopies: boolean;
  /** rotated copies auto-added beyond the primary by "load full assembly" */
  copies?: number;
  copyDefaults?: { pivotX: number; pivotZ: number; angleDeg: number };
  /** Display name for a rotated copy (a wheel's second Top half is physically the Bottom). Falls back to "<role name> (rotated copy)". */
  copyName?: string;
  /** parts of this role get a through-cut (see AssemblyPart.cutThrough) instead of a recess */
  cutThrough?: boolean;
  /** see AssemblyPart.cutThroughDepth */
  cutThroughDepth?: number;
  /** Preferred design face as a unit normal: the loader defaults to the largest patch pointing this way, for parts whose biggest flat face isn't the design face (the footrest's flat back outsizes its seat). */
  preferFaceNormal?: [number, number, number];
  /**
   * Builds this role's mesh from its library asset plus user settings, instead of the asset being
   * the part. The hubcap is the one such role: only its four mounting clips ship as a mesh and the
   * disc is generated at the requested diameter and unioned on.
   *
   * A function on the role, not a flag the loader switches on, so nothing in src/assembly/ knows a
   * hubcap exists. Re-run by asmRebuildGeneratedParts when a parameter changes.
   */
  buildMesh?: (asset: Float32Array) => Promise<GeneratedMesh>;
  /**
   * The verified plate placement for this role's *current* build parameters; undefined when none
   * was verified, meaning export computes a position and says so.
   *
   * Generated parts can't use the fingerprint seal other placements hang off (their mesh varies by
   * design); what can be verified is one arrangement at one size. Typed loosely because the shape
   * lives in src/export/; the caller narrows it.
   */
  buildPlacement?: () => Record<string, unknown> | undefined;
}

/** What an AssemblyRole.buildMesh returns: the part's mesh, plus anything the user should know. */
export interface GeneratedMesh {
  positions: Float32Array;
  vertices?: Float32Array;
  /** `positions` as an index, when the generator has one (Manifold returns it from every boolean); display shading uses it to skip rehashing. Omit it and shading falls back, correctly. */
  indexed?: IndexedMesh;
  /** Surfaced to the user as-is; the generator knows why its output is off, the loader doesn't. */
  warning?: string;
  /**
   * See AssemblyPart.edgeCutThroughDepth. Declared by the generator because only it knows the shape:
   * on a flat square-edged prism "touching the design-face boundary" and "reaching the outer wall"
   * coincide; on a chamfered disc they don't, so it returns undefined.
   */
  edgeCutThroughDepth?: number;
}

/**
 * How an assembly is posed in the *viewport*, in native part coordinates: `up` renders as world up,
 * `front` faces the default camera.
 *
 * The implicit "design face is a Y-plane" convention doubles as a display pose for plate-like kinds.
 * A 3D body has no single design face and misreads it: the chair's CAD up is +Y, which the Z-up
 * scene lays on its back.
 *
 * Display only; meshes, cuts, zone charts and export placement keep native coordinates. Per the
 * add-part skill the viewport and plate poses are deliberately different — a third frame, not a unification.
 */
export interface DisplayFrame {
  up: [number, number, number];
  front: [number, number, number];
}

export interface AssemblyKind {
  id: string;
  name: string;
  roles: AssemblyRole[];
  /** How SVG artwork maps onto the design face. 'wheel' (default) anchors on the design's circle and scales by Design radius; 'rect' maps 1:1 in mm and centers on the detected face, for parts like the footrest where a radius is meaningless. */
  designFit?: 'wheel' | 'rect';
  /** Filename in `public/templates/` of this kind's true-size template, offered in the Part panel (`scripts/gen-templates.mjs`); none shows no link. */
  templateFile?: string;
  /** Builds the template (SVG text) instead of serving a file, for generated parts with no one true size. Wins over `templateFile`. */
  buildTemplate?: () => string;
  /**
   * A numeric build parameter this kind exposes (the hubcap's disc diameter). Data, not code, so the
   * panel renders it without knowing the kind. `id` is the `state` key written, typed to existing
   * keys so a rename can't silently detach it.
   */
  buildParam?: {
    id: 'hubcapDiameterMm';
    label: string;
    minMm: number;
    /** Upper bound beyond the printer's plate, when the part has one of its own. */
    maxMm?: number;
  };
  /** Mutually-exclusive hardware variants (the chair is all-Standard or all-Kit). `state.assembly.variantId` holds the choice; roles with `libraryPartIdByVariant` load the match. First entry is the default. */
  variants?: { id: string; name: string }[];
  /** Filename in `public/stl/` of this kind's zone sidecar (`scripts/bake-zones.mjs`), on multi-face kinds with baked conformal charts; others use the flat path. */
  zonesFile?: string;
  /** Viewport pose; omitted for kinds already packed design-face-up (wheel, footrest). */
  displayFrame?: DisplayFrame;
  /** Kept and fully functional but left out of the Part dropdown — not ready to offer yet. */
  hidden?: boolean;
  /**
   * Withholds Fill mode (and the built-in pattern strip, which exists to be tiled) where tiling works
   * but isn't fit to show users. Sticker placement is unaffected. Set on the chair body:
   * `docs/tech-debt.md` measures one zone in Fill at 93.6s and "All zones" at over 900s with no
   * cancel. Clear once that closes.
   */
  withholdFill?: boolean;
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
  /**
   * The depth actually cut for this colour, display-only (docs/tech-debt.md). Undefined where no part
   * cut a normal recess for it (every landing was a cutThrough hole or edge-rule full-thickness cut,
   * or it reached no part). The minimum across parts when they clamp differently.
   */
  appliedDepth?: number;
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
   * Manifold's native indexing, kept beside the scene soup so 3MF export emits vertices/triangles
   * directly instead of re-welding, and display shading skips rehashing the vertex sharing
   * (src/geometry/creasedNormals.ts). Absent on fallback parts that never went through a boolean.
   * The scene mesh is still built from `bodySoup`/`inlaySoups`; this only supplies normals.
   */
  bodyIndexed?: IndexedMesh;
  inlayIndexed?: Record<number, IndexedMesh>;
}

/** One raw detected artwork color before merge/base resolution; feeds the base-color picker. */
export interface DetectedColor {
  hex: string;
  areaPct: number;
}

export interface AssemblyBuild {
  partOutputs: AssemblyPartOutput[];
  palette: AssemblyPaletteEntry[];
  /** Y direction of the first primary part's design face; the camera opens from this side. */
  viewSign: number;
  /** every raw fill color detected, independent of current merge/base settings */
  detectedColors: DetectedColor[];
  /** the artwork color currently assigned to the base material, if any */
  baseAssigned: { hex: string; areaPct: number } | null;
}
