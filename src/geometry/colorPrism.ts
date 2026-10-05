import type { AssemblyPart, PolyFeature } from '../types';
import {
  fillYieldFailedWarning,
  mirrorClipFailedWarning,
  mirrorHalfNotice,
  netShareFailedWarning,
  netShareNotice,
  raiseTornWarning,
  speckKey,
  unprintableSpeckNotice,
} from './assemblyWarnings';
import type { BuildContext, BuildTally, ColorMark } from './buildContext';
import { FILL_REFINE_MM } from './conformal';
import {
  CLIP_REMNANT_FLOOR_MM2,
  depthDiffers,
  MIN_CUT_DEPTH_MM,
  regionLabel,
  requestedDepth,
  subLayerDepth,
  thinDepthNotice,
} from './depth';
import { clipToKeptSide, clipToNetShare, type KeptHalf } from './designClip';
import {
  manifoldDelete,
  manifoldIsValid,
  mapFeatureCoords,
  noteEngineError,
  REPAIR_ERODE_MM,
  repairSelfIntersections,
  soupToManifold,
  type ManifoldSolid,
} from './manifold';
import {
  differenceAllChecked,
  dropUnprintableRemnants,
  intersectQuiet,
  safeIntersectChecked,
} from './regions';
import { OVERSHOOT_MM, type CutRegion, type NetExclusion, type ZoneMapper } from './zones';
import { noticeBuild, warnBuild } from '../warnings';

/** One part's cut in progress: the cutters staged per color, and every solid it must free. */
export interface PartCut {
  part: AssemblyPart;
  held: Set<ManifoldSolid>;
  colorPrisms: Record<number, ManifoldSolid[]>;
  partEdgeColors: Map<string, number>;
}

/** The zone a design is being cut onto. */
export interface ZoneTarget {
  mapper: ZoneMapper;
  boundaryPoly: PolyFeature | null;
  zoneName: string;
}

/** One design placed on that zone, with every clip it takes. `fills` is null unless it tiled. */
export interface DesignOnZone {
  ai: number;
  place: (pt: number[]) => number[];
  half: KeptHalf | null;
  netExcl: NetExclusion[];
  fills: (PolyFeature | null)[] | null;
  under: PolyFeature[];
}

/**
 * The one place a color is attributed to hidden surface: its placed region (tiles and all)
 * reached only this zone's dead surface. Dead surface is baked inside the chart's claim, so an
 * overlap proves the pre-clip boundary would have admitted it. intersectQuiet, not safeIntersect
 * (returns UNCLIPPED, an overlap for every color) nor the checked variant (warns about an
 * intersect that shaped nothing). A flake takes the off-part message.
 */
function noteHiddenSurface(
  hiddenColors: ColorMark,
  mapper: ZoneMapper,
  placed: PolyFeature | null,
  ci: number,
): void {
  const dead = mapper.deadArea();
  if (!placed || !dead) return;
  if (intersectQuiet(placed, dead)) hiddenColors.add(ci);
}

/**
 * Drop specks too small to print, notice once per colour and part across all three clips, and
 * mark the colour landed — together, so no colour gets both the speck notice and "lands entirely
 * off the part" (whose lower-Scale remedy is backwards for a design already too small).
 */
function dropSpecks(
  landedColors: ColorMark,
  feat: PolyFeature | null,
  ci: number,
  part: AssemblyPart,
  c: { hex: string; isMerge: boolean; members: unknown[] },
): PolyFeature | null {
  const r = dropUnprintableRemnants(feat, CLIP_REMNANT_FLOOR_MM2);
  if (!r.dropped) return r.feat;
  noticeBuild(
    unprintableSpeckNotice(regionLabel(c.hex, c.isMerge, c.members.length), part.name),
    speckKey(ci, part.id),
  );
  // The color DID reach this face; what it left could not print.
  landedColors.add(ci);
  return r.feat;
}

/**
 * One color of one design on one zone: clipped, its depth resolved, and its cutters staged in
 * `cut.colorPrisms`. Each early `return` skips this color only.
 */
