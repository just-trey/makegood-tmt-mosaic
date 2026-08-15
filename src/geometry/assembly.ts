import * as THREE from 'three';
import type { Position } from 'geojson';
import {
  MIN_CUT_DEPTH_MM,
  depthDiffers,
  edgeCutThroughNotice,
  regionLabel,
  requestedDepth,
  subLayerDepth,
  thinDepthNotice,
  zeroDepthWarning,
} from './depth';
import type {
  AssemblyBuild,
  AssemblyPaletteEntry,
  AssemblyPart,
  AssemblyPartOutput,
  ColorSettings,
  DetectedColor,
  IndexedMesh,
  ParsedSVG,
  PolyFeature,
} from '../types';
import {
  applyColorMerges,
  computeNetRegionsByColor,
  planarArea,
  safeIntersect,
  safeIntersectChecked,
  safeUnion,
  YIELD_BUDGET_MS,
  yieldToBrowser,
} from './regions';
import {
  getManifold,
  manifoldDelete,
  manifoldIsValid,
  manifoldToMeshes,
  mapFeatureCoords,
  repairSelfIntersections,
  soupToManifold,
  type ManifoldSolid,
} from './manifold';
import {
  faceXZBBox,
  OVERSHOOT_MM,
  type CutRegion,
  type DesignPlacement,
  type ZoneMapper,
} from './zones';
import { zoneMappersFor } from './zoneMappers';
import { FILL_REFINE_MM } from './conformal';
import {
  MAX_FILL_TILES,
  tileCoverage,
  tileFeature,
  type TileCell,
  type TileGrid,
  type TileRefusal,
} from './patterns';
import { overlappingDesignPairs, type PlacedDesign } from './designOverlap';
import { generatedDesignFaceOverride, generatedFitFactor } from '../assembly/kinds';
import { noticeBuild, warnBuild } from '../warnings';
import { csgFault, resetCsgFaults } from './csgFault';
import { reportProgress } from '../progress';

// Re-exported from ./zones so existing importers (exportPanel, faceFrame, rebuild, tests) keep
// their `from '../geometry/assembly'` paths — these are part-geometry primitives the zone layer
// now owns.
export { asmPartFaceNormal, faceXZBBox, rotatePointY, OVERSHOOT_MM } from './zones';

/**
 * Visual counterpart to rotatePointY: a duplicate part's rendered meshes need an actual 3D
 * transform (rotatePointY only remaps *which design slice* lands where, never moves geometry),
 * so a rotated copy renders at its own real position instead of overlapping its source part.
 * Three.js's rotation.y sign convention is opposite rotatePointY's, hence the negation.
 */
export function asmPartTransformGroup(part: AssemblyPart): {
  outer: THREE.Group;
  add(mesh: THREE.Object3D): void;
} {
  if (!part.isDuplicateOf) {
    const outer = new THREE.Group();
    return {
      outer,
      add(mesh) {
        outer.add(mesh);
      },
    };
  }
  const outer = new THREE.Group();
  outer.position.set(part.pivotX, 0, part.pivotZ);
  outer.rotation.y = (-part.angleDeg * Math.PI) / 180;
  const inner = new THREE.Group();
  inner.position.set(-part.pivotX, 0, -part.pivotZ);
  outer.add(inner);
  return {
    outer,
    add(mesh) {
      inner.add(mesh);
    },
  };
}

/**
 * Collect two designs' regions for one color into a single feature, WITHOUT a boolean union.
 * This only ever feeds color detection and merge grouping, where the quantity that matters is
 * how much of that color there is in total. Separate artworks all live near their own SVG
 * origin, so a real union would fold unrelated designs' overlapping coordinates together and
 * undercount every shared color — skewing the area percentages, the dominant-member pick, and
 * which color gets assigned to the base. Placement is applied per artwork much later.
 */
function concatFeatures(a: PolyFeature, b: PolyFeature): PolyFeature {
  const polysOf = (f: PolyFeature): Position[][][] =>
    f.geometry.type === 'MultiPolygon'
      ? (f.geometry.coordinates as Position[][][])
      : [f.geometry.coordinates as Position[][]];
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'MultiPolygon', coordinates: [...polysOf(a), ...polysOf(b)] },
  } as PolyFeature;
}

/** One placed design: an SVG, where it goes, and which surface it goes on. */
export interface ArtworkBuildInput {
  parsed: ParsedSVG;
  /**
   * The design source's name, used only to say which designs a warning is about. Optional because
   * the build needs nothing from it — a caller that doesn't track names still cuts identically.
   */
  name?: string;
  /**
   * The `DesignZone.id` this artwork is cut onto. `null` means "every zone the part offers",
   * which is what a single-zone part's artwork always is — so the ordinary wheel/footrest flow
   * passes one unbound artwork and behaves exactly as before.
   */
  zoneId?: string | null;
  scaleMult: number;
  offX: number;
  offZ: number;
  /** user horizontal mirror (fixes artwork that reads back-to-front on the face) */
  flipX: boolean;
  /** user vertical mirror, on top of the built-in SVG y-down correction */
  flipY: boolean;
  /** design rotation about its center on the face, in degrees (0 = as authored) */
  rotationDeg: number;
  /**
   * 'sticker' (default) places one copy of the design; 'fill' repeats it across the whole zone,
   * one period per SVG viewBox, clipped to the zone boundary.
   */
  mode?: 'sticker' | 'fill';
}

