import type { AssemblyPartOutput, IndexedMesh, PolyFeature } from '../types';
import {
  FILL_FELL_BACK_TO_ONE_TILE,
  fillRefusalMessage,
  mirrorClipFailedWarning,
  warnOverlappingDesigns,
} from './assemblyWarnings';
import type { BuildContext, BuildTally, CuttablePart, PartProgress } from './buildContext';
import { buildColorPrism, type DesignOnZone, type PartCut } from './colorPrism';
import { csgFault } from './csgFault';
import { keptHalfFor, placedBBoxQuad, placedInk, placedInkFeatures } from './designClip';
import {
  manifoldDelete,
  manifoldIsValid,
  manifoldToMeshes,
  noteEngineError,
  soupToManifold,
  type ManifoldSolid,
} from './manifold';
import {
  featureVertexCount,
  tileCoverage,
  tileFeature,
  type TileGrid,
  type TileRefusalReport,
} from './patterns';
import { fitsBesideClips, roomBesideClips, UnionTooBig } from './regions';
import type { ZoneMapper } from './zones';
import { dropBuildWarningsSince, warnBuild, warningMark } from '../warnings';
import { throwIfCancelled } from '../cancel';

/**
 * One part's cut: every design on every zone it offers extruded into per-color cutters, then the
 * body/inlay booleans. `output` is null only for a part whose mesh couldn't be read; `placed`
 * says whether any of its zones took a design.
 */
