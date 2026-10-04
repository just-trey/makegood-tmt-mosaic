/**
 * "Is the app idle" signal for drive scripts, mirroring the setProgressSink / warnings.ts singleton
 * pattern: a counter of outstanding async work (part fetches, an armed debounce, an in-flight
 * rebuild) plus waiters resolved when it hits zero. Never let it touch zero between back-to-back
 * units of one busy stretch (a debounce handing off to its rebuild): begin the next unit before
 * ending the current, or a whenIdle() waiter resolves on a zero-width gap.
 */
let outstanding = 0;
let waiters: (() => void)[] = [];

export function beginWork(): void {
  outstanding++;
}

export function endWork(): void {
  outstanding = Math.max(0, outstanding - 1);
  if (outstanding === 0) {
    const w = waiters;
    waiters = [];
    w.forEach((fn) => fn());
  }
}

export function whenIdle(): Promise<void> {
  if (outstanding === 0) return Promise.resolve();
  return new Promise((resolve) => waiters.push(resolve));
}

let rebuilds = 0;

/**
 * Bumped once per completed rebuild, for drive scripts only. `whenIdle()` can't tell "the rebuild I
 * triggered finished" from "nothing was triggered", where a driven check asserts against the
 * previous state and passes. Reading this before and after an action makes that observable instead
 * of a 30-second wait that looks like a slow rebuild.
 */
export function noteRebuildDone(): void {
  rebuilds++;
}

export function rebuildsSoFar(): number {
  return rebuilds;
}
