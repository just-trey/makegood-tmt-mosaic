import { $ } from './dom';
import { cancelRequested, requestCancel } from '../cancel';

/** One caller's curtain: what it says, and whether its work checks for a cancel. */
export interface OverlayHandle {
  text: string;
  cancellable: boolean;
}

/**
 * Every caller showing the curtain, newest on top. A rebuild, an export and a part load can overlap
 * now the page stays responsive during a build: each hides only its own, and the one beneath comes
 * back with its own text and Cancel when the top one goes.
 */
const shown: OverlayHandle[] = [];

/**
 * The "Rebuilding geometry…" curtain. It carries a Cancel because a rebuild can run for minutes: the
 * chair with a pattern in Fill measured 93.6s for one zone and didn't finish inside 900s across
 * five. Without it the only way out was a reload.
 */
export function showOverlay(text: string, { cancellable = false } = {}): OverlayHandle {
  const handle = { text, cancellable };
  shown.push(handle);
  if (cancellable) setCancelState(false);
  render();
  return handle;
}

/** Update one caller's text in place (e.g. live progress), shown if it is on top. */
export function updateOverlay(handle: OverlayHandle, text: string): void {
  handle.text = text;
  if (shown.at(-1) === handle) $('#loading-text').textContent = text;
}

export function hideOverlay(handle: OverlayHandle): void {
  const i = shown.lastIndexOf(handle);
  if (i >= 0) shown.splice(i, 1);
  render();
}

function render(): void {
  const top = shown.at(-1);
  $('#loading-overlay').style.display = top ? 'flex' : 'none';
  if (!top) return;
  $('#loading-text').textContent = top.text;
  // Hidden unless the work behind the curtain checks for a cancel: exports and part loads
  // (exportPanel.ts, assembly/parts.ts) never call throwIfCancelled, so a button there would latch
  // to "Cancelling…" and do nothing.
  $('#loading-cancel').hidden = !top.cancellable;
  // Only a rebuild is cancellable, and it runs in a worker: the scene under it stays live to orbit.
  $('#loading-overlay').classList.toggle('pass-through', top.cancellable);
}

/**
 * A build in the worker is dropped the moment Cancel is pressed, and the curtain goes with it. Built
 * on the page, it stops at the next safe point instead (src/cancel.ts): 0.3s in the region pass of a
 * 6000-region wheel (docs/findings/2026-08-25-cancel-latency.md), 0.04-0.06s in the cut.
 * "Cancelling…" separates a button that looks broken in that wait from one visibly working.
 */
function setCancelState(pending: boolean): void {
  const btn = $<HTMLButtonElement>('#loading-cancel');
  btn.disabled = pending;
  btn.textContent = pending ? 'Cancelling…' : 'Cancel';
}

export function initOverlay(): void {
  $('#loading-cancel').addEventListener('click', () => {
    if (cancelRequested()) return;
    requestCancel();
    setCancelState(true);
  });
}
