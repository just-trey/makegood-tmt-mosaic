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
 * **Only call this where nothing is owned that a `finally` would not free.** The assembly build
 * allocates Manifold solids and frees them by hand on each branch, with no outer try/finally
 * around the per-part body, so a throw from inside a part leaks WASM memory that repeated
 * cancelling would accumulate.
 *
 * **A call site is only safe where nothing is allocated, or where something owns what is.** Today
 * there are four:
 *
 *   - geometry/assembly.ts, top of the part loop: the previous part is released and this one has
 *     allocated nothing.
 *   - geometry/assembly.ts, the per-colour step of the cutter loop: a catch around that loop frees
 *     `colorPrisms` before rethrowing.
 *   - geometry/regions.ts, both yield points: that pass is 2D polygon work and holds no solids at
 *     all. This is where a heavy design actually spends its time, and checking there took a
 *     6000-region wheel from 140.4s to 0.3s. The two assembly sites together left it at 132.2s.
 *
 * **The trap, hit once already:** the flat path's cooperative union looks safe, and is not. It is
 * shared with Fill's tiling (geometry/patterns.ts), which runs inside the per-part body holding
 * Manifold solids, so a check there leaks on exactly the slow case this exists for. Before adding
 * a call site, follow every caller of the function you are putting it in, not just the one in
 * front of you.
 */
export function throwIfCancelled(): void {
  if (!cancelled) return;
  honoured = true;
  throw new RebuildCancelled();
}
