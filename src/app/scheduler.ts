import { warn } from '../warnings';
import { renderWarnings } from '../ui/warningsView';
import { hideOverlay, showOverlay, updateOverlay } from '../ui/overlay';
import { setProgressSink } from '../progress';

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
  const showsOverlay = isRebuildLikelySlow();
  const t0 = performance.now();
  if (showsOverlay) {
    showOverlay('Rebuilding geometry…');
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
    warn('Rebuild failed: ' + (e as Error).message);
    renderWarnings();
  } finally {
    lastRebuildMs = performance.now() - t0;
    if (showsOverlay) {
      setProgressSink(null);
      hideOverlay();
    }
    running = false;
    if (dirty) {
      dirty = false;
      void runNow();
    }
  }
}

/**
 * Debounced rebuild — rapid slider input coalesces into one geometry pass.
 * Pass 'typed' for keystroke-driven number fields, which need a longer settle
 * time than a slider drag so a multi-digit value doesn't rebuild mid-type.
 */
export function scheduleRebuild(mode: RebuildMode = 'live'): void {
  clearTimeout(timer);
  timer = setTimeout(() => void runNow(), mode === 'typed' ? TYPED_DEBOUNCE_MS : LIVE_DEBOUNCE_MS);
}