export interface AssemblyBuildInput {
  /**
   * Every design being cut, in paint order. Colors are pooled across all of them — the same hex
   * in two artworks is one AMS slot at one depth — while placement stays per artwork.
   */
  artworks: ArtworkBuildInput[];
  parts: AssemblyPart[];
  mergeGroups: string[][];
  colorSettings: ColorSettings;
  globalDepth: number;
  /** design radius in mm — the SVG boundary circle maps to this (ignored when designFit==='rect') */
  radius: number;
  /** how artwork maps onto the face; 'rect' scales the SVG 1:1 in mm and centers on the face */
  designFit?: 'wheel' | 'rect';
  autoMergeLevel?: number;
  baseColorKey?: string | null;
  /** every raw hex the base assignment excludes from cutting (see state/store.ts addToBase) */
  baseColorMembers?: string[];
  keptApart?: string[];
}

/**
 * Where a `designFit: 'rect'` design's own coordinate frame is pinned to the target surface: the
 * center of the document canvas (its viewBox, or its declared mm box), not of the drawn content.
 *
 * A zone/part template is drawn in the surface's own mm frame — `zoneTemplateSVG` and
 * `gen-templates.mjs` both emit a canvas that spans the surface 1:1 — so a shape sitting in one
 * corner of the sheet is asking to be cut in that corner of the surface. Anchoring on the content
 * bbox instead re-centers every design, which is what put a fender-shaped drawing on whichever
 * part happened to occupy the middle of the `left` zone.
 *
 * The two agree exactly when the artwork fills its canvas (bbox center == canvas center), which is
 * the case every design that worked before this hits.
 *
 * Null when the file declares no canvas at all — neither a viewBox nor a physical size — since
 * then there is nothing to anchor to but the content, and the caller falls back to its bbox.
 */
export function canvasAnchor(parsed: ParsedSVG): { cx: number; cy: number; r: number } | null {
  const c = parsed.canvas;
  if (!c || !(c.w > 0) || !(c.h > 0)) return null;
  return { cx: c.w / 2, cy: c.h / 2, r: Math.max(c.w, c.h) / 2 };
}

/**
 * Design anchor, per artwork: the SVG's largest <circle> when there is one (the design's
 * intended outer boundary), otherwise a pseudo-circle around the artwork's bounding box —
 * centered on the artwork, radius = half its larger dimension — so circle-less SVGs still
 * auto-center on the hub and span the design diameter instead of refusing to build. Rect parts
 * anchor on the document canvas (see canvasAnchor) and skip the wheel notice.
 *
 * Shared with the gizmo ([src/scene/faceFrame.ts]) rather than restated there: a frame drawn
 * around an anchor the build didn't use encloses empty face instead of the artwork. `notice` is
 * the build's own reporter; the gizmo passes nothing, since it re-resolves this on every refresh
 * and would otherwise refill the warnings panel from a mouse-move.
 */
export function designAnchor(
  parsed: ParsedSVG,
  isRect: boolean,
  notice: (msg: string) => void = () => {},
): { cx: number; cy: number; r: number } {
  const existing = isRect ? null : parsed.rawSVGCircle;
  if (existing) return existing;
  // A raster anchors on its frame on every kind, wheel included, and says nothing about it: an
  // image cannot contain a boundary circle, so the notice below would fire on every image ever
  // loaded onto the wheel while asking for something impossible.
  const isRaster = parsed.origin === 'raster';
  if (isRect || isRaster) {
    const canvas = canvasAnchor(parsed);
    if (canvas) return canvas;
  }
  const bbox = parsed.bbox;
  if (!isRect && !isRaster)
    notice(
      'This SVG has no <circle> marking the design boundary — the artwork was auto-centered on the hub using its bounding box. Use Design radius / Scale / Offset to adjust the fit.',
    );
  return {
    cx: (bbox.minX + bbox.maxX) / 2,
    cy: (bbox.minY + bbox.maxY) / 2,
    r: Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY) / 2 || 1,
  };
}

/**
 * The largest flat design face across the loaded parts, memoized — the fallback size reference for
 * a rect SVG that declares no absolute mm size.
 *
 * Only a *loaded* part has a face to measure. A part still fetching from the library would
 * otherwise leave this null, drop callers to the 1:1 branch, and report a size the rebuild its own
 * load triggers immediately contradicts — so when nothing is loaded yet, say nothing (there's no
 * geometry to place either). Lazy because only that no-mm-size case needs it: the wheel path never
 * pays for the scan.
 */
export function memoLargestDesignFace(
  parts: AssemblyPart[],
): () => { w: number; h: number } | null {
  let memo: { w: number; h: number } | null | undefined;
  return () => {
    if (memo !== undefined) return memo;
    let found: { w: number; h: number } | null = null;
    for (const p of parts) {
      if (!p.loaded) continue;
      const bb = faceXZBBox(p.boundaryLoop);
      if (bb && bb.w > 0 && bb.h > 0 && (!found || bb.w * bb.h > found.w * found.h))
        found = { w: bb.w, h: bb.h };
    }
    return (memo = found);
  };
}

/** What `designMmPerUnit` needs about the assembly the design is being placed on. */
export interface DesignScaleContext {
  isRect: boolean;
  /** the wheel's Design radius in mm; unused on a rect kind */
  radius: number;
  /** lazy `memoLargestDesignFace(parts)` — only read on the no-declared-size rect branch */
  designFace: () => { w: number; h: number } | null;
  /**
   * Extra shrink a *generated* part had to apply to its own shape, which the artwork has to follow.
   * 1 (or absent) for every ordinary part.
   *
   * Separate from `designFace` because it has to survive every branch below, and `designFace` does
   * not: an SVG that declares an absolute mm size returns before the face is ever consulted. The
   * hubcap's wheel cap was folded into the face at first and was silently a no-op for exactly those
   * files — which includes this app's own design templates, the one artwork we ship people.
   */
  generatedFit?: () => number;
}

