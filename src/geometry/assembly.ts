import * as THREE from 'three';
import type { Position } from 'geojson';
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
import { faceXZBBox, OVERSHOOT_MM, type DesignPlacement, type ZoneMapper } from './zones';
import { zoneMappersFor } from './zoneMappers';
import { FILL_REFINE_MM, FILL_SNAP_MM } from './conformal';
import {
  MAX_FILL_TILES,
  tileCoverage,
  tileFeature,
  type TileCell,
  type TileGrid,
} from './patterns';
import { notice, warn } from '../warnings';
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
 * Vector + mesh-boolean assembly build. For each part: take the SVG's real per-color net
 * regions, place them onto the part's flat face in the part's own native coordinates, extrude
 * each to a prism, then use Manifold to (a) subtract all prisms from the real part mesh -> the
 * FULL modified body, and (b) intersect each prism with the part -> a flush inlay solid per
 * color.
 */
export async function buildAssemblyGeometry(
  input: AssemblyBuildInput,
): Promise<AssemblyBuild | null> {
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

  // Design anchor, per artwork: the SVG's largest <circle> when there is one (the design's
  // intended outer boundary), otherwise a pseudo-circle around the artwork's bounding box —
  // centered on the artwork, radius = half its larger dimension — so circle-less SVGs still
  // auto-center on the hub and span the design diameter instead of refusing to build. Rect parts
  // always anchor on the artwork bbox center (a template circle is meaningless there) and skip
  // the wheel notice.
  const anchorOf = (parsed: ParsedSVG): { cx: number; cy: number; r: number } => {
    const existing = isRect ? null : parsed.rawSVGCircle;
    if (existing) return existing;
    const bbox = parsed.bbox;
    if (!isRect)
      notice(
        'This SVG has no <circle> marking the design boundary — the artwork was auto-centered on the hub using its bounding box. Use Design radius / Scale / Offset to adjust the fit.',
      );
    return {
      cx: (bbox.minX + bbox.maxX) / 2,
      cy: (bbox.minY + bbox.maxY) / 2,
      r: Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY) / 2 || 1,
    };
  };

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

  // Only a *loaded* part has a face to measure. A part still fetching from the library would
  // otherwise leave designFace null, drop us to the 1:1 branch, and report a size the rebuild its
  // own load triggers immediately contradicts — so when nothing is loaded yet, say nothing
  // (there's no geometry to place either; the per-part loop below skips it). Computed on demand:
  // only a rect SVG with no declared mm size needs it, so the wheel path never pays for it.
  let designFaceMemo: { w: number; h: number } | null | undefined;
  const largestDesignFace = (): { w: number; h: number } | null => {
    if (designFaceMemo !== undefined) return designFaceMemo;
    let found: { w: number; h: number } | null = null;
    for (const p of parts) {
      if (!p.loaded) continue;
      const bb = faceXZBBox(p.boundaryLoop);
      if (bb && bb.w > 0 && bb.h > 0 && (!found || bb.w * bb.h > found.w * found.h))
        found = { w: bb.w, h: bb.h };
    }
    return (designFaceMemo = found);
  };

  // Wheel: SVG circle radius maps to the mm Design radius. Rect: convert SVG units to mm via the
  // file's declared physical size (userUnitMM) so a template lands life-size even if an editor
  // re-exported it at a different internal resolution.
  //
  // When a rect SVG declares no absolute mm size, fit its viewBox to the design face rather than
  // assuming 1 unit = 1 mm. The template's viewBox *is* the face, so any template trace then lands
  // life-size at Scale 100% even when the editor dropped the physical size (e.g. Affinity exports
  // `width="100%"` and rescales the viewBox to its own resolution). Meet-fit (the smaller axis
  // ratio) matches SVG's default fitting. Genuine 1:1 fallback only when there's no viewBox either.
  // `forceRect` is the fill path: a tile's size is a real-world period, so it maps in mm on every
  // kind — the wheel's radius-driven scaling would stretch one period across the whole design.
  const mmPerUnitOf = (
    parsed: ParsedSVG,
    scaleMult: number,
    anchorR: number,
    forceRect = false,
  ): number => {
    if (!isRect && !forceRect) return (radius / anchorR) * scaleMult;
    if (parsed.userUnitMM != null) return parsed.userUnitMM * scaleMult;
    const vb = parsed.viewBox;
    const designFace = largestDesignFace();
    if (designFace && vb && vb.w > 0 && vb.h > 0) {
      notice(
        'This SVG has no absolute width/height in mm, so it was auto-fit to the part face. Set the document size in millimeters for an exact size, or use Scale to fine-tune.',
      );
      return Math.min(designFace.w / vb.w, designFace.h / vb.h) * scaleMult;
    }
    if (designFace)
      notice(
        'This SVG has no absolute width/height in mm, so its true print size is unknown — placing it 1:1 with its coordinate units. Set the document size in millimeters, or use Scale to correct the fit.',
      );
    return scaleMult;
  };

  let wasm;
  try {
    wasm = await getManifold();
  } catch (e) {
    warn(
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
        warn(
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
      if (boundaryPoly) {
        feat = safeIntersect(feat, boundaryPoly, `color ${c.hex} on ${part.name}`);
        if (!feat) return;
      }
      const depthSetting = (colorSettings[c.key] && colorSettings[c.key].depth) || globalDepth;
      if (depthSetting <= 0) return;
      const depth = mapper.resolveCutDepth(depthSetting);
      const cutterOpts = grid ? { refineMM: FILL_REFINE_MM, snapMM: FILL_SNAP_MM } : undefined;
      const soup = mapper.buildCutter(feat, depth, OVERSHOOT_MM, cutterOpts);
      if (!soup || !soup.length) {
        // The artwork overlapped this zone (it survived the boundary clip) but no cutter came out.
        // On a conformal zone that means the warp found no surface under part of the region —
        // usually a baked boundary claiming more area than the chart actually covers; on a flat
        // one, a region too degenerate to extrude. Same user-facing outcome as a cutter that
        // fails to become a solid below, so it shares that message (warnings dedupe by text);
        // staying silent would drop the color from the part with no explanation at all.
        warn(`Couldn't build the cut solid for color ${c.hex} on "${part.name}".`);
        return;
      }
      try {
        const man = soupToManifold(wasm, soup);
        if (!manifoldIsValid(man)) throw new Error('empty manifold');
        (colorPrisms[ci] ||= []).push(man);
        return;
      } catch {
        /* retry below with self-intersections repaired */
      }
      // Clipping dense/overlapping line-work to the part boundary can leave the region
      // self-touching in a way turf doesn't flag as invalid but Manifold rejects as non-watertight
      // — repair it with Manifold's own 2D boolean engine and retry once before giving up.
      try {
        const repaired = repairSelfIntersections(wasm, feat);
        const soup2 = repaired && mapper.buildCutter(repaired, depth, OVERSHOOT_MM, cutterOpts);
        if (soup2 && soup2.length) {
          const man2 = soupToManifold(wasm, soup2);
          if (manifoldIsValid(man2)) {
            (colorPrisms[ci] ||= []).push(man2);
            return;
          }
        }
      } catch {
        /* fall through to warn */
      }
      warn(`Couldn't build the cut solid for color ${c.hex} on "${part.name}".`);
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
            warn(
              `Couldn't measure the fill area on "${part.name}" — placing a single copy of the artwork instead.`,
            );
          } else {
            grid = tileCoverage(place, tileCells[ai], extent);
            if (!grid)
              warn(
                `Filling "${part.name}" would take more than ${MAX_FILL_TILES} tiles at this scale — placing a single copy instead. Raise Scale to fill the surface.`,
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
        merged = list.length === 1 ? list[0] : Manifold.union(list);
      } catch {
        // This color's cutters (from different zones of the same part) couldn't be merged —
        // drop just this color rather than losing the whole part's cut.
        warn(`Couldn't combine the cut solids for color ${palette[+ci].hex} on "${part.name}".`);
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
      warn(`Part "${part.name}" mesh couldn't be read by the boolean engine.`);
      owned.forEach(manifoldDelete);
      finishPart();
      continue;
    }
    if (!manifoldIsValid(partMan)) {
      warn(
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
      cutter = prismList.length === 1 ? prismList[0] : Manifold.union(prismList);
    } catch {
      // Nothing to cut with — same escape as the non-watertight branch above: export the
      // untouched body rather than risk a half-cut/half-inlaid pair that would overlap.
      warn(`Couldn't combine this part's cut solids on "${part.name}" — exporting it uncut.`);
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
    try {
      const body = Manifold.difference(partMan, cutter);
      const meshes = manifoldToMeshes(body);
      bodySoup = meshes.soup;
      bodyIndexed = meshes.indexed;
      manifoldDelete(body);
    } catch {
      bodyCutFailed = true;
      bodySoup = Float32Array.from(part.positions);
    }
    await maybeYield();

    if (bodyCutFailed) {
      // The body and its inlays come from the same boolean pass — if the cut itself failed,
      // building inlays anyway would ship a solid uncut body plus inlay solids occupying the
      // same volume, which a slicer resolves arbitrarily. Export uncut and inlay-less instead.
      warn(
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
      try {
        const inl = Manifold.intersection(partMan, prism);
        const { soup, indexed } = manifoldToMeshes(inl);
        if (soup.length) {
          inlaySoups[ci] = soup;
          inlayIndexed[ci] = indexed;
        }
        manifoldDelete(inl);
      } catch {
        warn(`Couldn't fit the inlay for a color on "${part.name}".`);
      }
      await maybeYield();
    }

    owned.forEach(manifoldDelete);
    manifoldDelete(partMan);

    partOutputs.push({ part, bodySoup, inlaySoups, bodyIndexed, inlayIndexed });
    finishPart();
  }
  return { partOutputs, palette, viewSign, detectedColors, baseAssigned };
}
