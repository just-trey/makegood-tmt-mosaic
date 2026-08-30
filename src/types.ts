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
   * Millimeters per SVG user (viewBox) unit, from the document's physical width/height. Only rect
   * assembly placement reads it, to map artwork 1:1 in mm whatever the file's internal resolution.
   * Null when the SVG declares no size a printer could act on, which includes a px-only size with
   * no viewBox (px is the editor's DPI, not a measurement). Wheel mode scales off the circle.
   */
  userUnitMM?: number | null;
  /**
   * The viewBox extent in user units, null when the document declares no viewBox. The fill tile
   * period: one repeat of a pattern, falling back to the artwork bbox when absent.
   */
  viewBox?: { w: number; h: number } | null;
  /**
   * The document's canvas in user units, origin at (0,0): the viewBox extent when declared, else
   * the declared width/height at 96dpi (with no viewBox a user unit is a px by definition). Rect
   * placement anchors on this, not the drawn content, so a design positioned within its sheet
   * keeps that position, and fits it to the design face when `userUnitMM` is null. Null when the
   * file declares neither, leaving only the content to anchor on.
   *
   * Distinct from `viewBox`, which stays the viewBox alone because the fill tile cell means
   * specifically that.
   */
  canvas?: { w: number; h: number } | null;
  /**
   * Which producer built this. Absent means the SVG parser, so existing callers read as before.
   * Only assembly.ts's sizing/anchor advice reads it, because that advice must be actionable:
   * "set your document size in millimetres" is the right fix for an SVG and impossible for a PNG.
   */
  origin?: 'svg' | 'raster';
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
  /** ±1 vertical multiplier: base −1 (SVG y-down to plate y-up), flipped again by the user toggle */
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
 * A design zone on a part: one baked UV chart the artwork maps into, letting a part carry several
 * design surfaces (and eventually wrap artwork around edges). Populated by the zone bake pipeline.
 * A part with no zones uses an implicit flat zone from its chosen patch (`implicitZoneFor` in
 * geometry/zones.ts), which also holds the runtime chart and mapper detail.
 */
export interface DesignZone {
  id: string;
  name: string;
  /**
   * The baked UV chart this zone's artwork wraps onto, reconstructed against the part's loaded
   * mesh (see geometry/zoneCharts.ts). Present on a conformal zone; absent means flat projection.
   */
  chart?: ConformalChart;
  /**
   * Filename of this zone's true-to-size template in `public/templates/`: the per-zone counterpart
   * to `AssemblyKind.templateFile`, for a kind whose parts each carry several design surfaces.
   */
  templateFile?: string;
}

/** Identifies one design zone: which part it lives on, and the zone's stable id within that part. */
export interface ZoneRef {
  partId: number;
  zoneId: string;
}

/**
 * What a raster source keeps so its palette can be recomputed without re-reading the file.
 *
 * Decoding pixels is the expensive, async, DOM-bound part of loading an image; the Colors and
 * Detail sliders re-run only quantize/trace over them. At the working resolution that is at most
 * ~1MB per image, against three.js, the Manifold WASM and a 1.7MB zone sidecar.
 */
export interface RasterState {
  /**
   * The working image, `RasterImage` rather than a bare pixel buffer so `edgeDensity` rides with
   * it: that statistic is measured at a fixed reference size and cannot be re-derived from these
   * pixels, and session restore has to put it back or every threshold hanging off it moves.
   */
  image: RasterImage;
  colors: number;
  detail: number;
  /**
   * mm per working pixel at the placement this image was traced for, which is what put the
   * despeckle floor in printable units (see `rasterMmPerPixel`). Saved with the session so a
   * restore reproduces the same trace: restore re-traces before the parts are back, so it cannot
   * derive this for itself. Absent on a session saved before it existed.
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
   * The raw SVG text `parsed` came from, kept rather than derived because `ParsedSVG` is a one-way
   * parse. Session persistence re-derives `parsed` from this via `parseSVGDocument()` instead of
   * serializing the parsed form, which regions.ts also memoizes on object identity.
   *
   * Empty for a raster source, whose `parsed` comes from pixels and cannot be re-derived this way.
   * Session persistence stores those pixels re-encoded instead, and re-traces them on restore.
   */
  svgText: string;
  raster?: RasterState;
}

/**
 * One placement of a DesignSource onto a zone: what the on-face gizmo and fit sliders target.
 * `zone: null` means the part's single implicit zone (see `implicitZoneFor` in geometry/zones.ts).
 * Multiple instances per source/zone become reachable once the artwork list panel exists; today
 * there is always exactly one, auto-created alongside its source.
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
   * 3MF: what a baked zone chart's vertex indices address. Absent for an STL upload, which has no
   * packed vertex order to index into.
   */
  vertices?: Float32Array;
  /**
   * The same packed mesh as an index: unique vertices plus 3 indices per triangle, exactly as the
   * 3MF stores it. `positions` is this expanded, corner for corner in the same order, which is
   * what lets display shading read the vertex sharing instead of rehashing it.
   *
   * **Must be set or cleared wherever `positions` is replaced**, or it describes the previous mesh:
   * both branches of `asmLoadPartBuffer` and the `buildMesh` branch of `asmAdoptMesh` today.
   * `indexMatchesSoup` is the backstop, and it only catches the crash-shaped half.
   *
   * Absent for a part loaded from an `.stl` manifest entry, which records no sharing at all.
   */
  indexed?: IndexedMesh;
  /** which stl/parts.json entry this part was loaded from */
  libraryPartId?: string;
  /**
   * The library asset as fetched, for a role whose mesh is *built* from that asset rather than
   * being it (see AssemblyRole.buildMesh). Kept so a changed build parameter can regenerate the
   * part without another network round trip, leaving `positions` free to hold the result.
   */
  assetPositions?: Float32Array;
  /**
   * The warning the last buildMesh raised, retracted before the next rebuild so fixing the
   * parameter also clears it. Generation warnings are standing facts (nothing re-derives them per
   * rebuild, so clearBuildWarnings doesn't apply) that the user can act on, which is what
   * dismissNotice is for.
   */
  buildWarning?: string;
  /** part geometry minus the design face; preview context only */
  restPositions?: Float32Array;
  patches: FlatPatch[] | null;
  patchIdx: number;
  /**
   * Every closed boundary loop of the chosen patch, ordered by X/Z area so the face outline is
   * first and any hole or smaller island follows. Outer-vs-hole is resolved where the loops are
   * used, by containment depth, never by winding or by vertex count: a hole rim is as much of the
   * part's outer wall as the outline is, and an intricate cut-out can out-vertex what encloses it.
   */
  boundaryLoops: number[][][] | null;
  patchNormal?: number[];
  /**
   * Baked design zones for a part of a kind shipping a zone sidecar (`AssemblyKind.zonesFile`).
   * Undefined means no sidecar applies, so the part uses one implicit flat zone from its chosen
   * patch (the pre-conformal behavior). An *empty* array means something different: the sidecar
   * loaded but bakes no zone onto this piece (the chair's caster mounts), so it takes no artwork
   * at all rather than falling back to stamping its largest flat patch.
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
   * Fixed cut depth (mm) for a cutThrough part, straight down from the face plane. The cap's shell
   * is only 3mm thick above its mounting boss, so cutting deeper breaches into it. Undefined
   * pierces the part's full vertical extent.
   */
  cutThroughDepth?: number;
  /**
   * Cut depth (mm) for artwork regions *touching this part's design-face boundary*; interior
   * regions keep their per-color recess depth. Undefined means no such rule.
   *
   * The per-region counterpart to the kind-wide cutThrough. A hubcap cut to its artwork's shape
   * wants its outline in the artwork's color the whole way down, or cutting it to shape only
   * achieves a 2mm band of base color around the picture. Its interior detail still wants a recess.
   *
   * Set from GeneratedMesh.edgeCutThroughDepth at adopt time, not from the role at create time:
   * whether it applies depends on what the generator built (a silhouette, not the circle it falls
   * back to), which isn't known until it runs.
   */
  edgeCutThroughDepth?: number;
}