export async function buildColorPrism(
  ctx: BuildContext,
  tally: BuildTally,
  cut: PartCut,
  zone: ZoneTarget,
  onZone: DesignOnZone,
  ci: number,
): Promise<void> {
  const { artworks, featuresByColor, colorSettings, globalDepth, wasm } = ctx;
  const {
    tornPills,
    zeroDepthRaises,
    tooDeepClamps,
    thinWallClamps,
    colorAppliedDepth,
    landedColors,
    hiddenColors,
    coveredColors,
    exposedColors,
  } = tally;
  const { part, held, colorPrisms, partEdgeColors } = cut;
  const { mapper, boundaryPoly, zoneName } = zone;
  const { ai, place, half, netExcl, fills, under } = onZone;
  const c = ctx.palette[ci];
  const tiled = fills ? fills[ci] : featuresByColor[ci][ai];
  if (!tiled) return;
  let feat: PolyFeature | null = mapFeatureCoords(tiled, place);
  // On a clipper failure safeIntersect returns the region *unclipped*, which the edge rule
  // reads as all-edge and cuts clean through instead of recessed. Tracked, not assumed.
  let clipped = true;
  if (boundaryPoly) {
    const placed = feat;
    // An all-hidden chart (empty MultiPolygon boundary) comes back empty here, no branch
    // needed. A pre-tiling skip would save a fill's union pass but attributed off the UNTILED
    // source; restore it only for a bake that fails tests/chair-zones.test.ts ("no shipped
    // chart is hidden outright").
    const r = safeIntersectChecked(feat, boundaryPoly, `color ${c.hex} on ${part.name}`);
    feat = r.feat;
    clipped = r.clipped;
    // Before the speck floor: a clip returning nothing is hidden surface, with its own
    // remedy, not ink too small to print.
    if (!feat) {
      noteHiddenSurface(hiddenColors, mapper, placed, ci);
      return;
    }
    // The dead region on a chart is baked to share that chart's own outline, which is where
    // this clip leaves a hairline rather than nothing. See dropUnprintableRemnants.
    feat = dropSpecks(landedColors, feat, ci, part, c);
    if (!feat) return;
    // Only a real clip proves the color reached this face; a cut-through zone counts it when
    // its boolean yields an inlay, below.
    landedColors.add(ci);
  }
  // After the boundary clip, so what the notice reports lost is surface this part cuts.
  // The color counts as landed either way: what this takes off is cut by the reflection.
  // Said from the un-reflected input only, or the pair reports both halves as the one kept.
  if (half) {
    const r = clipToKeptSide(feat, half);
    const design = artworks[ai].name || 'design';
    if (r.failed) warnBuild(mirrorClipFailedWarning(design, half.zoneName));
    else if (r.removed && !artworks[ai].reflected)
      noticeBuild(mirrorHalfNotice(design, half.zoneName, half.side));
    // Same boundaries, same failure: the kept-side clip runs along the zone's own centre line.
    feat = dropSpecks(landedColors, r.feat, ci, part, c);
    if (!feat) return;
  }
  // A whole-part design is cut only where the net says this zone owns the canvas, or a mark
  // where sheets overlap cuts on both. Nothing is lost (the owner cuts it; a per-zone binding
  // still reaches it), so this is a notice. Decided 2026-09-05: overlap left in measured
  // 8,730 and 8,226mm² of doubled canvas on the chair, where designs centre. The flanks yield
  // 8,668 and 8,158mm²: a sheet only yields canvas the sheet taking it can chart.
  if (netExcl.length) {
    const r = clipToNetShare(feat, netExcl);
    const design = artworks[ai].name || 'design';
    // Both: a zone can yield to two neighbours (the chair's back to each flank), failing on
    // one patch and moving ink on another.
    if (r.failed) warnBuild(netShareFailedWarning(design, zoneName));
    if (r.movedTo.length) noticeBuild(netShareNotice(design, zoneName, r.movedTo));
    // A separate fact: the move is right, the halves won't line up. One pill per boundary.
    for (const t of r.torn) raiseTornWarning(tornPills, design, [zoneName, t.toName], t.tearMm);
    // The net partition is cut from the same charts, so its patch boundaries coincide with
    // this zone's claim in exactly the way that leaves a hairline.
    feat = dropSpecks(landedColors, r.feat, ci, part, c);
    if (!feat) return;
  }
  // A fill is background, so it yields to every sticker on the zone, or differing colors
  // export two inlays in one volume. One sweep per color and part: 0.3-0.6s of a wheel build
  // (`yield ms`, scripts/bench-fill-yield.ts). Chair unmeasured.
  if (under.length) {
    const r = differenceAllChecked(feat, under);
    if (!r.trimmed)
      warnBuild(
        fillYieldFailedWarning(
          regionLabel(c.hex, c.isMerge, c.members.length),
          artworks[ai].name || 'design',
          part.name,
        ),
      );
    if (!r.feat) {
      // Landed for a cut-through part too, which has no clip to have said so: the color is
      // under a sticker, not off the part, and the off-part warning's remedy would be wrong.
      landedColors.add(ci);
      coveredColors.add(ci);
      return;
    }
    // A sticker edge crossing a stripe leaves a tip often under the speck floor (0.12mm² in
    // tests/fill-yield.test.ts). Unfloored with no boundary: that region still reaches off
    // the part. Exposed before the floor: a color left only a speck still reached this face.
    exposedColors.add(ci);
    feat = boundaryPoly ? dropSpecks(landedColors, r.feat, ci, part, c) : r.feat;
    if (!feat) return;
  }
  exposedColors.add(ci);
  const requested = requestedDepth(colorSettings, globalDepth, c.key);
  // A depth at or below zero cuts nothing and used to drop the color and its depth field
  // silently; raised so it stays fixable. The message names the *setting*, not the cut (a cut
  // depth claimed 0.02 mm on a 3 mm through-cut), and no part, so a wheel says it once.
  const raised = requested <= 0 ? MIN_CUT_DEPTH_MM : requested;
  // Bounded by how far the part extends behind its face (unbounded, 20 mm and 9999 mm both
  // exported unwarned on the wheel); resolveCutRegions also bounds each region by its wall.
  const depthSetting = Math.min(raised, mapper.maxCutDepth());
  const label = regionLabel(c.hex, c.isMerge, c.members.length);
  // One entry per depth, usually one. An edge rule (a hubcap cut to its artwork's shape)
  // splits off full-thickness polygons on the outer wall; the mapper decides, this extrudes.
  const regions = mapper.resolveCutRegions(feat, depthSetting, {
    label: `color ${label}`,
    clipped,
  });
  // Whether any slice landed at depthSetting, not a substituted depth (cut-through hole, edge
  // slice). Shared by the colour-list depth, too-deep pill and thin-depth note so they cannot
  // disagree; `some`, because a split color cuts at two depths at once.
  const landedAtSetting = regions.some((r) => !depthDiffers(r.depth, depthSetting));
  // A slice the wall under it cut shallower is still the setting, bounded, so the colour list
  // shows it the same way it shows the part bound.
  const wallCuts = regions.filter((r) => r.wall != null);
  const wallDepths = wallCuts.map((r) => r.depth);
  // The colour list's display-only Depth (docs/tech-debt.md), gated the same way so a
  // cutThrough or all-edge part never reports a recess it did not cut. Minimum across
  // parts/zones, so two depths show the more-clamped one, not whichever ran last.
  if (landedAtSetting || wallDepths.length) {
    const cut = Math.min(landedAtSetting ? depthSetting : Infinity, ...wallDepths);
    colorAppliedDepth.fold(ci, cut);
  }
  for (const r of wallCuts) thinWallClamps.add(label, part.name, raised, r.depth, r.wall);
  if (requested <= 0) zeroDepthRaises.add(label, requested, depthSetting);
  // Gated on what the mapper did, like the sub-layer note: a cutThrough part holes the whole
  // way, so "cut at 24.25 mm instead" would be false. Never test `part.cutThrough` here.
  // Rotated copies report too: same bound (asmAddDuplicate shares mesh, face, topZ) but a
  // different slice, so skipping them left a copy-only color's "cut at" depth unnamed.
  // addPartTooDeepClamp groups colors sharing a setting to one pill per half; per-color
  // overrides still split.
  else if (depthDiffers(depthSetting, raised) && landedAtSetting)
    tooDeepClamps.add(label, part.name, raised, depthSetting);
  // This one predicts the printed recess, so not on a part that cuts through ("too thin to
  // show up" is wrong about a 3 mm hole); ask the mapper, never `part.cutThrough`. Per-part
  // gating is right since warnings dedupe: said if any part cuts at the setting. A notice:
  // the depth is honored (see thinDepthNotice in depth.ts).
  else if (subLayerDepth(depthSetting) && landedAtSetting)
    noticeBuild(thinDepthNotice(label, depthSetting));
  // Only the refinement differs for a fill (a zone-wide cutter would explode at the sticker
  // step); the snap tolerance is a property of the bake, so both modes take the same one.
  const cutterOpts = fills ? { refineMM: FILL_REFINE_MM } : undefined;
  // Each slice is its own prism in colorPrisms[ci]; the union below welds them per color.
  // Edge colors stage per *part* and merge only once it emits inlays, so "the rim prints in
  // that color" can't outlive a later failure that exports it uncut.
  const keep = (man: ManifoldSolid, region: CutRegion): void => {
    held.add(man);
    (colorPrisms[ci] ||= []).push(man);
    if (region.edge) partEdgeColors.set(label, region.depth);
  };
  // Null for "no solid", whichever step failed: a flat mapper hands back a prism that will
  // not seal, while a conformal one tests its own prism before warping and returns null
  // instead. Both mean the same thing to the repair below, so both reach it.
  const solidFor = (feat: PolyFeature | null, depth: number): ManifoldSolid | null => {
    const soup = feat && mapper.buildCutter(feat, depth, OVERSHOOT_MM, cutterOpts);
    if (!soup || !soup.length) return null;
    const man = soupToManifold(wasm, soup);
    if (manifoldIsValid(man)) return man;
    // Freed: an un-watertight soup comes back as an *empty* solid, not a throw, so this is
    // the common path, and it never reaches `held`. The ladder can discard one per rung.
    manifoldDelete(man);
    return null;
  };
  for (const region of regions) {
    let man: ManifoldSolid | null = null;
    try {
      man = solidFor(region.feat, region.depth);
    } catch (e) {
      noteEngineError(e); // then retry below with self-intersections repaired
    }
    // Clipped dense line-work can self-touch: valid to turf, not watertight to Manifold.
    // Repair with Manifold's 2D booleans and retry, widening the erode: a gravel photo on the
    // wheel put eleven regions here and one needed the wider rung. Smallest first, so a
    // region repairing at 0.01mm pays no extra loss. An edge slice gets only the narrowest:
    // eroding pulls it off the rim `keep` promises it prints on, leaving a rind of body.
    const rungs = region.edge ? REPAIR_ERODE_MM.slice(0, 1) : REPAIR_ERODE_MM;
    // No notice on a wider rung: an inward offset of `e` removes only what is thinner than
    // `2e`, so 0.05mm touches nothing over a quarter of a 0.4mm nozzle. (A notice's test was
    // always true, erode being monotone.) docs/findings/2026-08-20-extrude-repair-erode.md.
    for (const erodeMm of rungs) {
      if (man) break;
      try {
        man = solidFor(repairSelfIntersections(wasm, region.feat, erodeMm), region.depth);
      } catch (e) {
        noteEngineError(e); // then try the next distance, and warn
      }
    }
    if (man) {
      keep(man, region);
      continue;
    }
    // Survived the clip, but no cutter came out, repaired or not: too degenerate to extrude,
    // or a conformal warp with no surface under it (usually a baked boundary over-claiming).
    // `continue`, so a color split across two depths keeps the slice that did extrude.
    landedColors.add(ci);
    warnBuild(`Couldn't cut color ${c.hex} into "${part.name}".`);
  }
}
