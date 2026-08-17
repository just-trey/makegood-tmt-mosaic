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

// The zone layer owns these now; re-exported so importers keep their '../geometry/assembly' paths.
export { asmPartFaceNormal, faceXZBBox, rotatePointY, OVERSHOOT_MM } from './zones';

/**
 * Visual counterpart to rotatePointY, which remaps which design slice lands where but never moves
 * geometry: a duplicate part needs a real 3D transform to render clear of its source.
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
 * Collect two designs' regions for one color into one feature, WITHOUT a boolean union. Feeds
 * color detection and merge grouping only, where total area is the quantity that matters.
 * Artworks each sit near their own SVG origin (placement comes much later), so a real union would
 * fold unrelated coordinates together and undercount every shared color.
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
  /** Only used to name designs in warnings; a caller that doesn't track names cuts identically. */
  name?: string;
  /** `DesignZone.id` to cut onto. `null` means every zone the part offers (the single-zone case). */
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
   * 'sticker' (default) places one copy; 'fill' repeats it across the whole zone, one period per
   * SVG viewBox, clipped to the zone boundary.
   */
  mode?: 'sticker' | 'fill';
}

export interface AssemblyBuildInput {
  /**
   * Every design being cut, in paint order. Colors pool across all of them (one hex in two
   * artworks is one AMS slot at one depth); placement stays per artwork.
   */
  artworks: ArtworkBuildInput[];
  parts: AssemblyPart[];
  mergeGroups: string[][];
  colorSettings: ColorSettings;
  globalDepth: number;
  /** design radius in mm: the SVG boundary circle maps to this (ignored when designFit==='rect') */
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
 * Anchor for a `designFit: 'rect'` design: the center of the document canvas (viewBox or declared
 * mm box), never of the drawn content. Templates span the surface 1:1 (`zoneTemplateSVG`,
 * `gen-templates.mjs`), so a shape in one corner of the sheet wants that corner of the surface.
 * Anchoring on the content bbox re-centers every design instead.
 *
 * Null when the file declares no canvas at all; the caller then falls back to the content bbox.
 */
export function canvasAnchor(parsed: ParsedSVG): { cx: number; cy: number; r: number } | null {
  const c = parsed.canvas;
  if (!c || !(c.w > 0) || !(c.h > 0)) return null;
  return { cx: c.w / 2, cy: c.h / 2, r: Math.max(c.w, c.h) / 2 };
}

/**
 * Design anchor, per artwork: the SVG's largest <circle> (its intended outer boundary), else a
 * pseudo-circle on the artwork bbox so circle-less SVGs auto-center rather than refuse to build.
 * Rect parts anchor on the document canvas (see canvasAnchor) and skip the wheel notice.
 *
 * Shared with the gizmo (src/scene/faceFrame.ts): a frame drawn around an anchor the build didn't
 * use encloses empty face. The gizmo passes no `notice`, since it re-resolves this on every
 * refresh and would refill the warnings panel from a mouse-move.
 */
export function designAnchor(
  parsed: ParsedSVG,
  isRect: boolean,
  notice: (msg: string) => void = () => {},
): { cx: number; cy: number; r: number } {
  const existing = isRect ? null : parsed.rawSVGCircle;
  if (existing) return existing;
  // A raster anchors on its frame on every kind, wheel included, and says nothing: an image cannot
  // contain a boundary circle, so the notice below would ask every image for the impossible.
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
 * Largest flat design face across the loaded parts, memoized: the fallback size reference for a
 * rect SVG declaring no absolute mm size.
 *
 * Only a *loaded* part has a face to measure. Counting one still fetching would drop callers to
 * the 1:1 branch and report a size its own load immediately contradicts. Lazy because only the
 * no-mm-size case needs it; the wheel path never pays for the scan.
 *
 * Known limit, harmless today: this is one scale for the whole assembly, taken from the largest
 * face, while `placeOnPart` honors each part's *own* face center. The only rect kind (the
 * footrest) has a single face, so the two never disagree. A future rect assembly mixing face sizes
 * would scale artwork for the biggest face and then center that same oversized artwork on the
 * smaller ones, where the face clip would crop it. Fix when such a part ships, either by scaling
 * per part or by making the reference face an explicit choice on the AssemblyKind rather than
 * "whichever is largest". Whatever it becomes has to keep `designMmPerUnit`'s two callers (the
 * build and the on-face gizmo) agreeing, since that sharing is what makes the selection frame
 * match the cut.
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
  /** lazy `memoLargestDesignFace(parts)`, read only on the no-declared-size rect branch */
  designFace: () => { w: number; h: number } | null;
  /**
   * Extra shrink a *generated* part applied to its own shape, which the artwork must follow.
   * 1 (or absent) for every ordinary part.
   *
   * Kept separate from `designFace` because it must survive every branch below and `designFace`
   * does not: an SVG declaring an absolute mm size returns before the face is consulted. Folded
   * into the face, the hubcap's wheel cap was a silent no-op for exactly those files, which
   * includes this app's own design templates.
   */
  generatedFit?: () => number;
}

