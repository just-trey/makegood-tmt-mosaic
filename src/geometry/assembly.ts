import * as THREE from 'three';
import {
  edgeCutThroughNotice,
  regionLabel,
  thinWallWarning,
  tooDeepWarning,
  zeroDepthWarning,
} from './depth';
import type {
  AssemblyBuild,
  AssemblyPaletteEntry,
  AssemblyPart,
  AssemblyPartOutput,
  ColorSettings,
  DetectedColor,
  ParsedSVG,
  PolyFeature,
} from '../types';
import {
  applyColorMerges,
  computeNetRegionsByColor,
  planarArea,
  safeUnion,
  YIELD_BUDGET_MS,
  yieldToBrowser,
} from './regions';
import { getManifold } from './manifold';
import type { DesignPlacement, KeepSide } from './zones';
import { zoneMappersFor } from './zoneMappers';
import { featureVertexCount, type TileCell } from './patterns';
import { noticeBuild, warnBuild } from '../warnings';
import { resetCsgFaults } from './csgFault';
import { reportProgress } from '../progress';
import { throwIfCancelled } from '../cancel';
import { fillCoveredNotice } from './assemblyWarnings';
import { isCuttable, type BuildContext, type BuildTally, type PartProgress } from './buildContext';
import {
  designAnchor,
  designMmPerUnit,
  memoLargestDesignFace,
  type DesignScaleContext,
} from './designScale';
import { polysOf } from './designClip';
import { buildPart } from './partBuild';

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
 * Two designs' regions for one color in one feature, WITHOUT a union: feeds color detection and
 * merge grouping, where only total area matters. Each artwork sits near its own SVG origin until
 * placement, so a real union would fold unrelated coordinates and undercount every shared color.
 */
