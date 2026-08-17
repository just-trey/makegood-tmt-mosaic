/**
 * "Is the app idle" signal for drive scripts, mirroring the setProgressSink / warnings.ts
 * singleton pattern. A counter of outstanding async work (part fetches, an armed rebuild
 * debounce, an in-flight rebuild) plus a waiter list resolved once it drops to zero.
 *
 * Callers must never let the counter touch zero between two back-to-back units of work that
 * are really one continuous busy stretch (e.g. a debounce timer handing off to the rebuild it
 * scheduled) — begin the next unit before ending the current one, or a whenIdle() waiter can
 * resolve on a zero-width gap that isn't actually idle.
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
 * Bumped once per completed rebuild, for drive scripts only.
 *
 * `whenIdle()` answers "is anything in flight", which cannot distinguish "the rebuild I triggered
 * has finished" from "nothing was ever triggered" — the second is where a driven check asserts
 * against the previous state and reports a pass. Reading this before an action and again after
 * makes that difference observable rather than a 30-second wait that looks like a slow rebuild.
 */
export function noteRebuildDone(): void {
  rebuilds++;
}

export function rebuildsSoFar(): number {
  return rebuilds;
}
