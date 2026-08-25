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
 * Cancel is acknowledged immediately and takes effect at the next safe point. On a detailed
 * design that is within a fraction of a second, since most of the wait is the 2D region pass;
 * once the cutting itself has started it is the end of the part being cut. Saying "Cancelling…"
 * is the difference between a button that looks broken for a few seconds and one that is visibly
 * working.
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
