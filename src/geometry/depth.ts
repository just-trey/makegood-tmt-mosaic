import type { ColorSettings } from '../types';

/**
 * Shallowest cut worth making — one typical layer (0.2 mm is the default profile on every printer
 * this targets).
 *
 * This is the depth a too-shallow request is *raised to* and told about, so it has to be a depth
 * that actually prints. An earlier 0.02 mm floor was a geometry tolerance borrowed for the job: it
 * kept the boolean well-defined, but a tenth of a layer slices to nothing, so the export gained a
 * color that consumed an AMS slot and printed as bare body while the warning said it had been cut.
 */
export const MIN_CUT_DEPTH_MM = 0.2;

/**
 * Compare a requested depth against the one actually cut at the precision the warnings print
 * (2dp), not at machine epsilon — otherwise a 3.951 mm request on a 4 mm plate reports itself as
 * "set to 3.95 mm … cut at 3.95 mm instead."
 */
export const depthDiffers = (a: number, b: number): boolean => Math.abs(a - b) >= 0.005;

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