export interface AssemblyRole {
  id: string;
  name: string;
  libraryPartId?: string;
  /**
   * Variant-dependent library part, for a role whose physical piece differs by hardware variant
   * (the chair's caster mounts come in Standard and Kit). Maps each `AssemblyKind.variants` id to
   * its library part. Takes precedence over `libraryPartId`; resolved by `roleLibraryPartId`.
   */
  libraryPartIdByVariant?: Record<string, string>;
  allowRotatedCopies: boolean;
  /** rotated copies auto-added beyond the primary by "load full assembly" */
  copies?: number;
  copyDefaults?: { pivotX: number; pivotZ: number; angleDeg: number };
  /**
   * Display name for a rotated copy: a wheel's second Top half is physically the Bottom half.
   * Falls back to "<role name> (rotated copy)".
   */
  copyName?: string;
  /** parts of this role get a through-cut (see AssemblyPart.cutThrough) instead of a recess */
  cutThrough?: boolean;
  /** see AssemblyPart.cutThroughDepth */
  cutThroughDepth?: number;
  /**
   * Preferred design face as a unit normal. The loader then defaults to the largest-area patch
   * pointing this way instead of the overall largest, needed when a part's biggest flat face isn't
   * its design face (the footrest's flat back outsizes its seat).
   */
  preferFaceNormal?: [number, number, number];
  /**
   * Builds this role's mesh from its library asset plus the user's settings, instead of the asset
   * being the part. The hubcap is the one such role: only its four mounting clips ship as a mesh,
   * and the disc they carry is generated at the requested diameter and unioned on.
   *
   * A function on the role, not a flag the loader switches on, so nothing in src/assembly/ has to
   * know a hubcap exists: the loader's rule is "if the role can build its own mesh, let it".
   * Re-run by asmRebuildGeneratedParts when a parameter changes.
   */
  buildMesh?: (asset: Float32Array) => Promise<GeneratedMesh>;
  /**
   * The verified plate placement for this role's *current* build parameters, undefined when
   * nothing was verified for them.
   *
   * Generated parts can't use the fingerprint seal every other placement hangs off: their mesh
   * varies by design, so it never matches. What can be verified is a specific arrangement at a
   * specific size, and this is how the role says which. Undefined is a real answer, meaning the
   * export should compute a position and say so.
   *
   * Typed loosely because the placement shape lives in src/export/; the caller narrows it.
   */
  buildPlacement?: () => Record<string, unknown> | undefined;
}

