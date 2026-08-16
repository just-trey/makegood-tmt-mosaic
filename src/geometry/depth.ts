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
 * Compare a requested depth against the one cut at the precision the warnings print (2dp), not at
 * machine epsilon: a 3.951 mm request on a 4 mm plate otherwise reports "set to 3.95 mm … cut at
 * 3.95 mm instead."
 *
 * Rounds the same way the message does rather than using an epsilon that stands in for it. A 0.005
 * threshold is only *nearly* that rule, and 0.195 lands in the gap: far enough from 0.20 to pass,
 * close enough to print as "0.20". The message is what's being protected, so ask it directly.
 */
export const depthDiffers = (a: number, b: number): boolean => a.toFixed(2) !== b.toFixed(2);

/**
 * How the color list labels a region. Every depth message must name a row the user can see, and a
 * merged group's row reads "Merged (N)": its dominant hex appears nowhere as text. Both modes go
 * through here, so fixing the label in one can't leave the other pointing at a phantom row, which
 * is how assembly mode kept a bug flat mode had already fixed.
 */
export function regionLabel(color: string, isMerge: boolean, memberCount: number): string {
  return isMerge ? `Merged (${memberCount})` : color;
}

/**
 * The one message both modes raise, so it can't drift in wording the way the label once did.
 *
 * Describes the *setting* and the raise, never the cut that followed. Assembly mode hands the
 * raised value to a mapper that may discard it (a cutThrough part holes any depth the whole way
 * through), so "would cut nothing" would be false there and true in flat mode. Everything this
 * says is true wherever the color lands.
 */
export function zeroDepthWarning(label: string, requested: number, raisedTo: number): string {
  return (
    `Depth for "${label}" was set to ${requested.toFixed(2)} mm, which is not a depth that can ` +
    `cut — it was raised to ${raisedTo.toFixed(2)} mm.`
  );
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
 * The note both modes raise for a depth that prints only on a fine profile. Shared for the same
 * reason as zeroDepthWarning and regionLabel: two copies of a string is how assembly kept a bug
 * flat mode had already fixed.
 *
 * **An `ℹ`, not a `⚠`. Proposed and rejected (UX review 2026-08-03).** The icon tracks "did the
 * app change your number?", not "might you be disappointed?". A zero is raised and a too-deep
 * value clamped, so both warn: something was overridden. A positive sub-layer depth is honored
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
    `${MIN_CUT_DEPTH_MM.toFixed(2)} mm print layer — it will only show up if your slicer ` +
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
    `${one ? 'that region cuts' : 'those regions cut'} the full ${depth.toFixed(2)} mm through — the rim ` +
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
