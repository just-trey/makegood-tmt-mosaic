import { $ } from './dom';
import { cancelRequested, requestCancel } from '../cancel';

/**
 * The "Rebuilding geometry…" curtain.
 *
 * It carries a Cancel because a rebuild here can run for minutes: the chair with a pattern in Fill
 * measured 93.6s for one zone and did not finish inside 900s across five. Without it the only way
 * out was a reload, which until session restore landed took every setting with it.
 */
export function showOverlay(text: string, { cancellable = false } = {}): void {
  $('#loading-text').textContent = text;
  // Hidden unless the thing behind the curtain actually checks for a cancel. The same curtain
  // covers exports and part loads (exportPanel.ts, assembly/parts.ts), and neither calls
  // throwIfCancelled, so a button there would latch to "Cancelling…" and change nothing.
  $('#loading-cancel').hidden = !cancellable;
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
 * region pass, or the boundary between two of a part's Manifold calls. On a 6000-region wheel that
 * is 0.3s in the region pass (docs/findings/2026-08-25-cancel-latency.md) and 0.04-0.06s in the
 * cut, or up to 0.29s for the first cancel of a session (scripts/check-cancel-latency.mjs). Saying "Cancelling…" is still the difference between a button
 * that looks broken on a heavy part and one that is visibly working.
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