/** What an AssemblyRole.buildMesh returns: the part's mesh, plus anything the user should know. */
export interface GeneratedMesh {
  positions: Float32Array;
  vertices?: Float32Array;
  /**
   * `positions` as an index, when the generator has one. Manifold returns it from every boolean,
   * so a generator building its mesh that way gets it for nothing; display shading uses it to skip
   * rediscovering the vertex sharing by hashing. Omit it and shading falls back, correctly.
   */
  indexed?: IndexedMesh;
  /** Surfaced to the user as-is; the generator knows why its output is off, the loader doesn't. */
  warning?: string;
  /**
   * See AssemblyPart.edgeCutThroughDepth. Declared by the generator because only it knows the
   * shape it made: on a flat square-edged prism cut to the artwork's outline, "touching the
   * design-face boundary" and "reaching the part's outer wall" are the same thing. On a chamfered
   * disc they are not, so it returns undefined there.
   */
  edgeCutThroughDepth?: number;
}

/**
 * How an assembly is posed in the *viewport*, in native part coordinates: `up` renders as world
 * up, `front` faces the default camera.
 *
 * The app's implicit part-frame convention, "the design face is a Y-plane", doubles as a display
 * pose for a plate-like kind (the wheel and footrest stand up facing the camera for free). A 3D
 * body has no single design face, so it is packed in its CAD frame and that convention misreads
 * it: the chair's CAD up is +Y, which the Z-up scene renders horizontal, laying it on its back.
 *
 * Display only. Part meshes, the cut pipeline, baked zone charts and export plate placement all
 * keep native coordinates. Per the add-part skill the viewport pose and plate pose are
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
   * and scales by Design radius, right for the round wheel. 'rect' maps the SVG 1:1 in mm and
   * centers on the detected face, for rectangular parts like the footrest where a radius control
   * is meaningless.
   */
  designFit?: 'wheel' | 'rect';
  /**
   * Filename of this kind's true-to-size template in `public/templates/`, offered as a download in
   * the Part panel. Generated by `scripts/gen-templates.mjs`; a kind without one shows no link.
   */
  templateFile?: string;
  /**
   * Builds the template instead of serving a file, for a kind whose parts are generated and have
   * no one true size. Takes precedence over `templateFile`. Returns SVG text.
   */
  buildTemplate?: () => string;
  /**
   * A numeric build parameter this kind exposes to the user (the hubcap's disc diameter).
   *
   * Data, not code, so the panel renders the control without knowing which kind it belongs to,
   * same as `designFit` and `templateFile`. `id` is the `state` key the control writes, typed to
   * the keys that exist so a rename can't silently detach it.
   */
  buildParam?: {
    id: 'hubcapDiameterMm';
    label: string;
    minMm: number;
    /** Upper bound beyond the printer's plate, when the part has one of its own. */
    maxMm?: number;
  };
  /**
   * Mutually-exclusive hardware variants of this assembly (the chair is all-Standard or all-Kit,
   * never mixed). `state.assembly.variantId` holds the choice and roles with a
   * `libraryPartIdByVariant` load the matching piece. The first entry is the default.
   */
  variants?: { id: string; name: string }[];
  /**
   * Filename of this kind's design-zone sidecar in `public/stl/`, baked by
   * `scripts/bake-zones.mjs`. Present on multi-face kinds whose parts carry baked conformal charts
   * instead of a single implicit flat zone; kinds without one use the flat path.
   */
  zonesFile?: string;
  /**
   * Viewport pose for this kind. Omitted for kinds already packed design-face-up (the wheel and
   * footrest), which render correctly with no transform.
   */
  displayFrame?: DisplayFrame;
  /**
   * Kept in ASSEMBLY_KINDS and fully functional, but left out of the Part dropdown: for a part not
   * ready to offer to users yet.
   */
  hidden?: boolean;
  /**
   * Withholds Fill mode (and the built-in pattern strip, which exists to be tiled) on this kind,
   * where tiling works but isn't fit to put in front of a user. Sticker placement is unaffected.
   *
   * Set on the chair body: `docs/tech-debt.md` measures one zone in Fill at 93.6s and "All zones"
   * at over 900s with no cancel, and records `Zebra + Fill` losing a color on "Handle (left)",
   * which prints that part without its black. Clear this flag once those close.
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
   * The depth actually cut for this colour, display-only (docs/tech-debt.md). Undefined where no
   * part ever cut a normal recess for it (every landing was a cutThrough hole or an edge-rule
   * full-thickness cut, or the colour reached no part at all). The minimum across parts when they
   * clamp it to different depths, so the field shows the more-restrictive fact.
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
   * directly instead of re-welding. Absent on fallback parts that never went through a boolean.
   *
   * Read by 3MF export and by display shading, which uses it to skip rediscovering the vertex
   * sharing by hashing (see src/geometry/creasedNormals.ts). The scene mesh is still built from
   * `bodySoup`/`inlaySoups`; this only supplies the normals for it.
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