/**
 * SVG user units → mm for one placed artwork.
 *
 * Wheel: SVG circle radius maps to the mm Design radius. Rect: convert SVG units to mm via the
 * file's declared physical size (userUnitMM) so a template lands life-size even if an editor
 * re-exported it at a different internal resolution.
 *
 * When a rect SVG declares no absolute mm size, fit its viewBox to the design face rather than
 * assuming 1 unit = 1 mm. The template's viewBox *is* the face, so any template trace then lands
 * life-size at Scale 100% even when the editor dropped the physical size (e.g. Affinity exports
 * `width="100%"` and rescales the viewBox to its own resolution). Meet-fit (the smaller axis
 * ratio) matches SVG's default fitting. Genuine 1:1 fallback only when there's no viewBox either.
 * `forceRect` is the fill path: a tile's size is a real-world period, so it maps in mm on every
 * kind — the wheel's radius-driven scaling would stretch one period across the whole design.
 *
 * Shared with the gizmo for the same reason as `designAnchor`, and it matters more here: every
 * artwork the app ships stubs for declares `width="100%"`, so `userUnitMM` is null and this
 * auto-fit branch is the *normal* path, not an edge case. A gizmo that assumed 1 unit = 1 mm drew
 * its frame several times the size of the cut.
 */
export function designMmPerUnit(
  parsed: ParsedSVG,
  scaleMult: number,
  anchorR: number,
  ctx: DesignScaleContext,
  forceRect = false,
  notice: (msg: string) => void = () => {},
): number {
  // Applied to every branch below, deliberately: see DesignScaleContext.generatedFit.
  const fit = ctx.generatedFit?.() ?? 1;
  if (!ctx.isRect && !forceRect) return (ctx.radius / anchorR) * scaleMult * fit;
  if (parsed.userUnitMM != null) return parsed.userUnitMM * scaleMult * fit;
  const vb = parsed.viewBox;
  const designFace = ctx.designFace();
  if (designFace && vb && vb.w > 0 && vb.h > 0) {
    // Two strings rather than one format-neutral one: setting the document size in millimetres is
    // the real fix for an SVG and impossible for an image, and a message that covered both would
    // have to drop the actionable half for each.
    notice(
      parsed.origin === 'raster'
        ? 'This image has no real-world size, so it was auto-fit to the part face. Use Scale to fine-tune.'
        : 'This SVG has no absolute width/height in mm, so it was auto-fit to the part face. Set the document size in millimeters for an exact size, or use Scale to fine-tune.',
    );
    return Math.min(designFace.w / vb.w, designFace.h / vb.h) * scaleMult * fit;
  }
  if (designFace)
    notice(
      'This SVG has no absolute width/height in mm, so its true print size is unknown — placing it 1:1 with its coordinate units. Set the document size in millimeters, or use Scale to correct the fit.',
    );
  return scaleMult * fit;
}

/** The design's content bounding box, placed: a convex quad in the zone's own 2D design space. */
function placedBBoxQuad(parsed: ParsedSVG, place: (pt: number[]) => number[]): number[][] {
  const b = parsed.bbox;
  return [
    [b.minX, b.minY],
    [b.maxX, b.minY],
    [b.maxX, b.maxY],
    [b.minX, b.maxY],
  ].map(place);
}

/**
 * What to tell the user when a Fill couldn't be repeated across a part, per cause.
 *
 * There are four ways `tileCoverage` refuses and they used to share one message, which told
 * everybody to raise Scale. That is the remedy for exactly one of them; on the others it is advice
 * that cannot work, offered instead of the thing that would. Conventions 2 and 3 of
 * docs/ui-conventions.md: name something the user can act on, and state one problem with one
 * primary remedy.
 *
 * Every branch ends the same way — a single copy was placed — because that is what actually
 * happened to their part, and it is the same in all four.
 */
/**
 * One word for the repeated thing, throughout: "tile". Saying "copy" in the same breath is two
 * terms for one concept inside a single message (convention 1). Second person, since this is UI
 * copy and the README's voice rules ask for it.
 *
 * Shared rather than retyped because every fill fallback ends this way, including the
 * extent-missing one that doesn't route through the refusal switch below.
 */
const FILL_FELL_BACK_TO_ONE_TILE = 'You have one tile instead.';

export function fillRefusalMessage(
  designName: string,
  partName: string,
  reason: TileRefusal | undefined,
): string {
  const placed = FILL_FELL_BACK_TO_ONE_TILE;
  const design = `"${designName}"`;
  switch (reason) {
    case 'too-many-tiles':
      return (
        `${design} is too small to fill "${partName}" — it would take more than ` +
        `${MAX_FILL_TILES} tiles. ${placed} Raise Scale to fill it with fewer, larger tiles.`
      );
    // Not a missing viewBox: tileCellOf falls back to the artwork's own bounding box whenever the
    // viewBox isn't positive in both axes, so reaching here means the DRAWING has no extent in one
    // direction — every filled shape colinear, in a file with no usable viewBox either.
    case 'no-tile-size':
      return (
        `${design} measures zero in one direction, so there is no tile to repeat across ` +
        `"${partName}". ${placed} Use a design with both width and height.`
      );
    case 'not-invertible':
      return (
        `The placement of ${design} on "${partName}" has collapsed to no width or no height, so ` +
        `its tiles can't be worked out. ${placed} Use "Reset to auto-fit" to put it back.`
      );
    case 'not-affine':
      return (
        `"${partName}" curves too much for ${design} to tile evenly across it. ${placed} Place ` +
        'separate designs on it instead of filling it.'
      );
    // Only reachable if a future refusal path forgets to name itself. Says so rather than
    // guessing a cause, since guessing wrong is the thing this function exists to stop.
    default:
      return (
        `${design} couldn't be tiled across "${partName}", for a reason the app didn't record. ` +
        `${placed} Please report this.`
      );
  }
}

