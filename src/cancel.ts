/**
 * Cancellation for a running rebuild. Mirrors the progress.ts / warnings.ts singleton pattern:
 * geometry code asks, the scheduler arms and clears it around each rebuild. A flag, not an
 * AbortController: the thing aborted is a cooperative loop, not a fetch, and a module-level flag
 * reaches the geometry without threading a parameter through every function down to the boolean.
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
  onRequest?.();
}

let onRequest: (() => void) | null = null;

/**
 * Called the moment a cancel is requested, for work that can't poll the flag: a build in a worker
 * is stopped from here, without waiting for a safe point in this thread. One listener; null clears.
 */
export function onCancelRequested(fn: (() => void) | null): void {
  onRequest = fn;
}

export function cancelRequested(): boolean {
  return cancelled;
}

/**
 * Whether a request actually aborted something, as opposed to arriving after the last safe point.
 * A cancel that landed means the queued follow-up pass is dropped; one that missed means the build
 * completed and rendered, and dropping the follow-up would leave panels and the saved session
 * describing a newer state than the geometry that exports.
 */
export function cancelHonoured(): boolean {
  return honoured;
}

/**
 * Abort the rebuild if one has been requested.
 *
 * **A call site is only safe where nothing is allocated, or where something owns what is.** Today:
 *
 *   - geometry/partBuild.ts, anywhere in buildPart: every Manifold solid a part
 *     allocates is registered in `held`, which one finally around that body frees however it
 *     leaves. Four sites rest on that — the per-colour step of the cutter loop, the per-colour
 *     union, before the body difference, and the inlay loop. A colour is the finest boundary
 *     available: buildColorPrism extrudes one solid per region and can retry each through the
 *     repair ladder, with no half-built state anything else can be asked about.
 *   - geometry/assembly.ts, the top of the part loop: before buildPart opens `held`, safe because
 *     the previous part's finally has run and this one has allocated nothing. Anything allocated
 *     above that try is owned by nobody.
 *   - geometry/regions.ts, both yield points: 2D polygon work holding no solids. This is where a
 *     heavy design spends its time; checking there took a 6000-region wheel from 140.4s to 0.3s
 *     (the assembly sites alone left it at 132.2s).
 *
 * **The trap, hit once:** the 2D pass's cooperative union looked safe and wasn't. It is shared with
 * Fill's tiling (geometry/patterns.ts), which runs inside the per-part body, so a check there
 * aborted while the body held Manifold solids nothing would free. The finally closed that hole; the
 * rule stands: before adding a call site, follow every caller of the function it goes in. No
 * measurement has put cancel latency inside the tiling, so no check was added there.
 */
export function throwIfCancelled(): void {
  if (!cancelled) return;
  honoured = true;
  throw new RebuildCancelled();
}
