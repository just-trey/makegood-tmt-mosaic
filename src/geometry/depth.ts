import type { ColorSettings } from '../types';

/**
 * One typical layer — the default profile on every printer this targets. Used for two things:
 *
 * - the depth a request of zero or less falls back to. Zero says nothing about what was wanted, so
 *   the fallback has to be a depth that actually prints. An earlier 0.02 mm fallback was a geometry
 *   tolerance borrowed for the job: it kept the boolean well-defined, but a tenth of a layer slices
 *   to nothing, so the export gained a color that cost an AMS slot and printed as bare body.
 * - the threshold below which a recess only *may* not print, and gets a quiet note rather than a
 *   clamp. A positive depth is a real choice and is honored: someone on a 0.08 mm profile can cut a
 *   0.12 mm recess, and clamping them up to 0.2 mm would make that unreachable. They know their
 *   slicer — see docs/audience.md.
 */
export const MIN_CUT_DEPTH_MM = 0.2;

/**
 * Compare a requested depth against the one actually cut at the precision the warnings print
 * (2dp), not at machine epsilon — otherwise a 3.951 mm request on a 4 mm plate reports itself as
 * "set to 3.95 mm … cut at 3.95 mm instead."
 *
 * Rounding the same way the message does, rather than by an epsilon standing in for it: a 0.005
 * threshold is only *nearly* that rule, and 0.195 lands in the gap — far enough from 0.20 to pass
 * the threshold, close enough to print as "0.20". The message is the thing being protected, so ask
 * it directly.
 */
export const depthDiffers = (a: number, b: number): boolean => a.toFixed(2) !== b.toFixed(2);

/**
 * How the color list labels a region. Every depth message has to name a row the user can actually
 * see, and a merged group's row reads "Merged (N)" — its dominant hex appears nowhere as text. Both
 * modes go through here so fixing the label in one can't leave the other pointing at a phantom row,
 * which is exactly how assembly mode kept the bug flat mode had already had fixed.
 */
export function regionLabel(color: string, isMerge: boolean, memberCount: number): string {
  return isMerge ? `Merged (${memberCount})` : color;
}

/**
 * The one message both modes raise, so it can't drift apart in wording the way the label once did.
 *
 * It describes the *setting* and the raise, never the cut that followed. Assembly mode hands the
 * raised value to a mapper that may discard it — a cutThrough part takes its hole the whole way
 * through for any depth — so a clause like "would cut nothing" would be false there while being
 * true in flat mode. Everything this says is true wherever the color lands.
 */
export function zeroDepthWarning(label: string, requested: number, raisedTo: number): string {
  return (
    `Depth for "${label}" was set to ${requested.toFixed(2)} mm, which is not a depth that can ` +
    `cut — it was raised to ${raisedTo.toFixed(2)} mm.`
  );
}

/**
 * Whether a depth is shallow enough to be worth a note — asked at the precision the note prints
 * at, not at machine epsilon. A 0.199 mm cut is a rounding artefact away from a full layer, and
 * announcing it produced "is 0.20 mm, thinner than the usual 0.20 mm print layer", which reads as
 * a bug in the tool. Same reasoning as depthDiffers, applied to the other comparison.
 */
export function subLayerDepth(depth: number): boolean {
  return depth < MIN_CUT_DEPTH_MM && depthDiffers(depth, MIN_CUT_DEPTH_MM);
}

/**
 * The note both modes raise for a depth that prints only on a fine profile. Shared for the same
 * reason as zeroDepthWarning and regionLabel: two copies of a string is how assembly kept a bug
 * flat mode had already had fixed.
 *
 * **This is an `ℹ`, not a `⚠`, and that was challenged and kept.** A UX review (2026-08-03)
 * argued for promoting it, on the grounds that this is the case shipping a file that prints
 * *nothing visible* — worse than the plate clamp, which does warn. Rejected on purpose: the icon
 * here tracks *"did the app change your number?"*, not *"might you be disappointed?"*. A zero gets
 * raised and a too-deep value gets clamped, so both warn — something was overridden. A positive
 * sub-layer depth is honored exactly as asked, and someone on a 0.08 mm profile cutting a 0.12 mm
 * recess made a real choice (see docs/audience.md). Warning about a value the app then obeys is
 * crying wolf, and it is what would make the two real `⚠`s stop being trusted.
 *
 * What would change the answer: evidence people reach this by accident rather than choice — a typo
 * path where 0.02 comes from mis-typing 0.2. Even then the fix is value-shaped (flag that specific
 * 10x-off case), not a severity bump, which would re-break the fine-profile user.
 */
export function thinDepthNotice(label: string, depth: number): string {
  return (
    `Depth for "${label}" is ${depth.toFixed(2)} mm, thinner than the usual ` +
    `${MIN_CUT_DEPTH_MM.toFixed(2)} mm print layer — it will only show up if your slicer ` +
    `profile uses a layer height finer than that.`
  );
}

/**
 * The depth a region was *asked* to cut at, before any clamp.
 *
 * A stored `0` is a real answer, not a missing one: `|| globalDepth` read it as unset and
 * substituted the global default, so a deliberately-typed 0 cut at a depth nobody chose. Only an
 * absent or non-finite entry falls back to the global.
 */
export function requestedDepth(
  colorSettings: ColorSettings,
  globalDepth: number,
  key: string,
): number {
  const set = colorSettings[key] && colorSettings[key].depth;
  return typeof set === 'number' && Number.isFinite(set) ? set : globalDepth;
}