function concatFeatures(a: PolyFeature, b: PolyFeature): PolyFeature {
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
  /**
   * The largest `scaleMult` the Scale control allows, so a fill refused for detail can tell "raise
   * Scale" from "raising Scale will not reach". Defaults to `scaleMult` (no headroom).
   */
  maxScaleMult?: number;
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
  /**
   * Set when this design keeps one half of a self-mirrored zone, its reflection the other. The half
   * kept is the one the placed centre lies on; this value settles only a design centred exactly on
   * the line, where a mirrored pair would otherwise both keep the same half.
   */
  keepSide?: KeepSide;
  /** Set on the reflection mirroredBuildInput makes, so a notice about the pair is said once. */
  reflected?: boolean;
  /** Shared by a mirrored design and its reflection; the overlap check never compares the two. */
  mirrorPair?: string;
  /**
   * Set on every placement `netToZoneBuildInput` makes, so the cut is clipped to the canvas this
   * zone owns on the whole-part sheet rather than to everything its own chart reaches. Off for a
   * design bound to this zone by name, which is the whole reason the partition costs no surface.
   */
  netBound?: boolean;
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
  /**
   * A generated part's stand-ins for the design face and its wheel-cap shrink
   * (`generatedDesignFaceOverride`, `generatedFitFactor` in assembly/kinds.ts). Read from live state
   * by the caller, because the build may run in a worker that has none. Absent: no override, fit 1.
   */
  designFaceOverride?: { w: number; h: number } | null;
  generatedFit?: number;
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
    designFaceOverride,
    generatedFit,
  } = input;
  if (!artworks.length || artworks.some((a) => !a.parsed)) return null;

  const isRect = designFit === 'rect';

  const anchorOf = (parsed: ParsedSVG) => designAnchor(parsed, isRect, noticeBuild);

  // Progress split: net regions ~0-40%, the per-part Manifold CSG loop ~40-100%.
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
    designFace: () => designFaceOverride ?? memoLargestDesignFace(parts)(),
    generatedFit: () => generatedFit ?? 1,
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
      'Could not load the Manifold engine, so assembly cutting is unavailable. ' +
        (e as Error).message,
    );
    return null;
  }

  // User mirrors layer on the mapper's per-face correction. zMul base is -1 because SVG Y runs down
  // while the viewport is Z-up; the user's vertical flip toggles it.
  // A fill's tile is one period: the viewBox (parsing bakes its origin out, so it starts at 0,0),
  // or the artwork bbox when no viewBox is declared.
  const tileCellOf = (parsed: ParsedSVG): TileCell => {
    const vb = parsed.viewBox;
    if (vb && vb.w > 0 && vb.h > 0) return { x: 0, y: 0, w: vb.w, h: vb.h };
    const b = parsed.bbox;
    return { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY };
  };
  const tileCells = artworks.map((a) => tileCellOf(a.parsed));

  // Points one tile costs the union, over its biggest color: the union runs per color, which is
  // what tileCoverage's ceiling caps. Hoisted so the part/zone loops don't re-walk every ring.
  const tileVerts = artworks.map((_a, ai) =>
    featuresByColor.reduce((n, perArtwork) => Math.max(n, featureVertexCount(perArtwork[ai])), 0),
  );

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

  // The same placement at maximum Scale: a fill refused for detail is re-asked against it, so
  // "raise Scale" is offered only where the slider reaches a small enough grid (predicting from the
  // padding rule's 3x3 minimum was wrong in between). Built on demand with the no-op notice sink:
  // auto-fit notices for a Scale the user never set are not theirs to see.
  const maxScalePlacement = (ai: number): DesignPlacement => ({
    ...placements[ai],
    mmPerUnit: designMmPerUnit(
      artworks[ai].parsed,
      artworks[ai].maxScaleMult ?? artworks[ai].scaleMult,
      placements[ai].svgC.r,
      scaleCtx,
      true,
    ),
  });

  // Per-part Manifold CSG is the heavy work (turf's is done above). Yield on a time budget and
  // report per-part progress so the curtain climbs.
  const totalParts = parts.filter(isCuttable).length || 1;
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

  const progress: PartProgress = { reportPartProgress, maybeYield };
  const ctx: BuildContext = {
    artworks,
    palette,
    featuresByColor,
    placements,
    maxScalePlacement,
    tileCells,
    tileVerts,
    colorSettings,
    globalDepth,
    wasm,
  };
  const tally: BuildTally = {
    tornPills: new Map(),
    overlapCheckedZones: new Set(),
    edgeCutColors: new Map(),
    zeroDepthRaises: new Map(),
    tooDeepClamps: new Map(),
    thinWallClamps: new Map(),
    colorAppliedDepth: new Map(),
    landedColors: new Set(),
    hiddenColors: new Set(),
    coveredColors: new Set(),
    exposedColors: new Set(),
  };

  const partOutputs: AssemblyPartOutput[] = [];
  let anyPlacements = false;
  let viewSign = 1,
    viewSignSet = false; // Y direction of the first real part's design face
  for (const part of parts) {
    if (!isCuttable(part)) continue;
    throwIfCancelled();

    // One implicit flat zone, or a sidecar kind's baked conformal charts (possibly none). The
    // mapper owns all surface geometry; every zone's cutters union into one CSG pass, so a part is
    // cut once. Placement is still global, so a multi-zone part receives the SAME artwork on each
    // zone. Per-zone artwork is the artwork-instance work (state.artworks already models it).
    const mappers = zoneMappersFor(part, parts, isRect, wasm);

    if (!part.zones) {
      // Flat-path assumption only: a conformal zone's face legitimately points sideways (the
      // chair's side panels face ±X), which is what the baked chart exists to handle.
      const nrm = mappers[0].faceNormal;
      if (nrm && Math.abs(nrm[1]) < 0.9) {
        warnBuild(
          `Part "${part.name}": detected face normal (${nrm.map((v) => v.toFixed(2)).join(', ')}) isn't vertical. Assembly cutting assumes a horizontal face. Pick a different face or the cut may be wrong.`,
        );
      }
    }
    if (mappers.length && !part.isDuplicateOf && !viewSignSet) {
      viewSign = mappers[0].nsign;
      viewSignSet = true;
    }

    const { output, placed } = await buildPart(ctx, tally, part, mappers, progress);
    if (placed) anyPlacements = true;
    if (output) partOutputs.push(output);
    finishPart();
  }
  const {
    edgeCutColors,
    zeroDepthRaises,
    tooDeepClamps,
    thinWallClamps,
    colorAppliedDepth,
    landedColors,
    hiddenColors,
    coveredColors,
    exposedColors,
  } = tally;
  // Build-wide, unlike the edge notice: these describe the typed setting, which a part failing its
  // booleans doesn't make untrue.
  for (const r of zeroDepthRaises.values())
    warnBuild(zeroDepthWarning(r.labels, r.requested, r.raisedTo));
  for (const c of tooDeepClamps.values())
    warnBuild(tooDeepWarning(c.labels, c.partName, c.requested, c.cutAt));
  for (const c of thinWallClamps.values())
    warnBuild(thinWallWarning(c.labels, c.partName, c.requested, c.cutAt, c.wall!));
  // Once: each color the edge rule cut through, by depth (one today, per-part in the model).
  const byEdgeDepth = new Map<number, string[]>();
  for (const [label, depth] of edgeCutColors) {
    const at = byEdgeDepth.get(depth);
    if (at) at.push(label);
    else byEdgeDepth.set(depth, [label]);
  }
  for (const [depth, labels] of byEdgeDepth) noticeBuild(edgeCutThroughNotice(labels, depth));
  // Gated on anyPlacements so a build with no design surfaces at all doesn't call every color
  // missing. See BuildTally.landedColors for what counts as landed.
  if (anyPlacements) {
    const labelsOf = (want: (ci: number) => boolean): string[] =>
      palette
        .map((c, ci) =>
          landedColors.has(ci) || !want(ci)
            ? null
            : regionLabel(c.hex, c.isMerge, c.members.length),
        )
        .filter((l): l is string => l !== null);
    // Two causes, two remedies, so they are never merged into one count. A color the design put
    // only on surface the assembly covers is not off the part and Scale will not bring it back.
    const hidden = labelsOf((ci) => hiddenColors.has(ci));
    const off = labelsOf((ci) => !hiddenColors.has(ci));
    /**
     * Singular or plural form of a dropped-colors message, owning every quote (four hand copies
     * drifted on a full stop). The sentences stay whole in the callers: check-troubleshooting.mjs
     * finds each doc quote inside a shipped string, which a stitched message is not.
     */
    const missedWarning = (
      labels: string[],
      one: (label: string) => string,
      many: (count: number, list: string) => string,
    ): string =>
      labels.length === 1
        ? one(`"${labels[0]}"`)
        : many(labels.length, labels.map((l) => `"${l}"`).join(', '));
    if (off.length)
      warnBuild(
        missedWarning(
          off,
          (l) =>
            `${l} lands entirely off the part and won't print. ` +
            `Lower Scale or move the design to bring it back.`,
          (n, list) =>
            `${n} colors land entirely off the part and won't print: ` +
            `${list}. Lower Scale or move the design to bring them back.`,
        ),
      );
    // "only reaches surface that is hidden", not "lands only where hidden": a design mostly off the
    // part grazing one dead patch lands here too. No visible surface took it; some hidden did.
    if (hidden.length)
      warnBuild(
        missedWarning(
          hidden,
          (l) =>
            `${l} only reaches surface that's hidden once assembled and won't print. ` +
            `Move it off the hatching to bring it back.`,
          (n, list) =>
            `${n} colors only reach surface that's hidden once assembled and won't print: ` +
            `${list}. Move them off the hatching to bring them back.`,
        ),
      );
  }
  // Not gated on landedColors: the boundary clip already counted these as landed, which is true,
  // and is why nothing else would say where they went.
  for (const ci of coveredColors)
    if (!exposedColors.has(ci))
      noticeBuild(
        fillCoveredNotice(
          regionLabel(palette[ci].hex, palette[ci].isMerge, palette[ci].members.length),
        ),
      );
  palette.forEach((c, ci) => {
    const d = colorAppliedDepth.get(ci);
    if (d != null) c.appliedDepth = d;
  });
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