/**
 * Name both designs when two of them land on top of each other on one surface.
 *
 * Nothing further down the pipeline notices this: each design's cutters are built independently,
 * the body takes their union and looks perfect, and the color list counts the same colors it would
 * have anyway — the two inlay solids only meet in the exported file, where a slicer picks between
 * them however it likes. This is the one place that sees both placements against the same surface.
 *
 * Per zone (not per part): a zone spanning several printed parts is one surface, and warnings
 * dedupe by message, so a pair that overlaps on every part of it says so once.
 */
function warnOverlappingDesigns(placed: PlacedDesign[]): void {
  for (const [a, b] of overlappingDesignPairs(placed)) {
    const both = a.fill && b.fill;
    const subject =
      a.name === b.name ? `Two placements of "${a.name}"` : `Designs "${a.name}" and "${b.name}"`;
    warnBuild(
      both
        ? // Moving or rescaling a fill can't help — it repeats across the whole surface by
          // definition — so this case names only the things that actually clear it.
          `${subject} are both set to Fill on the same surface. A fill repeats across the whole` +
            ' surface, so the second one lands on the first everywhere: where their colors differ,' +
            ' the export will carry two inlays claiming the same space. Switch one to Sticker,' +
            ' move it to another surface, or remove it.'
        : // Bounding boxes, not the artwork itself — see designOverlap.ts. "may" rather than
          // "will", because a design whose ink sits inside another's hollow (a logo inside a
          // frame) trips this while the recesses never actually touch.
          `${subject} overlap on the same surface — where they cross, their recesses cut into` +
            ' each other and the export may carry two inlays claiming the same space. Move,' +
            ' rescale, or rotate one of them. Compared as rectangles, so designs that nest' +
            ' inside each other cleanly can trip this.',
    );
  }
}

/**
 * Vector + mesh-boolean assembly build. For each part: take the SVG's real per-color net
 * regions, place them onto the part's flat face in the part's own native coordinates, extrude
 * each to a prism, then use Manifold to (a) subtract all prisms from the real part mesh -> the
 * FULL modified body, and (b) intersect each prism with the part -> a flush inlay solid per
 * color.
 */
