import type { ColorSettings } from '../types';

/**
 * One typical layer, the default profile on every printer this targets. Two uses:
 *
 * - The fallback for a request of zero or less. Zero says nothing about what was wanted, so the
 *   fallback must be a depth that prints. An earlier 0.02 mm fallback was a geometry tolerance
 *   borrowed for the job: well-defined for the boolean, but a tenth of a layer slices to nothing,
 *   so the export gained a color costing an AMS slot and printing as bare body.
 * - The threshold below which a recess only *may* not print, and gets a quiet note rather than a
 *   clamp. A positive depth is a real choice and is honored: someone on a 0.08 mm profile can cut
 *   a 0.12 mm recess, which clamping to 0.2 mm would make unreachable (see docs/audience.md).
 */
export const MIN_CUT_DEPTH_MM = 0.2;

/**
 * Nozzle width in mm: the reference for what a printer can lay down at all.
 *
 * Here rather than in raster/stats.ts, which held it privately, because both the trace despeckle
 * and the assembly clip need the same physical fact and the printer does not care which one is
 * asking. raster/stats.ts imports it.
 */
export const NOZZLE_MM = 0.4;

/**
 * Smallest clipped region assembly mode will build a cutter from, in mm².
 *
 * One nozzle square, for the reason NOZZLE_MM carries: an area smaller than this cannot hold a
 * single extrusion of any shape, so nothing it removes was going to print. That is deliberately
 * the weakest claim available about a feature size.
 *
 * It exists because an intersect whose clip boundary runs ALONG an edge of the region being
 * clipped can hand back a hairline instead of null, and a hairline still extrudes into a real
 * inlay. Measured on the chair's Front zone with the mirror check's asymmetric design: the
 * remnant on `chair-seat-back-top` was 0.025mm², 0.02mm wide and 8mm long, against 1,258 to
 * 3,029mm² for every other chart that design reaches — five orders of magnitude of daylight
 * either side of this floor.
 */
export const CLIP_REMNANT_FLOOR_MM2 = NOZZLE_MM * NOZZLE_MM;

/**
 * How much material a recess leaves behind it, so a clamped cut is still a recess.
 *
 * Clamping to the bare extent instead put the cutter floor exactly
 * coplanar with the part's back face — a through-hole and a coincident-face boolean, reported to
 * the user as a recess "cut at 48.50 mm".
 */
export const CUT_FLOOR_MM = 0.05;

/**
 * Compare a requested depth against the one cut at the precision the warnings print (2dp), not at
 * machine epsilon: a 3.951 mm request cut at 3.95 mm otherwise reports "set to 3.95 mm … cut at
 * 3.95 mm instead."
 *
 * Rounds the same way the message does rather than using an epsilon that stands in for it. A 0.005
 * threshold is only *nearly* that rule, and 0.195 lands in the gap: far enough from 0.20 to pass,
 * close enough to print as "0.20". The message is what's being protected, so ask it directly.
 */
export const depthDiffers = (a: number, b: number): boolean => a.toFixed(2) !== b.toFixed(2);

/**
 * How the color list labels a region. Every depth message must name a row the user can see, and a
 * merged group's row reads "Merged (N)": its dominant hex appears nowhere as text.
 */
export function regionLabel(color: string, isMerge: boolean, memberCount: number): string {
  return isMerge ? `Merged (${memberCount})` : color;
}

/**
 * Describes the *setting* and the raise, never the cut that followed. The raised value goes to a
 * mapper that may discard it (a cutThrough part holes any depth the whole way through), so "would
 * cut nothing" would be false there. Everything this says is true wherever the color lands.
 *
 * Takes every color at once, like edgeCutThroughNotice: a global Depth of 0 raises every row, so a
 * message per row stacked one identical-looking pill per color, and an imported photo starts at
 * DEFAULT_RASTER_COLORS of them.
 */
export function zeroDepthWarning(labels: string[], requested: number, raisedTo: number): string {
  const one = labels.length === 1;
  const which = labels.map((l) => `"${l}"`).join(', ');
  return (
    `${one ? 'Depth' : 'Depths'} for ${which} ${one ? 'was' : 'were'} set to ` +
    `${requested.toFixed(2)} mm, which is not a depth that can cut. ` +
    `${one ? 'It was' : 'They were'} raised to ${raisedTo.toFixed(2)} mm.`
  );
}