/**
 * SVG user units to mm for one placed artwork.
 *
 * Wheel: circle radius maps to the mm Design radius. Rect: convert via the file's declared
 * physical size (userUnitMM), so a template lands life-size whatever internal resolution an
 * editor re-exported it at.
 *
 * With no declared mm size, fit the viewBox to the design face rather than assuming 1 unit = 1 mm:
 * the template's viewBox *is* the face. Meet-fit (smaller axis ratio) matches SVG's own default.
 * Genuine 1:1 only when there is no viewBox either. `forceRect` is the fill path, where a tile is
 * a real-world period: radius-driven scaling would stretch one period across the whole design.
 *
 * Shared with the gizmo like `designAnchor`, and it matters more here: every artwork the app ships
 * declares `width="100%"`, so this auto-fit branch is the normal path, not an edge case.
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
    // Two strings, not one format-neutral one: setting the document size in mm is the real fix for
    // an SVG and impossible for an image, so a shared message loses the actionable half of each.
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
 * One word for the repeated thing throughout: "tile". Saying "copy" alongside it is two terms for
 * one concept in a single message (convention 1). Second person, per the README's voice rules.
 *
 * Shared because every fill fallback ends this way, including the extent-missing one that skips
 * the refusal switch below.
 */
const FILL_FELL_BACK_TO_ONE_TILE = 'You have one tile instead.';

/**
 * What to tell the user when a Fill couldn't be repeated across a part, per cause.
 *
 * `tileCoverage` refuses four ways, and one shared message told everybody to raise Scale. That is
 * the remedy for one of them only. Conventions 2 and 3 of docs/ui-conventions.md: name something
 * the user can act on, one problem with one primary remedy.
 */
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
    // Not a missing viewBox: tileCellOf already falls back to the artwork bbox when the viewBox
    // isn't positive in both axes. Reaching here means the DRAWING has no extent in one direction.
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
    // Only reachable if a future refusal path forgets to name itself. Says so rather than guessing
    // a cause, since guessing wrong is what this function exists to stop.
    default:
      return (
        `${design} couldn't be tiled across "${partName}", for a reason the app didn't record. ` +
        `${placed} Please report this.`
      );
  }
}

/**
 * Name both designs when two of them land on top of each other.
 *
 * Nothing downstream notices: cutters are built per design, the body's union looks perfect, and
 * the two inlay solids only meet in the exported file, where a slicer picks between them
 * arbitrarily. This is the one place that sees both placements against the same zone.
 *
 * Per zone, not per part: a zone spanning several printed parts is one design area, and warnings
 * dedupe by message, so a pair overlapping on every part of it says so once.
 */
