import type { CrossPartState } from './buildContext';
import { overlappingDesignPairs, type PlacedDesign } from './designOverlap';
import { MAX_FILL_TILES, type TileRefusal, type TileRefusalReport } from './patterns';
import { oppositeSide, type KeepSide } from './zones';
import { dismissNotice, warnBuild } from '../warnings';

/**
 * Names detail too fine to print, per colour and part (the pair the user can act on). Says nothing
 * of cause, amount or remainder: three clips can each drop something, and the key dedupes across
 * them first-push-wins, so a remainder claim could outlive a later clip removing the rest. A
 * notice, not a warning: one nozzle square is the floor, so nothing printable went.
 */
export function unprintableSpeckNotice(label: string, partName: string): string {
  return (
    `"${label}" has detail on "${partName}" too fine to print, so it wasn't cut. A recess needs ` +
    `to be about 0.4 mm across to hold a bead.`
  );
}

/** Rule 1 for `cancelsOut` (regions.ts): one warning per build, counted over every design. */
export function cancelledOutlinesWarning(n: number): string {
  return n === 1
    ? "1 outline crosses over itself and its halves cancel out, so it was left out. Redraw it as separate shapes that don't cross."
    : `${n} outlines cross over themselves and their halves cancel out, so they were left out. Redraw them as separate shapes that don't cross.`;
}

/** One pill per colour and part, however many of the three clips leave a speck. See Notice.key. */
export const speckKey = (ci: number, partId: number): string => `speck:${ci}:${partId}`;

/** Rule 1 for the net clip: where the part of a whole-part design this zone gave up is cut. */
export function netShareNotice(design: string, zone: string, toNames: string[]): string {
  const where =
    toNames.length === 1 ? `"${toNames[0]}"` : toNames.map((n) => `"${n}"`).join(' and ');
  return (
    `"${design}" reaches part of the whole-part sheet that ${where} owns. ` +
    `It is cut there, not on "${zone}".`
  );
}

/**
 * Rule 1's other half for the net clip: the ink moved and the sheets don't meet where it crossed,
 * so the halves cut tens of mm apart. A warning: the cut is correct, the result isn't what anyone
 * drew. `NetZoneExclusion.tearMm` is a median over the stretch, hence whole mm.
 * Raised from the clip, not a rebuild.ts boundary test: 31% and 8% of the chair's two boundaries
 * join, so a placed-bbox test would fire for nearly every whole-part design.
 * Zones are sorted: the divider is ragged, so one crossing raises this from both sides, and a
 * from/to order made two pills for one boundary. `raiseTornWarning` keeps the worse tear.
 */
export function netTornWarning(design: string, zones: string[], tearMm: number): string {
  const [a, b] = [...zones].sort();
  return (
    `"${design}" crosses between "${a}" and "${b}", where the two sheets do not join. ` +
    `It prints in two pieces, about ${Math.round(tearMm)}mm apart. Bind it to one zone instead.`
  );
}

/**
 * One pill per design and boundary, quoting the worst tear, so not the notice list's first-wins
 * dedupe: each side of a boundary measures its own rows (33.8mm and 2.6mm across the chair's
 * flank/back join), and first-wins could quote 2.6mm for a design torn by 34mm.
 * `seen` is per build and shared by colours, which can cross different torn stretches.
 */
export function raiseTornWarning(
  seen: CrossPartState['tornPills'],
  design: string,
  zones: string[],
  tearMm: number,
): void {
  const key = `net-torn:${design}:${[...zones].sort().join(':')}`;
  const had = seen.get(key);
  if (had && had.tearMm >= tearMm) return;
  if (had) dismissNotice(had.message, key);
  const message = netTornWarning(design, zones, tearMm);
  seen.set(key, { message, tearMm });
  warnBuild(message, key);
}

/**
 * The net clip could not be applied, so this zone cuts the part another sheet also cuts and the
 * design lands twice. One remedy, the one that always works.
 */
export function netShareFailedWarning(design: string, zone: string): string {
  return (
    `Couldn't trim "${design}" to the part of the whole-part sheet "${zone}" owns. ` +
    `Some of it prints twice. Bind that design to one zone instead.`
  );
}

/** Rule 1 for the half clip: what a mirrored design lost to the centre line, and where it went. */
export function mirrorHalfNotice(design: string, zone: string, side: KeepSide): string {
  return (
    `"${design}" crosses the centre line of "${zone}". ` +
    `Its ${side} half is kept and mirrored onto the ${oppositeSide(side)}.`
  );
}

/**
 * The half clip could not be applied (the clipper flaked, or the zone has no centre to clip at),
 * so the design and its reflection both cut whole and their inlays double up along the centre line.
 * One remedy, the one that always works.
 */
export function mirrorClipFailedWarning(design: string, zone: string): string {
  return (
    `Couldn't crop "${design}" to its half of "${zone}". ` +
    `It and its mirror image both print in full. Untick Mirror on that design.`
  );
}

/**
 * Rules 1 and 3 for a fill yielding to a sticker: that one color keeps the overlap, and says so.
 * The remedy is a nudge because the failure is the clipper's, on these exact coordinates.
 */