export interface ZeroDepthRaise {
  requested: number;
  raisedTo: number;
  labels: string[];
}

/**
 * Stage one color's raise for a single message at the end of the build.
 *
 * Keyed by both numbers as the message prints them, never by "was raised at all": `requested` is
 * per color, so merging two pairs would quote some of the colors named the other pair's number.
 * `raisedTo` is in the key for the same reason, though nothing reachable today varies it within one
 * build (maxCutDepth() declines rather than returning below MIN_CUT_DEPTH_MM). A label already staged for a pair is not repeated, which is
 * what keeps a color sitting on several parts to one mention.
 */
export function addZeroDepthRaise(
  into: Map<string, ZeroDepthRaise>,
  label: string,
  requested: number,
  raisedTo: number,
): void {
  const key = `${requested.toFixed(2)}|${raisedTo.toFixed(2)}`;
  const at = into.get(key);
  if (!at) into.set(key, { requested, raisedTo, labels: [label] });
  else if (!at.labels.includes(label)) at.labels.push(label);
}

/**
 * The warning for a depth deeper than the part has material to give.
 *
 * Names the part, unlike zeroDepthWarning: the bound is a property of one part's geometry, so the
 * same setting can be fine on the wheel and clamped on the cap, and a message without the name
 * would read as a fact about the number.
 *
 * **Not the wall check**, and worded so it cannot be read as one: this is how far the whole part
 * extends behind its design face. A thinner wall under a region is thinWallWarning's.
 *
 * Takes every color clamped to the same depth on the same part at once, like zeroDepthWarning:
 * without grouping, a merged-color palette on one part stacked one identical-looking pill per
 * color (see addPartTooDeepClamp).
 */
export function tooDeepWarning(
  labels: string[],
  partName: string,
  requested: number,
  cutAt: number,
): string {
  const one = labels.length === 1;
  const which = labels.map((l) => `"${l}"`).join(', ');
  // Says what it cut, and does not claim that number is the part's face-to-back distance: the cut
  // stops a floor short of it, so quoting one figure as both was wrong by CUT_FLOOR_MM.
  return (
    `${one ? 'Depth' : 'Depths'} for ${which} ${one ? 'was' : 'were'} set to ${requested.toFixed(2)} mm, ` +
    `deeper than "${partName}" goes. ${one ? 'It was' : 'They were'} cut at ${cutAt.toFixed(2)} mm instead.`
  );
}

/**
 * The warning for a depth deeper than the wall under a region, where the part as a whole had room.
 *
 * Quotes the wall as well as the cut, since the cut stops CUT_FLOOR_MM short of it and "only 2.95mm
 * thick" would be wrong about the part. Grouped and keyed exactly like tooDeepWarning.
 */
export function thinWallWarning(
  labels: string[],
  partName: string,
  requested: number,
  cutAt: number,
): string {
  const one = labels.length === 1;
  const which = labels.map((l) => `"${l}"`).join(', ');
  return (
    `${one ? 'Depth' : 'Depths'} for ${which} ${one ? 'was' : 'were'} set to ${requested.toFixed(2)} mm, ` +
    `but "${partName}" is only ${(cutAt + CUT_FLOOR_MM).toFixed(2)} mm thick under ${one ? 'it' : 'them'}. ` +
    `${one ? 'It was' : 'They were'} cut at ${cutAt.toFixed(2)} mm instead.`
  );
}

export interface PartDepthClamp {
  requested: number;
  cutAt: number;
  labels: string[];
  partName: string;
}

/**
 * Stage one color's too-deep clamp for a single message at the end of the build. Keyed like
 * addZeroDepthRaise, by both numbers the message prints (any row can carry its own depth), plus the
 * part: `maxCutDepth()` is a per-part bound, so two parts can genuinely clamp the same color to two
 * different depths, and the message has to keep naming the part.
 */