function warnOverlappingDesigns(placed: PlacedDesign[]): void {
  for (const [a, b] of overlappingDesignPairs(placed)) {
    const both = a.fill && b.fill;
    const subject =
      a.name === b.name ? `Two placements of "${a.name}"` : `Designs "${a.name}" and "${b.name}"`;
    warnBuild(
      both
        ? // No move or rescale remedy, deliberately: a fill repeats across the whole face by
          // definition, and Fill is only offered on kinds with no zones (chair-body is the only
          // zoned kind and it sets withholdFill), so there is nowhere to move one to either.
          // This names only what actually clears it.
          `${subject} are both set to Fill, so they cover each other completely. Where their` +
            ' colors differ the export will carry two inlays claiming the same space. Switch one' +
            ' to Sticker, or remove it.'
        : // Bounding boxes, not the artwork itself (see designOverlap.ts). "may", not "will": a
          // logo inside another design's frame trips this while the recesses never touch.
          `${subject} overlap — where they cross, their recesses cut into` +
            ' each other and the export may carry two inlays claiming the same space. Move,' +
            ' rescale, or rotate one of them. Compared as rectangles, so designs that nest' +
            ' inside each other cleanly can trip this.',
    );
  }
}

/**
 * Vector + mesh-boolean assembly build. Per part: place the SVG's per-color net regions onto the
 * part's flat face in native coordinates, extrude each to a prism, then use Manifold to (a)
 * subtract all prisms from the part mesh (the full modified body) and (b) intersect each prism
 * with the part (a flush inlay solid per color).
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

  // Progress split like flat.ts: net regions ~0-40%, the per-part Manifold CSG loop ~40-100%.
  // `byColor` pools each artwork's regions by hex, so color detection, merging, base assignment
  // and depth all see one palette across every design in the scene.
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
  if (!Object.keys(byColor).length) return null; // no fills at all, nothing to place

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

  // Merged colors become one region, one AMS slot, one depth; `key` doubles as the depth key.
  // Base-assigned colors are excluded, so an all-base design legitimately resolves to an empty
  // palette (uncut body) rather than failing.
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

  // Regions each artwork contributes to each palette slot, indexed [color][artwork]. Grouping is
  // decided once from the pooled colors so every artwork agrees which hexes share a slot.
  const featuresByColor: (PolyFeature | null)[][] = palette.map((c, ci) =>
    // With one artwork the pooling was a no-op and applyColorMerges already unioned this slot over
    // exactly this geometry: reuse it rather than paying for the same turf union twice per rebuild.
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
    // The gizmo builds this same context from the same helper: a frame drawn around a size the cut
    // didn't use encloses empty face (see designAnchor).
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

  // User mirrors layer on top of the zone mapper's automatic per-face correction. zMul base is -1
  // because SVG Y runs top-down while the viewport is Z-up (keeps artwork right-side up on the
  // face); the user's vertical flip toggles it. The mapper's placer folds these into the per-part
  // SVG-to-face-frame map.
  //
  // A fill's tile is one period of the pattern: the viewBox (parsing bakes its origin out, so the
  // cell starts at 0,0), or the artwork's bbox when the file declares no viewBox.
  const tileCellOf = (parsed: ParsedSVG): TileCell => {
    const vb = parsed.viewBox;
    if (vb && vb.w > 0 && vb.h > 0) return { x: 0, y: 0, w: vb.w, h: vb.h };
    const b = parsed.bbox;
    return { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY };
  };
  const tileCells = artworks.map((a) => tileCellOf(a.parsed));

  const placements: DesignPlacement[] = artworks.map((a, ai) => {
    // A fill anchors on its tile, not the boundary circle: circle anchoring fits one design to the
    // Design radius, which for a pattern scales a single period up to the whole wheel.
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

  // Per-part Manifold CSG is the heavy work (turf's is done above). Yield on the same time budget
  // flat.ts's boolean passes use, and report per-part progress so the curtain climbs.
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
  // Colors an edge rule took the full thickness, and the depth taken. Said once at the end, not
  // per part: it is one fact about the design, and a color can sit on several parts. Map, not Set,
  // so the notice can state the actual depth.
  const edgeCutColors = new Map<string, number>();
  // Palette indices known to have reached some design surface: a survived boundary clip, a
  // produced inlay (a cut-through zone has no clip boundary, its boolean bounds the cut), or any
  // CSG failure involving the color, so a color lost to a broken boolean is never also told to
  // move. Only colors that provably reached nothing get the off-part warning at the end.
  const landedColors = new Set<number>();
  let anyPlacements = false;
  let viewSign = 1,
    viewSignSet = false; // Y direction of the first real part's design face
  for (const part of parts) {
    if (!part.loaded || !part.boundaryLoop || !part.positions) continue;

    // Every design surface this part takes artwork on: one implicit flat zone for an ordinary
    // part, or a sidecar kind's baked conformal charts (possibly none, for a structural piece).
    // The mapper owns all surface geometry: face direction, face-plane Y or UV chart, boundary
    // clip, cut-through depth, placement. Cutters from every zone union into the single CSG pass
    // below, so a multi-zone part is still cut exactly once.
    //
    // Placement is still global, so a multi-zone part receives the SAME artwork on each zone.
    // Per-zone artwork is the artwork-instance work (state.artworks already models it).
    const mappers = zoneMappersFor(part, parts, isRect, wasm);

    if (!part.zones) {
      // Flat-path assumption only: a conformal zone's face legitimately points sideways (the
      // chair's side panels face ±X), which is what the baked chart exists to handle.
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

    // A color can be cut on several zones of one part, so each collects a list of solids that is
    // unioned before the body/inlay booleans.
    const colorPrisms: Record<number, ManifoldSolid[]> = {};
    // Staged edge-rule colors, merged into edgeCutColors only where the part succeeds (see `keep`).
    const partEdgeColors = new Map<string, number>();
    // A plain function, not inlined below, so its early `return`s mean "skip this color" without
    // fighting the surrounding for-loop/await.
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
      // Fill: repeat the regions across the grid *in SVG space*, before placement, so tiles
      // inherit the placement's rotation/scale/offset and seam-straddling copies overlap where the
      // union can weld them.
      const tiled = grid
        ? await tileFeature(source, grid, onProgress, `color ${c.hex} on ${part.name}`)
        : source;
      if (!tiled) return;
      let feat: PolyFeature | null = mapFeatureCoords(tiled, place);
      // Whether the region really is bounded by the face. On a clipper failure safeIntersect hands
      // the region back *unclipped*, and the edge rule reads "reaches past the face boundary" as
      // "stands on the part's outer wall": an unclipped region would read as all-edge and cut
      // clean through instead of recessed. Tracked rather than assumed; see the mapper.
      let clipped = true;
      if (boundaryPoly) {
        const r = safeIntersectChecked(feat, boundaryPoly, `color ${c.hex} on ${part.name}`);
        feat = r.feat;
        clipped = r.clipped;
        if (!feat) return;
        // Only a real clip proves the color reached this face. A cut-through zone has no clip
        // boundary (its boolean against the mesh is what bounds the cut), so there a color counts
        // as landed only when that boolean yields an inlay, in the intersection loop below.
        landedColors.add(ci);
      }
      const requested = requestedDepth(colorSettings, globalDepth, c.key);
      // A depth at or below zero cuts nothing and used to drop the color silently, deleting its
      // color-list row and with it the depth field needed to fix it. Raise to a printable depth so
      // the color stays on screen and stays fixable.
      //
      // The message reports the *setting* it raised, not the cut produced: what a part does with a
      // depth is the mapper's business. Naming a cut depth here claimed 0.02 mm on a 3 mm
      // through-cut. No part name either, so it dedupes to one warning per color.
      const depthSetting = requested <= 0 ? MIN_CUT_DEPTH_MM : requested;
      const label = regionLabel(c.hex, c.isMerge, c.members.length);
      // One entry per depth this zone wants, each carrying the slice cut at it, usually just one.
      // An edge rule (a hubcap cut to its artwork's shape) splits the region into polygons
      // standing on the outer wall, cut full thickness, and the rest, cut at the setting. The
      // mapper owns that decision; this loop just extrudes what it is handed.
      const regions = mapper.resolveCutRegions(feat, depthSetting, {
        label: `color ${label}`,
        clipped,
      });
      if (requested <= 0) warnBuild(zeroDepthWarning(label, requested, depthSetting));
      // The warning above describes the setting and holds wherever the color lands. This one
      // predicts the printed recess, so it must not be said about a part that discards the setting
      // and cuts the whole way through: "too thin to show up" is wrong about a 3 mm hole. Ask the
      // mapper what it did with the number; never test `part.cutThrough` here.
      //
      // Warnings dedupe by message, so gating per-part is right when a color sits on several: the
      // note appears if any part cuts at the setting, and stays silent if none do.
      //
      // `some`, because a split color is cut at two depths at once: the interior slice deserves
      // the note, the edge slice does not.
      //
      // noticeBuild, not warnBuild: the depth is honored, not overridden. Promoting it was
      // proposed and rejected, see thinDepthNotice in depth.ts.
      else if (
        subLayerDepth(depthSetting) &&
        regions.some((r) => !depthDiffers(r.depth, depthSetting))
      )
        noticeBuild(thinDepthNotice(label, depthSetting));
      // Only the refinement differs for a fill (a zone-wide cutter would explode at the sticker
      // step); the snap tolerance is a property of the bake, so both modes take the same one.
      const cutterOpts = grid ? { refineMM: FILL_REFINE_MM } : undefined;
      // Each slice becomes its own prism, landing in the colorPrisms[ci] list the multi-zone case
      // already fills, so the union below welds them into one solid per color.
      //
      // The edge notice promises the rim prints in this color, so it is staged per *part* and
      // merged build-wide only once this part emits inlays. Every later failure (the per-color
      // union, the body difference) returns early without merging, so the promise can't outlive
      // the geometry. Recording build-wide put "the rim prints in that color" next to "exporting
      // it uncut".
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
          // Clipping dense line-work to the part boundary can leave the region self-touching:
          // valid to turf, non-watertight to Manifold. Repair with Manifold's own 2D boolean
          // engine and retry once before giving up.
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
        // The artwork survived the boundary clip but no cutter came out. On a conformal zone the
        // warp found no surface under part of the region (usually a baked boundary claiming more
        // area than the chart covers); on a flat one, a region too degenerate to extrude. Same
        // user-facing outcome as a cutter that fails to become a solid, so they share this message
        // (warnings dedupe by text). Silence would drop the color with no explanation.
        //
        // `continue`, not `return`: a color split across two depths must not lose its interior
        // recess because the edge slice failed to extrude, or the other way round.
        landedColors.add(ci);
        warnBuild(`Couldn't cut color ${c.hex} into "${part.name}".`);
      }
    };
    // Artworks landing on a zone: those bound to it by id, plus any unbound one. Unbound is the
    // single-zone case (wheel, footrest), which goes wherever the part offers.
    const artworksOn = (mapper: ZoneMapper): number[] =>
      artworks.flatMap((a, ai) => (a.zoneId == null || a.zoneId === mapper.zoneId ? [ai] : []));

    // +1 reserved for the body/inlay CSG stage below, so progress reaches 1 only once every color
    // on every zone plus the final cuts are done.
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
        anyPlacements = true;
        const place = mapper.placer(placements[ai]);
        // One grid per (zone, artwork): every color of a fill repeats identically, so the
        // inverted-placement coverage math runs once, not per palette slot. A fill that can't be
        // tiled degrades to a single copy plus a warning rather than an empty part.
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
            // fit state reaching only the ACTIVE one, and warnings dedupe on the exact string. Two
            // designs failing the same way would otherwise become one pill pointing at neither.
            // Two placements of the SAME design still collapse, since they share a name; splitting
            // those needs warnOverlappingDesigns's counted phrasing, which nothing asks for yet.
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
        // This color's cutters (different zones, same part) couldn't be merged. Drop just this
        // color rather than losing the whole part's cut.
        landedColors.add(+ci);
        warnBuild(
          `Couldn't merge color ${palette[+ci].hex} on "${part.name}". It won't print there.`,
        );
        continue;
      }
      if (merged !== list[0]) owned.push(merged);
      prismEntries.push([+ci, merged]);
    }
    if (!prismEntries.length) {
      // No cuts landed (or none survived the merge above): emit the untouched body so the
      // assembly still exports whole.
      partOutputs.push({ part, bodySoup: Float32Array.from(part.positions), inlaySoups: {} });
      owned.forEach(manifoldDelete);
      finishPart();
      continue;
    }

    let partMan: ManifoldSolid;
    try {
      partMan = soupToManifold(wasm, part.positions);
    } catch {
      prismEntries.forEach(([pci]) => landedColors.add(pci));
      warnBuild(`Couldn't read "${part.name}", so it is not exported.`);
      owned.forEach(manifoldDelete);
      finishPart();
      continue;
    }
    if (!manifoldIsValid(partMan)) {
      prismEntries.forEach(([pci]) => landedColors.add(pci));
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
      // Nothing to cut with. Same escape as the non-watertight branch above: export the untouched
      // body rather than risk a half-cut/half-inlaid pair that would overlap.
      prismEntries.forEach(([pci]) => landedColors.add(pci));
      warnBuild(`Couldn't merge the recesses on "${part.name}". It exports with no artwork.`);
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
    // `body` is declared outside the try so the finally frees it even when the throw came from
    // manifoldToMeshes rather than the boolean. Otherwise the solid leaks, unreachable.
    let body: ManifoldSolid | null = null;
    try {
      csgFault('difference');
      body = Manifold.difference(partMan, cutter);
      // After the solid exists, before conversion: the only injection point exercising the
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
      // Body and inlays come from the same boolean pass. If the cut failed, building inlays anyway
      // ships an uncut body plus inlay solids in the same volume, which a slicer resolves
      // arbitrarily. Export uncut and inlay-less instead.
      prismEntries.forEach(([pci]) => landedColors.add(pci));
      warnBuild(
        `Couldn't cut the recesses into "${part.name}". It exports with no artwork. ` +
          `Cutting halfway would leave two colors claiming the same space.`,
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
          landedColors.add(ci);
        }
      } catch {
        // Unlike the body-cut failure above, exporting uncut can't undo this: the body's pocket
        // for this color is already cut, and redoing that difference is the expensive half. Name
        // the color and say the recess ships empty, so the warning is actionable.
        landedColors.add(ci);
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

    // The part shipped with its inlays, so what the edge rule did is now true of the export and
    // can be said. Merged, not assigned: a color can reach the edge on one part and not another.
    for (const [l, d] of partEdgeColors) edgeCutColors.set(l, d);

    partOutputs.push({ part, bodySoup, inlaySoups, bodyIndexed, inlayIndexed });
    finishPart();
  }
  // Once, after every part: one notice naming every color the edge rule took the full way through.
  // Grouped by cut depth, a single value in practice (one part has the rule) but per-part in the
  // model, so grouping keeps the message honest if a second such part lands.
  const byEdgeDepth = new Map<number, string[]>();
  for (const [label, depth] of edgeCutColors) {
    const at = byEdgeDepth.get(depth);
    if (at) at.push(label);
    else byEdgeDepth.set(depth, [label]);
  }
  for (const [depth, labels] of byEdgeDepth) noticeBuild(edgeCutThroughNotice(labels, depth));
  // Gated on anyPlacements so a build with no design surfaces at all doesn't call every color
  // missing. See landedColors above for what counts as landed.
  if (anyPlacements) {
    const missed = palette
      .map((c, ci) =>
        landedColors.has(ci) ? null : regionLabel(c.hex, c.isMerge, c.members.length),
      )
      .filter((l): l is string => l !== null);
    if (missed.length === 1)
      warnBuild(
        `"${missed[0]}" lands entirely off the part and won't print. ` +
          `Lower Scale or move the design to bring it back.`,
      );
    else if (missed.length)
      warnBuild(
        `${missed.length} colors land entirely off the part and won't print: ` +
          `${missed.map((l) => `"${l}"`).join(', ')}. Lower Scale or move the design to bring them back.`,
      );
  }
  return { partOutputs, palette, viewSign, detectedColors, baseAssigned };
}

/**
 * Palette indices that actually ship: an inlay on a part that still has a body to export (a part
 * whose cut consumed it whole is dropped at export, inlays and all). The one predicate behind the
 * export's material list, the color list's rows, and the slot count. Three sites each deriving
 * their own version of this is how a color came to cost an AMS slot while printing nothing.
 */
export function shippedColorIndices(partOutputs: AssemblyPartOutput[]): Set<number> {
  const shipped = new Set<number>();
  for (const o of partOutputs) {
    if (!o.bodySoup.length) continue;
    for (const ci of Object.keys(o.inlaySoups)) shipped.add(+ci);
  }
  return shipped;
}