export function fillYieldFailedWarning(label: string, fill: string, partName: string): string {
  return (
    `Couldn't fit "${label}" of "${fill}" around the design on top of it on "${partName}". ` +
    `Where they meet, both print in the same space. Move the design on top slightly.`
  );
}

/** Said once per color, and only when no part cuts it: covered on one part, it prints on another. */
export function fillCoveredNotice(label: string): string {
  return `"${label}" is hidden everywhere by the designs on top of it, so it isn't cut.`;
}

/**
 * One word for the repeated thing: "tile", never also "copy" (convention 1). Second person, per the
 * README's voice. Shared by every fill fallback, including the extent-missing one past the switch.
 */
export const FILL_FELL_BACK_TO_ONE_TILE = 'You have one tile instead.';

/**
 * Per-cause message for a Fill that couldn't repeat. `tileCoverage` refuses five ways and raising
 * Scale fixes two (docs/ui-conventions.md 2 and 3: one problem, one actionable remedy).
 */
export function fillRefusalMessage(
  designName: string,
  partName: string,
  reason: TileRefusal | undefined,
  detail?: NonNullable<TileRefusalReport['detail']> & { scalable: boolean },
): string {
  const placed = FILL_FELL_BACK_TO_ONE_TILE;
  const design = `"${designName}"`;
  switch (reason) {
    case 'too-many-tiles':
      return (
        `${design} is too small to fill "${partName}": it would take more than ` +
        `${MAX_FILL_TILES} tiles. ${placed} Raise Scale to fill it with fewer, larger tiles.`
      );
    // Two arms: a design can be over budget at every Scale the panel offers, and raising Scale
    // would repeat the warning (convention 2). Only the caller has the placer at maximum Scale,
    // hence `scalable`. The count is the busiest color's, not the tile's, and the wording says so.
    // Without its numbers it falls through to the default: a limit without them is unactionable.
    case 'too-detailed':
      if (detail)
        return detail.scalable
          ? `${design} is too detailed to fill "${partName}". Repeating its busiest color means ` +
              `merging ${detail.tiles} tiles of ${detail.points} points each. ${placed} Raise ` +
              'Scale to fill it with fewer, larger tiles.'
          : `${design} is too detailed to fill "${partName}" at any Scale. Its busiest color ` +
              `carries ${detail.points} points per tile. ${placed} Simplify the design in ` +
              'Illustrator or Inkscape.';
      break;
    // Not necessarily the busiest color, so it names none: a background that runs through every
    // tile joins into one shape however few points it has.
    case 'joins-too-big':
      if (detail)
        return detail.scalable
          ? `${design} is too detailed to fill "${partName}". One of its colors joins across ` +
              `all ${detail.tiles} tiles into one shape too big to cut. ${placed} Raise Scale ` +
              'to fill it with fewer, larger tiles.'
          : `${design} is too detailed to fill "${partName}" at any Scale. One of its colors ` +
              `joins across the tiles into one shape too big to cut. ${placed} Simplify the ` +
              'design in Illustrator or Inkscape.';
      break;
    // Not a missing viewBox: tileCellOf already falls back to the artwork bbox when the viewBox
    // isn't positive in both axes. Reaching here means the DRAWING has no extent in one direction.
    case 'no-tile-size':
      return (
        `${design} measures zero in one direction, so there is no tile to repeat across ` +
        `"${partName}". ${placed} Use a design with both width and height.`
      );
    case 'not-invertible':
      return (
        `The placement of ${design} on "${partName}" has collapsed to no width or no height. ` +
        `Its tiles can't be worked out. ${placed} Use "Reset to auto-fit" to put it back.`
      );
    case 'not-affine':
      return (
        `"${partName}" curves too much for ${design} to tile evenly across it. ${placed} Place ` +
        'separate designs on it instead of filling it.'
      );
  }
  // A refusal path that forgot to name itself, or its numbers: say so rather than guess a cause.
  return (
    `${design} couldn't be tiled across "${partName}", for a reason the app didn't record. ` +
    `${placed} Please report this.`
  );
}

/**
 * Name both designs when two land on top of each other. Nothing downstream notices: cutters are per
 * design, the body union looks perfect, and the inlays only meet in the export, where the slicer
 * picks arbitrarily. Per zone, not per part; warnings dedupe by message, so a pair is said once.
 */
export function warnOverlappingDesigns(placed: PlacedDesign[]): void {
  for (const [a, b] of overlappingDesignPairs(placed)) {
    const both = a.fill && b.fill;
    const subject =
      a.name === b.name ? `Two placements of "${a.name}"` : `Designs "${a.name}" and "${b.name}"`;
    warnBuild(
      both
        ? // No move or rescale remedy: a fill covers the whole face, and Fill is only offered on
          // zoneless kinds (chair-body sets withholdFill), so there is nowhere to move one.
          `${subject} are both set to Fill, so they cover each other. Where their colors` +
            ' differ, two inlays claim the same space. Switch one to Sticker, or remove it.'
        : // "may": the check bounds ink reaching the shared box rather than intersecting, so
          // artwork sharing a box without touching trips it (designOverlap.ts).
          `${subject} overlap. Where they cross, their recesses cut into each other and two` +
            ' inlays may claim the same space. Move, rescale, or rotate one.',
    );
  }
}
