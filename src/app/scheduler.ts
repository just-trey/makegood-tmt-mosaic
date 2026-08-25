import { clearBuildWarnings, warnBuild } from '../warnings';
import { renderWarnings } from '../ui/warningsView';
import { hideOverlay, showOverlay, updateOverlay } from '../ui/overlay';
import { setProgressSink } from '../progress';
import { beginWork, endWork, noteRebuildDone } from './idle';
import { armCancel, cancelHonoured } from '../cancel';
import { state } from '../state/store';

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

/** main.ts registers the actual rebuild entry point here (breaks the ui <-> rebuild cycle). */
export function setRebuildHandler(h: () => void | Promise<void>): void {
  handler = h;
}

/**
 * Register an up-front estimate of whether the *next* rebuild will be slow, based on the
 * current design/mode. The rebuild blocks the main thread synchronously, so we can't
 * measure or react to its cost mid-flight — the curtain has to be decided (and painted)
 * before it starts. The measured duration of the last rebuild covers the repeated case;
 * this hint covers the very first heavy rebuild, before any measurement exists.
 */
export function setRebuildCostHint(fn: () => boolean): void {
  costHint = fn;
}

/**
 * Whether the next rebuild is expected to be slow — true if the last one was slow, or the
 * up-front estimate says this design/mode is heavy. Used both to show the curtain and to
 * make sliders defer live updates to drag-release.
 */
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
    // A rebuild is already in flight: don't stack a second one, just mark that
    // another pass is needed once this one finishes (it'll pick up latest state).
    dirty = true;
    return;
  }
  running = true;
  beginWork();
  armCancel();
  // Fresh diagnostics for this attempt — a warning from whatever the last rebuild's inputs were
  // (a different zone binding, an artwork that's since been swapped) can't outlive it and still
  // show once this one lands. Standing facts (WARNINGS proper) aren't touched.
  clearBuildWarnings();
  const showsOverlay = isRebuildLikelySlow();
  const t0 = performance.now();
  if (showsOverlay) {
    // Assembly only, which is every part the app offers — the flat modes ship compiled and
    // unrendered (docs/tech-debt.md), so this condition selects everything reachable.
    //
    // The reason recorded here used to be that flat had no safe abort point. That stopped being
    // true when the check went into computeNetRegionsByColor, which both paths run and which holds
    // no Manifold solids. What remains true is the narrower thing: `unionAllCooperative` is shared
    // with Fill's tiling, which runs inside the per-part body holding solids, so a check *there*
    // would still leak. Offering flat a Cancel is untested rather than unsafe, and there is no
    // reachable flat mode to test it on.
    showOverlay('Rebuilding geometry…', { cancellable: state.shapeKind === 'assembly' });
    // The rebuild reports progress as it chunks through the boolean pass; show it as a live
    // percentage, and once it's dragged on a while add a "hang tight" so it reads as working.
    setProgressSink((fraction) => {
      const pct = Math.round(fraction * 100);
      const suffix =
        performance.now() - t0 > HANG_TIGHT_MS ? ' — detailed artwork, hang tight' : '';
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
    // In the finally, so a rebuild that threw still counts: a drive script asking "did a rebuild
    // happen" must get yes for a failed one, or it waits out a timeout and reports the failure as
    // "nothing was scheduled".
    noteRebuildDone();
    if (showsOverlay) {
      setProgressSink(null);
      hideOverlay();
    }
    running = false;
    // A cancel that actually landed drops the queued pass too. Without this, touching a panel
    // mid-rebuild leaves `dirty` set and the follow-up starts the moment the cancel does, so the
    // button looks broken: the curtain returns immediately with the work the user just stopped.
    //
    // `cancelHonoured`, not `cancelRequested`: a press that arrives after the last safe point
    // aborts nothing, so the build has completed and rendered, and dropping its follow-up would
    // leave the panels and the saved session ahead of the geometry that exports.
    if (cancelHonoured()) {
      dirty = false;
      // And the armed debounce: an edit typed inside its window never set `dirty`, so clearing
      // that alone leaves the timer to fire and restart the rebuild that was just stopped.
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    }
    // Start the follow-up pass (which does its own beginWork()) before releasing this pass's
    // reservation, so a dirty rebuild never lets the outstanding count touch zero in between —
    // a whenIdle() waiter must not see a zero-width gap that isn't really idle.
    if (dirty) {
      dirty = false;
      void runNow();
    }
    endWork();
  }
}

/**
 * Debounced rebuild — rapid slider input coalesces into one geometry pass.
 * Pass 'typed' for keystroke-driven number fields, which need a longer settle
 * time than a slider drag so a multi-digit value doesn't rebuild mid-type.
 */
export function scheduleRebuild(mode: RebuildMode = 'live'): void {
  clearTimeout(timer);
  // Reserve one unit of outstanding work for the whole debounce window, not one per call — a
  // slider drag calls this every few ms, and only the last call's timer ever fires.
  if (!debouncePending) {
    debouncePending = true;
    beginWork();
  }
  timer = setTimeout(
    () => {
      debouncePending = false;
      // runNow() does its own beginWork() before this reservation is released, so the
      // outstanding count never touches zero on the handoff.
      void runNow();
      endWork();
    },
    mode === 'typed' ? TYPED_DEBOUNCE_MS : LIVE_DEBOUNCE_MS,
  );
}