export async function buildAssemblyGeometry(
  input: AssemblyBuildInput,
): Promise<AssemblyBuild | null> {
  resetCsgFaults();
  const {
    artworks,
    parts,
    mergeGroups,
    colorSettings,
    globalDepth,
    radius,
    designFit,
    autoMergeLevel,
    baseColorKey,
    baseColorMembers,
    keptApart,
  } = input;
  if (!artworks.length || artworks.some((a) => !a.parsed)) return null;

  const isRect = designFit === 'rect';

  const anchorOf = (parsed: ParsedSVG) => designAnchor(parsed, isRect, noticeBuild);

  // Split like flat.ts: the per-color net regions are ~0-40%, then the per-part Manifold CSG
  // loop below (the actual heavy work in assembly mode) covers ~40-100%. Each artwork gets its
  // own net regions; `byColor` pools them by hex so color detection, merging, base assignment and
  // depth all see one palette across every design in the scene.
  const perArtworkColors: Record<string, PolyFeature>[] = [];
  for (let i = 0; i < artworks.length; i++) {
    const r = await computeNetRegionsByColor(artworks[i].parsed.shapes, (f) =>
      reportProgress(((i + f) / artworks.length) * 0.4),
    );
    perArtworkColors.push(r.byColor);
  }
  const byColor: Record<string, PolyFeature> = {};
  for (const one of perArtworkColors)
    for (const [hex, feat] of Object.entries(one))
      byColor[hex] = byColor[hex] ? concatFeatures(byColor[hex], feat) : feat;
  if (!Object.keys(byColor).length) return null; // no fills at all — nothing to place

  const totalRawArea = Object.values(byColor).reduce((s, f) => s + planarArea(f), 0) || 1;
  const detectedColors: DetectedColor[] = Object.keys(byColor)
    .map((hex) => ({ hex, areaPct: (100 * planarArea(byColor[hex])) / totalRawArea }))
    .sort((a, b) => b.areaPct - a.areaPct);
  // baseColorMembers covers a whole merged group when a merged slot was sent to base; falls back
  // to just the dominant hex for older callers/plain-color assignments.
  const baseMembers =
    baseColorMembers && baseColorMembers.length
      ? baseColorMembers
      : baseColorKey
        ? [baseColorKey]
        : [];
  const baseArea = baseMembers.reduce((s, h) => s + planarArea(byColor[h] ?? null), 0);
  // the body prints the base's dominant (largest-area) member, same as a merged cut slot would
  const dominantBaseMember = baseMembers.reduce<{ hex: string; area: number } | null>((best, h) => {
    const area = planarArea(byColor[h] ?? null);
    return !best || area > best.area ? { hex: h, area } : best;
  }, null);
  const baseAssigned =
    baseColorKey && baseArea > 0
      ? {
          hex: dominantBaseMember?.hex ?? baseColorKey,
          areaPct: (100 * baseArea) / totalRawArea,
        }
      : null;

  // Honor "merge colors" here too — merged colors become one region / one AMS slot / one depth.
  // `key` doubles as the per-region depth key. A base-assigned color is excluded here, so an
  // all-base design legitimately resolves to an empty palette (uncut body) rather than failing.
  const resolved = applyColorMerges(byColor, mergeGroups, {
    autoMergeLevel,
    baseColors: baseMembers,
    keptApart,
  });
  const palette: AssemblyPaletteEntry[] = resolved.map((r) => ({
    hex: r.previewColor,
    key: 'asm:' + r.key,
    members: r.members,
    isMerge: r.isMerge,
  }));

  // The regions each artwork contributes to each palette slot, indexed [color][artwork]. The
  // grouping above is decided once from the pooled colors so every artwork agrees on which hexes
  // share a slot; here each artwork's own geometry is folded into those same slots. An artwork
  // that doesn't use a color contributes nothing to it.
  const featuresByColor: (PolyFeature | null)[][] = palette.map((c, ci) =>
    // With one artwork the pooling above was a no-op, so applyColorMerges already unioned this
    // slot's members over exactly this geometry — reuse it rather than paying for the same turf
    // union twice on every rebuild.
    artworks.length === 1
      ? [resolved[ci].feature]
      : perArtworkColors.map((one) => {
          let feat: PolyFeature | null = null;
          for (const hex of c.members) {
            const part = one[hex];
            if (part) feat = feat ? safeUnion(feat, part) : part;
          }
          return feat;
        }),
  );

  const scaleCtx: DesignScaleContext = {
    isRect,
    radius,
    // The gizmo builds this same context from the same helper — a frame drawn around a different
    // size than the cut used encloses empty face, which is what designAnchor's comment warns of.
    designFace: () => generatedDesignFaceOverride() ?? memoLargestDesignFace(parts)(),
    generatedFit: generatedFitFactor,
  };
  const mmPerUnitOf = (
    parsed: ParsedSVG,
    scaleMult: number,
    anchorR: number,
    forceRect = false,
  ): number => designMmPerUnit(parsed, scaleMult, anchorR, scaleCtx, forceRect, noticeBuild);

  let wasm;
  try {
    wasm = await getManifold();
  } catch (e) {
    warnBuild(
      'Could not load the Manifold boolean engine — assembly cutting is unavailable. ' +
        (e as Error).message,
    );
    return null;
  }
  const { Manifold } = wasm;

  // User-requested mirrors, layered on top of the automatic per-face correction the zone mapper
  // applies. zMul base is -1 because SVG Y runs top-down while the viewport is Z-up (keeps the
  // artwork right-side up on the face); the user's vertical flip toggles that. The mapper's
  // placer folds these design params into the per-part SVG→face-frame map.
  //
  // A fill's tile is one period of the pattern: the document's viewBox (parsing bakes its origin
  // out, so the cell starts at 0,0), or the artwork's own bbox for a file that declares no viewBox.
  const tileCellOf = (parsed: ParsedSVG): TileCell => {
    const vb = parsed.viewBox;
    if (vb && vb.w > 0 && vb.h > 0) return { x: 0, y: 0, w: vb.w, h: vb.h };
    const b = parsed.bbox;
    return { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY };
  };
  const tileCells = artworks.map((a) => tileCellOf(a.parsed));

  const placements: DesignPlacement[] = artworks.map((a, ai) => {
    // A fill anchors on its tile, not on the design's boundary circle: circle anchoring exists to
    // fit one design to the Design radius, which for a pattern would scale a single period up to
    // the whole wheel (and emit the "no <circle>" notice at every user).
    const cell = tileCells[ai];
    const fill = a.mode === 'fill';
    const svgC = fill
      ? { cx: cell.x + cell.w / 2, cy: cell.y + cell.h / 2, r: Math.max(cell.w, cell.h) / 2 || 1 }
      : anchorOf(a.parsed);
    return {
      svgC,
      mmPerUnit: mmPerUnitOf(a.parsed, a.scaleMult, svgC.r, fill),
      xFlip: a.flipX ? -1 : 1,
      zMul: a.flipY ? 1 : -1,
      offX: a.offX,
      offZ: a.offZ,
      rotationDeg: a.rotationDeg,
    };
  });

  // Per-part Manifold CSG is the actual heavy work here (turf's part is done above) — yield to
  // the browser on the same time budget flat.ts's boolean passes use, and report progress across
  // parts so the "Rebuilding…" curtain climbs instead of freezing for the whole loop.
  const totalParts = parts.filter((p) => p.loaded && p.boundaryLoop && p.positions).length || 1;
  let partsDone = 0;
  let lastYield = performance.now();
  const maybeYield = async (): Promise<void> => {
    if (performance.now() - lastYield > YIELD_BUDGET_MS) {
      await yieldToBrowser();
      lastYield = performance.now();
    }
  };
  const reportPartProgress = (subFraction: number): void => {
    reportProgress(0.4 + ((partsDone + subFraction) / totalParts) * 0.6);
  };
  const finishPart = (): void => {
    partsDone++;
    reportPartProgress(0);
  };

  const partOutputs: AssemblyPartOutput[] = [];
  // Colors that had regions taken the full thickness by a part's edge rule, and the depth they
  // were taken at. Collected across every part and said once at the end rather than per part:
  // this is one fact about the design ("your artwork reaches the rim"), and a color can sit on
  // more than one part. Map, not Set, so the notice can state the actual depth.
  const edgeCutColors = new Map<string, number>();
  let viewSign = 1,
    viewSignSet = false; // Y direction of the first real part's design face
  for (const part of parts) {
    if (!part.loaded || !part.boundaryLoop || !part.positions) continue;

    // Every design surface this part takes artwork on: one implicit flat zone for an ordinary
    // part, or the baked conformal charts of a sidecar-backed kind (which may be none at all, for
    // a structural piece). The mapper owns all the surface geometry — face direction, face-plane
    // Y or UV chart, boundary clip, cut-through depth, placement — that used to be computed
    // inline here. Cutters from every zone are unioned into the single CSG pass below, so a
    // multi-zone part is still cut exactly once.
    //
    // Placement is still global, so a multi-zone part currently receives the SAME artwork on each
    // of its zones. Choosing artwork per zone is the artwork-instance work (state.artworks already
    // models it); until that lands, only the hidden chair kind has more than one zone.
    const mappers = zoneMappersFor(part, parts, isRect, wasm);

    if (!part.zones) {
      // Flat-path assumption only: a conformal zone's face legitimately points sideways (the
      // chair's side panels face ±X), which is precisely what the baked chart exists to handle.
      const nrm = mappers[0].faceNormal;
      if (nrm && Math.abs(nrm[1]) < 0.9) {
        warnBuild(
          `Part "${part.name}": detected face normal (${nrm.map((v) => v.toFixed(2)).join(', ')}) isn't vertical. Assembly cutting assumes a horizontal face — pick a different face or the cut may be wrong.`,
        );
      }
    }
    if (mappers.length && !part.isDuplicateOf && !viewSignSet) {
      viewSign = mappers[0].nsign;
      viewSignSet = true;
    }

    // One color can now be cut on several zones of the same part, so each color collects a list
    // of solids that is unioned before the body/inlay booleans.
    const colorPrisms: Record<number, ManifoldSolid[]> = {};
    // Staged edge-rule colors for this part; merged into edgeCutColors only where the part
    // succeeds. See `keep` below.
    const partEdgeColors = new Map<string, number>();
    // Extracted to a plain function (rather than inlined in the loop below) purely so its
    // early `return`s mean "skip this color" without fighting the surrounding for-loop/await.
    const buildColorPrism = async (
      mapper: ZoneMapper,
      boundaryPoly: PolyFeature | null,
      place: (pt: number[]) => number[],
      grid: TileGrid | null,
      c: AssemblyPaletteEntry,
      ci: number,
      ai: number,
      onProgress: (fraction: number) => void,
    ): Promise<void> => {
      const source = featuresByColor[ci][ai];
      if (!source) return;
      // Fill: repeat the color's regions across the grid *in SVG space*, before placement, so the
      // tiles inherit the placement's rotation/scale/offset and the seam-straddling copies overlap
      // exactly where the union can weld them.
      const tiled = grid
        ? await tileFeature(source, grid, onProgress, `color ${c.hex} on ${part.name}`)
        : source;
      if (!tiled) return;
      let feat: PolyFeature | null = mapFeatureCoords(tiled, place);
      // Whether the region really is bounded by the face. On a clipper failure safeIntersect hands
      // back the region *unclipped*, and the edge rule reads "reaches past the face boundary" as
      // "stands on the part's outer wall" — so an unclipped region would read as all-edge and be
      // cut clean through instead of recessed. Tracked rather than assumed; see the mapper.
      let clipped = true;
      if (boundaryPoly) {
        const r = safeIntersectChecked(feat, boundaryPoly, `color ${c.hex} on ${part.name}`);
        feat = r.feat;
        clipped = r.clipped;
        if (!feat) return;
      }
      const requested = requestedDepth(colorSettings, globalDepth, c.key);
      // A depth at or below zero cuts nothing, and used to drop the color from the part in
      // silence — which also deleted its color-list row, since a color with no inlay area
      // anywhere gets no row, leaving no depth field to correct. Raise it to a depth that prints
      // instead, so the color stays on screen and stays fixable.
      //
      // The message reports the *setting* it raised, not the cut it produced: what a part does
      // with a depth is the mapper's business. Naming a cut depth here claimed 0.02 mm on a part
      // being cut 3 mm through.
      //
      // No part name either: depth is a per-color setting, so this dedupes to one warning rather
      // than one per part carrying the color.
      const depthSetting = requested <= 0 ? MIN_CUT_DEPTH_MM : requested;
      const label = regionLabel(c.hex, c.isMerge, c.members.length);
      // One entry per depth this zone wants used, each carrying the slice of the region cut at it
      // — usually just one. A part with an edge rule (a hubcap cut to its artwork's shape) splits
      // the region into the polygons standing on its outer wall, cut its full thickness, and the
      // rest, cut at the setting. The mapper owns that decision; this loop just extrudes what it
      // is handed.
      const regions = mapper.resolveCutRegions(feat, depthSetting, {
        label: `color ${label}`,
        clipped,
      });
      if (requested <= 0) warnBuild(zeroDepthWarning(label, requested, depthSetting));
      // Unlike the warning above — which describes the setting, and is true wherever the color
      // lands — this one predicts what the recess will look like printed, so it must not be said
      // about a part that discards the setting and takes its hole the whole way through: "too thin
      // to show up" is wrong about a 3 mm hole. Ask the mapper what it did with the number rather
      // than testing `part.cutThrough` here; the mapper owns that decision.
      //
      // Warnings dedupe by message, so gating per-part says the right thing when a color sits on
      // several: the note appears if any part cuts at the setting, and stays silent if none do.
      //
      // `some`, because a split color is cut at two depths at once: the interior slice still takes
      // the setting and still deserves the note, while the edge slice does not — saying "too thin
      // to show up" about a 3 mm through-cut is exactly the falsehood this gate exists to prevent.
      //
      // noticeBuild, not warnBuild: the depth is honored, not overridden. Promoting it was
      // proposed and rejected — see thinDepthNotice in depth.ts.
      else if (
        subLayerDepth(depthSetting) &&
        regions.some((r) => !depthDiffers(r.depth, depthSetting))
      )
        noticeBuild(thinDepthNotice(label, depthSetting));
      // Only the refinement differs for a fill (a zone-wide cutter would explode at the sticker
      // step); the snap tolerance is a property of the bake, so both modes take the same one.
      const cutterOpts = grid ? { refineMM: FILL_REFINE_MM } : undefined;
      // Each slice becomes its own prism. They land in the same colorPrisms[ci] list the multi-zone
      // case already fills, so the union below welds them back into one solid per color — a split
      // region needs no handling downstream of here.
      // The edge notice promises the rim prints in this color, so it is staged per *part* and only
      // merged into the build-wide map once this part actually emits inlays. Every way the part can
      // still fail after this point — the per-color union, the body difference — returns early
      // without merging, so the promise can't outlive the geometry backing it. Recording straight
      // into the build-wide map put "the rim prints in that color" next to "exporting it uncut".
      const keep = (man: ManifoldSolid, region: CutRegion): void => {
        (colorPrisms[ci] ||= []).push(man);
        if (region.edge) partEdgeColors.set(label, region.depth);
      };
      for (const region of regions) {
        const soup = mapper.buildCutter(region.feat, region.depth, OVERSHOOT_MM, cutterOpts);
        if (soup && soup.length) {
          try {
            const man = soupToManifold(wasm, soup);
            if (!manifoldIsValid(man)) throw new Error('empty manifold');
            keep(man, region);
            continue;
          } catch {
            /* retry below with self-intersections repaired */
          }
          // Clipping dense/overlapping line-work to the part boundary can leave the region
          // self-touching in a way turf doesn't flag as invalid but Manifold rejects as
          // non-watertight — repair it with Manifold's own 2D boolean engine and retry once
          // before giving up.
          try {
            const repaired = repairSelfIntersections(wasm, region.feat);
            const soup2 =
              repaired && mapper.buildCutter(repaired, region.depth, OVERSHOOT_MM, cutterOpts);
            if (soup2 && soup2.length) {
              const man2 = soupToManifold(wasm, soup2);
              if (manifoldIsValid(man2)) {
                keep(man2, region);
                continue;
              }
            }
          } catch {
            /* fall through to warn */
          }
        }
        // The artwork overlapped this zone (it survived the boundary clip) but no cutter came out.
        // On a conformal zone that means the warp found no surface under part of the region —
        // usually a baked boundary claiming more area than the chart actually covers; on a flat
        // one, a region too degenerate to extrude. Same user-facing outcome as a cutter that
        // fails to become a solid, so they share this message (warnings dedupe by text); staying
        // silent would drop the color from the part with no explanation at all.
        //
        // `continue`, not `return`: a color split across two depths must not lose its interior
        // recess because the edge slice failed to extrude, or the other way round.
        warnBuild(`Couldn't build the cut solid for color ${c.hex} on "${part.name}".`);
      }
    };
    // Which artworks land on a given zone: those bound to it by id, plus any unbound one. An
    // unbound artwork is the single-zone case (wheel, footrest) and goes wherever the part offers
    // — binding only starts to matter once a part has more than one surface to choose between.
    const artworksOn = (mapper: ZoneMapper): number[] =>
      artworks.flatMap((a, ai) => (a.zoneId == null || a.zoneId === mapper.zoneId ? [ai] : []));

    // +1 reserved for the body/inlay CSG stage below, so this part's progress reaches 1 only
    // once everything (colors on every zone + final cuts) is actually done.
    const zoneWork = mappers.map(artworksOn);
    const partUnits = palette.length * zoneWork.reduce((s, l) => s + l.length, 0) + 1;
    let unitsDone = 0;
    for (let zi = 0; zi < mappers.length; zi++) {
      const mapper = mappers[zi];
      if (!zoneWork[zi].length) continue;
      if (zoneWork[zi].length > 1)
        warnOverlappingDesigns(
          zoneWork[zi].map((ai) => ({
            name: artworks[ai].name || 'design',
            quad: placedBBoxQuad(artworks[ai].parsed, mapper.placer(placements[ai])),
            fill: artworks[ai].mode === 'fill',
          })),
        );
      const boundaryPoly = mapper.boundary();
      for (const ai of zoneWork[zi]) {
        const place = mapper.placer(placements[ai]);
        // One grid per (zone, artwork) — every color of the same fill repeats identically, so the
        // (inverted-placement) coverage math runs once rather than per palette slot. A fill that
        // can't be tiled degrades to a single copy plus a warning, which is at least visible and
        // adjustable, rather than an empty part.
        let grid: TileGrid | null = null;
        if (artworks[ai].mode === 'fill') {
          const extent = mapper.fillExtent();
          if (!extent) {
            warnBuild(
              `Couldn't measure the area to fill on "${part.name}", so "${artworks[ai].name || 'design'}" ` +
                `can't be tiled across it. ${FILL_FELL_BACK_TO_ONE_TILE} Please report this.`,
            );
          } else {
            const refusal: { reason?: TileRefusal } = {};
            grid = tileCoverage(place, tileCells[ai], extent, refusal);
            // Named per design, not just per part: a part can carry several, both remedies write
            // fit state that only reaches the ACTIVE one, and warnings dedupe on the exact string
            // — so without the name two designs failing the same way on one part become one pill
            // pointing at neither. Two placements of the SAME design still collapse into one pill,
            // since they share a name; distinguishing those needs the counted phrasing
            // warnOverlappingDesigns uses ("Two placements of …"), which nothing asks for yet.
            if (!grid)
              warnBuild(
                fillRefusalMessage(artworks[ai].name || 'design', part.name, refusal.reason),
              );
          }
        }
        for (let ci = 0; ci < palette.length; ci++) {
          const base = unitsDone;
          await buildColorPrism(mapper, boundaryPoly, place, grid, palette[ci], ci, ai, (f) =>
            reportPartProgress((base + f) / partUnits),
          );
          reportPartProgress(++unitsDone / partUnits);
          await maybeYield();
        }
      }
    }

    // Per color: the union of its cutters across every zone. `owned` tracks each solid exactly
    // once (originals plus any union built from them) so the cleanup below frees all of them.
    const owned: ManifoldSolid[] = [];
    const prismEntries: [number, ManifoldSolid][] = [];
    for (const [ci, list] of Object.entries(colorPrisms)) {
      owned.push(...list);
      let merged: ManifoldSolid;
      try {
        if (list.length === 1) {
          merged = list[0];
        } else {
          csgFault('color-union');
          merged = Manifold.union(list);
        }
      } catch {
        // This color's cutters (from different zones of the same part) couldn't be merged —
        // drop just this color rather than losing the whole part's cut.
        warnBuild(
          `Couldn't combine the cut solids for color ${palette[+ci].hex} on "${part.name}".`,
        );
        continue;
      }
      if (merged !== list[0]) owned.push(merged);
      prismEntries.push([+ci, merged]);
    }
    if (!prismEntries.length) {
      // no cuts land on this part (or none survived the merge above) — emit the untouched body
      // so the assembly still exports whole
      partOutputs.push({ part, bodySoup: Float32Array.from(part.positions), inlaySoups: {} });
      owned.forEach(manifoldDelete);
      finishPart();
      continue;
    }

    let partMan: ManifoldSolid;
    try {
      partMan = soupToManifold(wasm, part.positions);
    } catch {
      warnBuild(`Part "${part.name}" mesh couldn't be read by the boolean engine.`);
      owned.forEach(manifoldDelete);
      finishPart();
      continue;
    }
    if (!manifoldIsValid(partMan)) {
      warnBuild(
        `Part "${part.name}" isn't a watertight/manifold mesh, so it can't be cut cleanly — repair it (close holes, fix flipped faces) and retry. Exporting it uncut for now.`,
      );
      partOutputs.push({ part, bodySoup: Float32Array.from(part.positions), inlaySoups: {} });
      manifoldDelete(partMan);
      owned.forEach(manifoldDelete);
      finishPart();
      continue;
    }

    // full modified body = part - union(all color pockets)
    const prismList = prismEntries.map(([, p]) => p);
    let cutter: ManifoldSolid;
    try {
      if (prismList.length === 1) {
        cutter = prismList[0];
      } else {
        csgFault('part-union');
        cutter = Manifold.union(prismList);
      }
    } catch {
      // Nothing to cut with — same escape as the non-watertight branch above: export the
      // untouched body rather than risk a half-cut/half-inlaid pair that would overlap.
      warnBuild(`Couldn't combine this part's cut solids on "${part.name}" — exporting it uncut.`);
      partOutputs.push({ part, bodySoup: Float32Array.from(part.positions), inlaySoups: {} });
      manifoldDelete(partMan);
      owned.forEach(manifoldDelete);
      finishPart();
      continue;
    }
    if (cutter !== prismList[0]) owned.push(cutter);
    let bodySoup: Float32Array;
    let bodyIndexed: AssemblyPartOutput['bodyIndexed'];
    let bodyCutFailed = false;
    // `body` is declared outside the try so the finally can free it even when the throw came
    // from manifoldToMeshes rather than the boolean — otherwise the solid is unreachable.
    let body: ManifoldSolid | null = null;
    try {
      csgFault('difference');
      body = Manifold.difference(partMan, cutter);
      // After the solid exists, before it's converted: the only injection point that exercises the
      // finally's freed handle rather than just the degradation.
      csgFault('body-mesh');
      const meshes = manifoldToMeshes(body);
      bodySoup = meshes.soup;
      bodyIndexed = meshes.indexed;
    } catch {
      bodyCutFailed = true;
      bodySoup = Float32Array.from(part.positions);
    } finally {
      manifoldDelete(body);
    }
    await maybeYield();

    if (bodyCutFailed) {
      // The body and its inlays come from the same boolean pass — if the cut itself failed,
      // building inlays anyway would ship a solid uncut body plus inlay solids occupying the
      // same volume, which a slicer resolves arbitrarily. Export uncut and inlay-less instead.
      warnBuild(
        `Boolean cut failed on part "${part.name}" — exporting it uncut and without inlays ` +
          `(a half-done cut/inlay pair would overlap in the export).`,
      );
      partOutputs.push({ part, bodySoup, inlaySoups: {} });
      owned.forEach(manifoldDelete);
      manifoldDelete(partMan);
      finishPart();
      continue;
    }

    // per-color inlay = part ∩ prism (the part caps the overshoot, so the inlay top is flush)
    const inlaySoups: Record<number, Float32Array> = {};
    const inlayIndexed: Record<number, IndexedMesh> = {};
    for (const [ci, prism] of prismEntries) {
      let inl: ManifoldSolid | null = null;
      try {
        csgFault('intersection');
        inl = Manifold.intersection(partMan, prism);
        const { soup, indexed } = manifoldToMeshes(inl);
        if (soup.length) {
          inlaySoups[ci] = soup;
          inlayIndexed[ci] = indexed;
        }
      } catch {
        // Unlike the body-cut failure above, this can't be undone by exporting uncut — the
        // body's pocket for this color is already cut and redoing that difference is the
        // expensive half. Name the color and say the recess ships empty so the warning is
        // actionable rather than just alarming.
        warnBuild(
          `Couldn't fit the inlay for color ${palette[ci].hex} on "${part.name}" — its pocket ` +
            `is cut into the body but will print as an empty recess.`,
        );
      } finally {
        manifoldDelete(inl);
      }
      await maybeYield();
    }

    owned.forEach(manifoldDelete);
    manifoldDelete(partMan);

    // The part shipped with its inlays, so anything the edge rule did to it is now true of the
    // export and can be said. Merged rather than assigned: a color can reach the edge on one part
    // and not another, and the notice is one line about the design.
    for (const [l, d] of partEdgeColors) edgeCutColors.set(l, d);

    partOutputs.push({ part, bodySoup, inlaySoups, bodyIndexed, inlayIndexed });
    finishPart();
  }
  // Once, after every part: one notice naming every color the edge rule took the full way through.
  // Grouped by the depth cut, which is a single value in practice (one part has the rule) but is
  // per-part in the model, so grouping keeps the message honest if a second such part ever lands.
  const byEdgeDepth = new Map<number, string[]>();
  for (const [label, depth] of edgeCutColors) {
    const at = byEdgeDepth.get(depth);
    if (at) at.push(label);
    else byEdgeDepth.set(depth, [label]);
  }
  for (const [depth, labels] of byEdgeDepth) noticeBuild(edgeCutThroughNotice(labels, depth));
  return { partOutputs, palette, viewSign, detectedColors, baseAssigned };
}