export function addPartTooDeepClamp(
  into: Map<string, PartDepthClamp>,
  label: string,
  partName: string,
  requested: number,
  cutAt: number,
): void {
  const key = `${requested.toFixed(2)}|${cutAt.toFixed(2)}|${partName}`;
  const at = into.get(key);
  if (!at) into.set(key, { requested, cutAt, partName, labels: [label] });
  else if (!at.labels.includes(label)) at.labels.push(label);
}

/**
 * Whether a depth is shallow enough to be worth a note, asked at the precision the note prints at,
 * not machine epsilon. A 0.199 mm cut is a rounding artefact away from a full layer, and
 * announcing it produced "is 0.20 mm, thinner than the usual 0.20 mm print layer", which reads as
 * a bug in the tool. Same reasoning as depthDiffers, on the other comparison.
 */
export function subLayerDepth(depth: number): boolean {
  return depth < MIN_CUT_DEPTH_MM && depthDiffers(depth, MIN_CUT_DEPTH_MM);
}

/**
 * The note for a depth that prints only on a fine profile.
 *
 * **An `ℹ`, not a `⚠`. Proposed and rejected (UX review 2026-08-03).** The icon tracks "did the
 * app change your number?", not "might you be disappointed?". A zero is raised, and a value
 * deeper than the part is clamped, so both warn: something was overridden. A positive sub-layer depth is honored
 * exactly as asked, and someone on a 0.08 mm profile cutting a 0.12 mm recess made a real choice
 * (docs/audience.md). Warning about a value the app then obeys is what stops the two real `⚠`s
 * being trusted.
 *
 * What would change the answer: evidence people reach this by accident, e.g. 0.02 from mis-typing
 * 0.2. Even then the fix is value-shaped (flag that 10x-off case), not a severity bump.
 */
export function thinDepthNotice(label: string, depth: number): string {
  return (
    `Depth for "${label}" is ${depth.toFixed(2)} mm, thinner than the usual ` +
    `${MIN_CUT_DEPTH_MM.toFixed(2)} mm print layer. It will only show up if your slicer ` +
    `profile uses a layer height finer than that.`
  );
}

/**
 * The note for colours whose regions reach the part's outer edge and were cut its full thickness
 * instead of their recess depth.
 *
 * **ℹ, not ⚠, deliberately against the rule thinDepthNotice sets out.** By that rule this is a ⚠:
 * the setting *was* overridden at the edge. It stays ℹ for two reasons. The setting is still
 * honoured on the same colour's interior regions, so it was narrowed, not discarded. And it fires
 * on the ordinary path (every hubcap cut to its artwork's shape with artwork reaching the rim),
 * where a ⚠ about the part working as designed stops the two real ⚠s being read.
 *
 * Names the colors rather than describing the rule, which is what makes it checkable: someone who
 * set a depth deliberately can see whether their color was one of them.
 *
 * What would change the answer: reports of people finding a through-cut where they wanted a
 * recess. The fix then is a way to opt a color out, not a louder icon.
 */
export function edgeCutThroughNotice(labels: string[], depth: number): string {
  const one = labels.length === 1;
  const which = labels.map((l) => `"${l}"`).join(', ');
  return (
    `${one ? 'Color' : 'Colors'} ${which} ${one ? 'reaches' : 'reach'} the part's outer edge, so ` +
    `${one ? 'that region cuts' : 'those regions cut'} the full ${depth.toFixed(2)} mm through. The rim ` +
    `prints in ${one ? 'that color' : 'those colors'} instead of the base color. Interior regions ` +
    `still cut at their recess depth.`
  );
}

/**
 * The depth a region was *asked* to cut at, before any clamp. A stored `0` is a real answer, not a
 * missing one: `|| globalDepth` read it as unset and substituted the default, so a
 * deliberately-typed 0 cut at a depth nobody chose. Only absent or non-finite falls back.
 */
export function requestedDepth(
  colorSettings: ColorSettings,
  globalDepth: number,
  key: string,
): number {
  const set = colorSettings[key] && colorSettings[key].depth;
  return typeof set === 'number' && Number.isFinite(set) ? set : globalDepth;
}