export async function buildPart(
  ctx: BuildContext,
  tally: BuildTally,
  part: CuttablePart,
  mappers: ZoneMapper[],
  progress: PartProgress,
): Promise<{ output: AssemblyPartOutput | null; placed: boolean }> {
  const {
    artworks,
    palette,
    featuresByColor,
    placements,
    maxScalePlacement,
    tileCells,
    tileVerts,
    wasm,
  } = ctx;
  const { Manifold } = wasm;
  const { overlapCheckedZones, landedColors, edgeCutColors } = tally;
  const { reportPartProgress, maybeYield } = progress;
  // Every Manifold solid this part allocates, freed by the finally below. A Set because steps
  // hand the same handle on; freeing per branch leaked WASM on each mid-cut cancel, so this is
  // what lets throwIfCancelled sit anywhere.
  const held = new Set<ManifoldSolid>();
  try {
    // A color can be cut on several zones of one part, so each collects a list of solids that is
    // unioned before the body/inlay booleans.
    const colorPrisms: Record<number, ManifoldSolid[]> = {};
    // Staged edge-rule colors, merged into edgeCutColors only where the part succeeds (see `keep`).
    const partEdgeColors = new Map<string, number>();
    const cut: PartCut = { part, held, colorPrisms, partEdgeColors };
    // Artworks landing on a zone: those bound to it by id, plus any unbound one. Unbound is the
    // single-zone case (wheel, footrest), which goes wherever the part offers.
    const artworksOn = (mapper: ZoneMapper): number[] =>
      artworks.flatMap((a, ai) => (a.zoneId == null || a.zoneId === mapper.zoneId ? [ai] : []));

    // +1 reserved for the body/inlay CSG stage below, so progress reaches 1 only once every color
    // on every zone plus the final cuts are done.
    const zoneWork = mappers.map(artworksOn);
    // A fill's colors take two units each, one to tile and one to cut.
    const partUnits =
      palette.length *
        zoneWork.reduce(
          (s, l) => s + l.reduce((n, ai) => n + (artworks[ai].mode === 'fill' ? 2 : 1), 0),
          0,
        ) +
      1;
    let unitsDone = 0;
    const placed = zoneWork.some((l) => l.length > 0);
    for (let zi = 0; zi < mappers.length; zi++) {
      const mapper = mappers[zi];
      if (!zoneWork[zi].length) continue;
      const zoneName =
        part.zones?.find((z) => z.id === mapper.zoneId)?.name ?? mapper.zoneId ?? part.name;
      if (zoneWork[zi].length > 1 && !overlapCheckedZones.has(mapper.zoneId ?? '')) {
        warnOverlappingDesigns(
          zoneWork[zi].map((ai) => {
            const place = mapper.placer(placements[ai]);
            const half = keptHalfFor(mapper, artworks[ai], place, zoneName);
            const excl = artworks[ai].netBound ? mapper.netExcluded() : [];
            return {
              name: artworks[ai].name || 'design',
              quad: placedBBoxQuad(artworks[ai].parsed, place, half),
              fill: artworks[ai].mode === 'fill',
              ink: () => placedInk(featuresByColor, ai, place, half, excl),
              group: artworks[ai].mirrorPair,
            };
          }),
        );
        // Marked only where the check actually ran, so a part that happens to carry one design
        // can't suppress the zone's warning for the parts that carry both.
        overlapCheckedZones.add(mapper.zoneId ?? '');
      }
      const boundaryPoly = mapper.boundary();
      // What every fill on this zone yields to: each sticker's ink, placed as it is cut. Only
      // built when a fill shares the zone with one. A fill never yields to another fill; that
      // pairing is warned instead (warnOverlappingDesigns).
      const stickersHere = zoneWork[zi].filter((ai) => artworks[ai].mode !== 'fill');
      const fillHere = zoneWork[zi].some((ai) => artworks[ai].mode === 'fill');
      const under =
        stickersHere.length && fillHere
          ? stickersHere.flatMap((ai) => {
              const place = mapper.placer(placements[ai]);
              return placedInkFeatures(
                featuresByColor,
                ai,
                place,
                keptHalfFor(mapper, artworks[ai], place, zoneName),
                artworks[ai].netBound ? mapper.netExcluded() : [],
              );
            })
          : [];
      for (const ai of zoneWork[zi]) {
        const place = mapper.placer(placements[ai]);
        const half = keptHalfFor(mapper, artworks[ai], place, zoneName);
        const netExcl = artworks[ai].netBound ? mapper.netExcluded() : [];
        // A zone with no centre to clip at cuts the design and its reflection whole. Degenerate
        // (a chart with no extent), and still a doubled cut nobody asked for, so it is named.
        if (artworks[ai].keepSide && !half)
          warnBuild(mirrorClipFailedWarning(artworks[ai].name || 'design', zoneName));
        // One grid per (zone, artwork): every color repeats identically. An untileable fill
        // degrades to one copy plus a warning, not an empty part.
        const fill = artworks[ai].mode === 'fill';
        const extent = fill ? mapper.fillExtent() : null;
        // Named per design: both remedies reach only the ACTIVE design and warnings dedupe on the
        // string, so two designs failing alike would be one pill naming neither. Two placements
        // of the SAME design still collapse (that needs warnOverlappingDesigns's counted
        // phrasing). `fits`: would the max-Scale grid clear the limit that refused? Asked of the
        // same refusal path, so the remedy can't drift from how a grid is laid.
        const refuseFill = (
          refusal: TileRefusalReport,
          fits: (maxGrid: TileGrid) => boolean = () => true,
        ): void => {
          const maxGrid =
            extent &&
            tileCoverage(
              mapper.placer(maxScalePlacement(ai)),
              tileCells[ai],
              extent,
              tileVerts[ai],
            );
          warnBuild(
            fillRefusalMessage(
              artworks[ai].name || 'design',
              part.name,
              refusal.reason,
              refusal.detail && { ...refusal.detail, scalable: !!maxGrid && fits(maxGrid) },
            ),
          );
        };
        let grid: TileGrid | null = null;
        if (fill && !extent) {
          warnBuild(
            `Couldn't measure the area to fill on "${part.name}", so "${artworks[ai].name || 'design'}" ` +
              `can't be tiled across it. ${FILL_FELL_BACK_TO_ONE_TILE} Please report this.`,
          );
        } else if (extent) {
          const refusal: TileRefusalReport = {};
          grid = tileCoverage(place, tileCells[ai], extent, tileVerts[ai], refusal);
          if (!grid) refuseFill(refusal);
        }
        // Every color tiles before any is cut: one untileable color sends the whole design back
        // to one copy, and partial tiling lands colors out of register. Tiled *in SVG space*, so
        // tiles inherit placement and seam-straddling copies overlap where the union welds them.
        const unitsBefore = unitsDone;
        // Every call ahead takes the whole of one color's fill beside one of these: the face, the
        // kept half, each patch another zone owns, and every sticker it gives way to at once.
        const clipSets: PolyFeature[][] = [
          boundaryPoly ? [boundaryPoly] : [],
          half ? [half.clip] : [],
          ...netExcl.flatMap((e) => (e.region ? [[e.region]] : [])),
          under,
        ];
        const warnedBefore = warningMark();
        let fills: (PolyFeature | null)[] | null = null;
        let tiling = -1;
        if (grid) {
          try {
            fills = [];
            for (let ci = 0; ci < palette.length; ci++) {
              tiling = ci;
              throwIfCancelled();
              const source = featuresByColor[ci][ai];
              const base = unitsDone;
              const tiled = source
                ? await tileFeature(
                    source,
                    grid,
                    (f) => reportPartProgress((base + f) / partUnits),
                    `color ${palette[ci].hex} on ${part.name}`,
                  )
                : null;
              // Those calls can split a fill between its polygons but never inside one.
              if (tiled && !clipSets.every((clips) => fitsBesideClips(tiled, clips)))
                throw new UnionTooBig();
              fills.push(tiled);
              reportPartProgress(++unitsDone / partUnits);
              await maybeYield();
            }
          } catch (e) {
            if (!(e instanceof UnionTooBig)) throw e;
            fills = null;
            // What tiling said about colors already tiled is about tiles now thrown away.
            dropBuildWarningsSince(warnedBefore);
            // The shape that joined can't be bigger than every tile's copy of its color, so a
            // grid whose copies fit is one where Scale is a real remedy. It has to be a smaller
            // grid as well: the engine's crossing limit can refuse copies that fit.
            const points = featureVertexCount(featuresByColor[tiling][ai]);
            const tiles = grid.count;
            refuseFill(
              { reason: 'joins-too-big', detail: { tiles, points } },
              (maxGrid) =>
                maxGrid.count < tiles &&
                clipSets.every((clips) => maxGrid.count * points <= roomBesideClips(clips)),
            );
          }
        }
        // A fill that never tiled still owes the progress its tiling units would have reported.
        if (fill && !fills) unitsDone = unitsBefore + palette.length;
        const design: DesignOnZone = {
          ai,
          place,
          half,
          netExcl,
          fills,
          under: artworks[ai].mode === 'fill' ? under : [],
        };
        for (let ci = 0; ci < palette.length; ci++) {
          // Per colour: per-part checks left cancel latency at 140.4s on a 6000-region wheel
          // (2026-08-24 cycle, T0-7). A colour is the finest unit where nothing is half-built.
          throwIfCancelled();
          await buildColorPrism(ctx, tally, cut, { mapper, boundaryPoly, zoneName }, design, ci);
          reportPartProgress(++unitsDone / partUnits);
          await maybeYield();
        }
      }
    }

    // Per color: the union of its cutters across every zone.
    const prismEntries: [number, ManifoldSolid][] = [];
    for (const [ci, list] of Object.entries(colorPrisms)) {
      // Past the cutter loop each step is one atomic Manifold call; this check and the next two
      // are the finest boundaries left, safe only because of the finally above.
      throwIfCancelled();
      let merged: ManifoldSolid;
      try {
        if (list.length === 1) {
          merged = list[0];
        } else {
          csgFault('color-union');
          merged = Manifold.union(list);
        }
      } catch (e) {
        noteEngineError(e);
        // This color's cutters (different zones, same part) couldn't be merged. Drop just this
        // color rather than losing the whole part's cut.
        landedColors.add(+ci);
        warnBuild(
          `Couldn't merge color ${palette[+ci].hex} on "${part.name}". It won't print there.`,
        );
        continue;
      }
      if (merged !== list[0]) held.add(merged);
      prismEntries.push([+ci, merged]);
    }
    if (!prismEntries.length) {
      // No cuts landed (or none survived the merge above): emit the untouched body so the
      // assembly still exports whole.
      return {
        output: { part, bodySoup: Float32Array.from(part.positions), inlaySoups: {} },
        placed,
      };
    }

    let partMan: ManifoldSolid;
    try {
      partMan = soupToManifold(wasm, part.positions);
      held.add(partMan);
    } catch (e) {
      noteEngineError(e);
      prismEntries.forEach(([pci]) => landedColors.add(pci));
      warnBuild(`Couldn't read "${part.name}", so it is not exported.`);
      return { output: null, placed };
    }
    if (!manifoldIsValid(partMan)) {
      prismEntries.forEach(([pci]) => landedColors.add(pci));
      warnBuild(
        `Part "${part.name}" isn't a watertight mesh, so it can't be cut cleanly. Repair it (close holes, fix flipped faces) and retry. Exporting it uncut for now.`,
      );
      return {
        output: { part, bodySoup: Float32Array.from(part.positions), inlaySoups: {} },
        placed,
      };
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
    } catch (e) {
      noteEngineError(e);
      // Nothing to cut with. Same escape as the non-watertight branch above: export the untouched
      // body rather than risk a half-cut/half-inlaid pair that would overlap.
      prismEntries.forEach(([pci]) => landedColors.add(pci));
      warnBuild(`Couldn't merge the recesses on "${part.name}". It exports with no artwork.`);
      return {
        output: { part, bodySoup: Float32Array.from(part.positions), inlaySoups: {} },
        placed,
      };
    }
    if (cutter !== prismList[0]) held.add(cutter);
    throwIfCancelled();
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
    } catch (e) {
      noteEngineError(e);
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
      return { output: { part, bodySoup, inlaySoups: {} }, placed };
    }

    // per-color inlay = part ∩ prism (the part caps the overshoot, so the inlay top is flush)
    const inlaySoups: Record<number, Float32Array> = {};
    const inlayIndexed: Record<number, IndexedMesh> = {};
    for (const [ci, prism] of prismEntries) {
      throwIfCancelled();
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
      } catch (e) {
        noteEngineError(e);
        // Unlike the body-cut failure above, exporting uncut can't undo this: the body's pocket
        // for this color is already cut, and redoing that difference is the expensive half. Name
        // the color and say the recess ships empty, so the warning is actionable.
        landedColors.add(ci);
        warnBuild(
          `Couldn't fit the inlay for color ${palette[ci].hex} on "${part.name}". Its pocket ` +
            `is cut into the body but will print as an empty recess.`,
        );
      } finally {
        manifoldDelete(inl);
      }
      await maybeYield();
    }

    // The part shipped with its inlays, so what the edge rule did is now true of the export and
    // can be said. Merged, not assigned: a color can reach the edge on one part and not another.
    for (const [l, d] of partEdgeColors) edgeCutColors.set(l, d);

    return { output: { part, bodySoup, inlaySoups, bodyIndexed, inlayIndexed }, placed };
  } finally {
    held.forEach(manifoldDelete);
  }
}
