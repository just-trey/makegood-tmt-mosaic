// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { hideOverlay, initOverlay, showOverlay } from '../src/ui/overlay';
import { armCancel, cancelRequested } from '../src/cancel';

const html = `
  <div id="loading-overlay" style="display:none">
    <div id="loading-text"></div>
    <button id="loading-cancel">Cancel</button>
  </div>`;

describe('the rebuild curtain', () => {
  beforeEach(() => {
    document.body.innerHTML = html;
    armCancel();
  });

  it('offers no Cancel by default', () => {
    // The same curtain covers exports, part loads and flat rebuilds, and none of them checks for
    // a cancel. A button there would latch to "Cancelling…" and change nothing.
    showOverlay('Exporting…');
    expect(document.querySelector<HTMLElement>('#loading-cancel')!.hidden).toBe(true);
  });

  it('offers Cancel when the work behind it can be cancelled', () => {
    showOverlay('Rebuilding geometry…', { cancellable: true });
    expect(document.querySelector<HTMLElement>('#loading-cancel')!.hidden).toBe(false);
  });

  it('acknowledges the press, since the cancel lands a part later', () => {
    initOverlay();
    showOverlay('Rebuilding geometry…', { cancellable: true });
    const btn = document.querySelector<HTMLButtonElement>('#loading-cancel')!;
    btn.click();
    expect(cancelRequested()).toBe(true);
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe('Cancelling…');
  });

  it('resets the button for the next rebuild', () => {
    initOverlay();
    showOverlay('Rebuilding geometry…', { cancellable: true });
    document.querySelector<HTMLButtonElement>('#loading-cancel')!.click();
    hideOverlay();
    armCancel();
    showOverlay('Rebuilding geometry…', { cancellable: true });
    const btn = document.querySelector<HTMLButtonElement>('#loading-cancel')!;
    // Left disabled, the next long rebuild would be uncancellable with no sign why.
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Cancel');
  });
});
