import { warn } from '../warnings';
import { renderWarnings } from '../ui/warningsView';
import { hideOverlay, showOverlay } from '../ui/overlay';

let handler: () => void | Promise<void> = () => {};
let timer: ReturnType<typeof setTimeout> | undefined;

/** main.ts registers the actual rebuild entry point here (breaks the ui <-> rebuild cycle). */
export function setRebuildHandler(h: () => void | Promise<void>): void {
  handler = h;
}

/** Debounced rebuild — rapid slider input coalesces into one geometry pass. */
export function scheduleRebuild(): void {
  clearTimeout(timer);
  showOverlay('Rebuilding geometry…');
  timer = setTimeout(async () => {
    try { await handler(); }
    catch (e) {
      console.error(e);
      warn('Rebuild failed: ' + (e as Error).message);
      renderWarnings();
    }
    hideOverlay();
  }, 30);
}
