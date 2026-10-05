import { $ } from './dom';
import { cancelRequested, requestCancel } from '../cancel';

/**
 * The "Rebuilding geometry…" curtain. It carries a Cancel because a rebuild can run for minutes: the
 * chair with a pattern in Fill measured 93.6s for one zone and didn't finish inside 900s across
 * five. Without it the only way out was a reload.
 */
export function showOverlay(text: string, { cancellable = false } = {}): void {
  $('#loading-text').textContent = text;
  // Hidden unless the work behind the curtain checks for a cancel: the same curtain covers exports and part loads (exportPanel.ts, assembly/parts.ts), which never call throwIfCancelled, so a button there would latch to "Cancelling…" and do nothing.
  $('#loading-cancel').hidden = !cancellable;
  // Only a rebuild is cancellable, and it runs in a worker: the scene under it stays live to orbit.
  $('#loading-overlay').classList.toggle('pass-through', cancellable);
  setCancelState(false);
  $('#loading-overlay').style.display = 'flex';
}

/** Update the curtain text in place (e.g. live progress) without toggling visibility. */
export function updateOverlay(text: string): void {
  $('#loading-text').textContent = text;
}

export function hideOverlay(): void {
  $('#loading-overlay').style.display = 'none';
}

/**
 * Cancel is acknowledged immediately and takes effect at the next safe point: a yield in the 2D
 * region pass, or between two of a part's Manifold calls. On a 6000-region wheel that is 0.3s in the
 * region pass (docs/findings/2026-08-25-cancel-latency.md), 0.04-0.06s in the cut, and up to 0.29s
 * for a session's first cancel (scripts/check-cancel-latency.mjs). "Cancelling…" still separates a
 * button that looks broken on a heavy part from one visibly working.
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
