import { clearBuildWarnings, warnBuild } from '../warnings';
import { renderWarnings } from '../ui/warningsView';
import { hideOverlay, showOverlay, updateOverlay } from '../ui/overlay';
import { setProgressSink } from '../progress';
import { beginWork, endWork, noteRebuildDone } from './idle';
import { armCancel, cancelHonoured } from '../cancel';

let handler: () => void | Promise<void> = () => {};
let costHint: () => boolean = () => false;
let timer: ReturnType<typeof setTimeout> | undefined;

const LIVE_DEBOUNCE_MS = 30;
const TYPED_DEBOUNCE_MS = 550;
/** After this long, the curtain adds a "hang tight" note so a slow rebuild reads as working,
 * not stuck. */
const HANG_TIGHT_MS = 8000;
/** A rebuild slower than this is worth a "Rebuilding…" curtain and worth having a slider
 * defer live updates to drag-release rather than redraw every frame. */
const SLOW_REBUILD_MS = 130;

type RebuildMode = 'live' | 'typed';

let running = false;
let dirty = false;
let lastRebuildMs = 0;
let debouncePending = false;
/** Set by whichever debounce timer fired last; read once by the pass it starts. */
let nextPassSettled = false;
let passSettled = false;

/**
 * Whether the running pass was started by the typed debounce, i.e. nothing scheduled a rebuild in
 * the TYPED_DEBOUNCE_MS before it. Work too heavy per slider step (a re-trace) runs only on such a
 * pass; a live pass that finds it owed calls `scheduleRebuild('typed')`.
 */
export function rebuildSettled(): boolean {
  return passSettled;
}

/** main.ts registers the actual rebuild entry point here (breaks the ui <-> rebuild cycle). */
export function setRebuildHandler(h: () => void | Promise<void>): void {
  handler = h;
}

/**
 * Register an up-front estimate of whether the *next* rebuild will be slow. The curtain is decided
 * and painted before the rebuild starts, which on the page (no worker) blocks until it ends. The
 * last rebuild's measured duration covers repeats; this covers the first heavy one.
 */
export function setRebuildCostHint(fn: () => boolean): void {
  costHint = fn;
}

/** Whether the next rebuild is expected slow: the last one was, or the up-front estimate says so. Shows the curtain and makes sliders defer live updates to drag-release. */
export function isRebuildLikelySlow(): boolean {
  return lastRebuildMs > SLOW_REBUILD_MS || costHint();
}

/** Resolve after the browser has painted once (two rAFs: the first runs before a paint, the
 * second after it), so a curtain shown just before is on screen before the caller blocks. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

async function runNow(): Promise<void> {
  if (running) {
    // A rebuild is already in flight: don't stack a second, mark that another pass is needed (it picks up latest state).
    dirty = true;
    return;
  }
  running = true;
  passSettled = nextPassSettled;
  nextPassSettled = false;
  beginWork();
  armCancel();
  // Fresh diagnostics for this attempt: a warning from the last rebuild's inputs (another zone binding, a swapped artwork) mustn't outlive it. Standing facts (WARNINGS proper) are untouched.
  clearBuildWarnings();
  const showsOverlay = isRebuildLikelySlow();
  const t0 = performance.now();
  if (showsOverlay) {
    showOverlay('Rebuilding geometry…', { cancellable: true });
    // Progress shows as a live percentage, with a "hang tight" once it drags on.
    setProgressSink((fraction) => {
      const pct = Math.round(fraction * 100);
      const suffix =
        performance.now() - t0 > HANG_TIGHT_MS ? ' (detailed artwork, hang tight)' : '';
      updateOverlay(`Rebuilding geometry… ${pct}%${suffix}`);
    });
    // Yield a paint frame so the curtain is actually on screen before the rebuild starts.
    await nextPaint();
  }
  try {
    await handler();
  } catch (e) {
    console.error(e);
    warnBuild('Rebuild failed: ' + (e as Error).message);
    renderWarnings();
  } finally {
    lastRebuildMs = performance.now() - t0;
    // In the finally, so a throwing rebuild still counts: a drive script asking "did a rebuild happen" must get yes, not wait out a timeout and report "nothing was scheduled".
    noteRebuildDone();
    if (showsOverlay) {
      setProgressSink(null);
      hideOverlay();
    }
    running = false;
    // A cancel that landed drops the queued pass too: otherwise touching a panel mid-rebuild leaves
    // `dirty` set and the follow-up starts as the cancel does, so the button looks broken.
    // `cancelHonoured`, not `cancelRequested`: a press after the last safe point aborts nothing, the
    // build completed and rendered, and dropping its follow-up would leave panels and the saved
    // session ahead of the geometry that exports.
    if (cancelHonoured()) {
      dirty = false;
      // And the armed debounce: a typed edit inside its window never set `dirty`, so the timer would
      // restart the rebuild just stopped. Keyed on `debouncePending`, not `timer` — the callback never
      // nulls its handle, so `timer !== undefined` stays true after firing.
      // The reservation is released here too: scheduleRebuild's beginWork() is matched by an
      // endWork() inside the timer, so dropping the timer leaks +1 outstanding and whenIdle() never
      // resolves until the next edit. Unreachable when a cancel took 140s, routine at 0.3s where a
      // typed edit's 550ms window is open at the press.
      if (debouncePending) {
        clearTimeout(timer);
        timer = undefined;
        debouncePending = false;
        endWork();
      }
    }
    // Start the follow-up (its own beginWork()) before releasing this pass's reservation, so the outstanding count never touches zero and a whenIdle() waiter sees no false-idle gap.
    if (dirty) {
      dirty = false;
      void runNow();
    }
    endWork();
  }
}

/** Debounced rebuild — rapid slider input coalesces into one pass. 'typed' (keystroke-driven number fields) settles longer so a multi-digit value doesn't rebuild mid-type. */
export function scheduleRebuild(mode: RebuildMode = 'live'): void {
  clearTimeout(timer);
  // One unit of outstanding work for the whole debounce window, not per call — a slider drag calls every few ms and only the last timer fires.
  if (!debouncePending) {
    debouncePending = true;
    beginWork();
  }
  timer = setTimeout(
    () => {
      debouncePending = false;
      nextPassSettled = mode === 'typed';
      // runNow() does its own beginWork() before this reservation is released, so the outstanding count never touches zero on the handoff.
      void runNow();
      endWork();
    },
    mode === 'typed' ? TYPED_DEBOUNCE_MS : LIVE_DEBOUNCE_MS,
  );
}
