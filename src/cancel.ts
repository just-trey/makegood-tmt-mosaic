/**
 * Cancellation for a running rebuild. Mirrors the progress.ts / warnings.ts singleton pattern:
 * geometry code asks, the UI (the scheduler) arms and clears it around each rebuild.
 *
 * A flag rather than an AbortController because the thing being aborted is a cooperative loop, not
 * a fetch: nothing here needs a signal to hand to a browser API, and a module-level flag reaches
 * the geometry without threading a parameter through every function between the button and the
 * boolean.
 */
let cancelled = false;
let honoured = false;

/** Thrown by throwIfCancelled. Distinct so the scheduler can tell a cancel from a real failure. */
export class RebuildCancelled extends Error {
  constructor() {
    super('Rebuild cancelled');
    this.name = 'RebuildCancelled';
  }
}

export function armCancel(): void {
  cancelled = false;
  honoured = false;
}

export function requestCancel(): void {
  cancelled = true;
}

export function cancelRequested(): boolean {
  return cancelled;
}

/**
 * Whether a request actually aborted something, as opposed to arriving after the last safe point.
 *
 * The two need telling apart: a cancel that landed means the queued follow-up pass should be
 * dropped, because the user stopped that work. A cancel that missed means the build completed and
 * rendered, so dropping the follow-up would leave the panels and the saved session describing a
 * newer state than the geometry that exports.
 */
export function cancelHonoured(): boolean {
  return honoured;
}

/**
 * Abort the rebuild if one has been requested.
 *
 * **Only call this where nothing is owned that a `finally` would not free.**
 *
 * **A call site is only safe where nothing is allocated, or where something owns what is.** Today:
 *
 *   - geometry/assembly.ts, anywhere in the per-part loop body: every Manifold solid a part
 *     allocates is registered in `held`, which one finally around that body frees however the body
 *     leaves it. Four sites rest on that — the per-colour step of the cutter loop, the per-colour
 *     union, before the body difference, and the inlay loop. A colour, not a Manifold call, is the
 *     finest boundary available: buildColorPrism extrudes one solid per region and can retry each
 *     through the repair ladder, and none of that is half-built state anything else can be asked
 *     about.
 *   - geometry/assembly.ts, the top of the part loop: above `held` and outside its try, so it is
 *     safe for the older reason instead — the previous part's finally has run and this one has
 *     allocated nothing yet. Anything allocated above that try is owned by nobody.
 *   - geometry/regions.ts, both yield points: that pass is 2D polygon work and holds no solids at
 *     all. This is where a heavy design actually spends its time, and checking there took a
 *     6000-region wheel from 140.4s to 0.3s. The assembly sites left it at 132.2s.
 *
 * **The trap, hit once already:** the flat path's cooperative union looked safe and was not. It is
 * shared with Fill's tiling (geometry/patterns.ts), which runs inside the per-part body, so a check
 * there aborted while that body held Manifold solids nothing would free. The finally closed that
 * hole, and the rule it taught stands: before adding a call site, follow every caller of the
 * function you are putting it in, not just the one in front of you. No measurement has put cancel
 * latency inside the tiling, so no check has been added there.
 */
export function throwIfCancelled(): void {
  if (!cancelled) return;
  honoured = true;
  throw new RebuildCancelled();
}
