// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { alertDialog, confirmDialog, initConfirmDialog } from '../src/ui/dialogs';

// jsdom doesn't implement HTMLDialogElement.showModal()/close() (as of the version this repo
// pins) -- stub both so the module's real logic (message text, button labels, promise
// resolution) can be exercised without a real dialog backing it.
function stubDialogMethods(dialog: HTMLDialogElement): void {
  dialog.showModal = function () {
    this.setAttribute('open', '');
  };
  dialog.close = function () {
    this.removeAttribute('open');
  };
}

beforeEach(() => {
  document.body.innerHTML = `
    <dialog id="confirm-dialog">
      <p id="confirm-message"></p>
      <div class="confirm-actions">
        <button type="button" id="confirm-cancel">Cancel</button>
        <button type="button" id="confirm-ok">OK</button>
      </div>
    </dialog>
  `;
  stubDialogMethods(document.querySelector('#confirm-dialog')!);
  initConfirmDialog();
});

describe('confirmDialog', () => {
  it('shows the message and resolves true when OK is clicked', async () => {
    const result = confirmDialog('Switching parts will clear the currently loaded ones.');
    expect(document.querySelector('#confirm-message')!.textContent).toBe(
      'Switching parts will clear the currently loaded ones.',
    );
    expect(document.querySelector<HTMLButtonElement>('#confirm-cancel')!.style.display).not.toBe(
      'none',
    );

    document.querySelector<HTMLButtonElement>('#confirm-ok')!.click();

    expect(await result).toBe(true);
  });

  it('resolves false when Cancel is clicked', async () => {
    const result = confirmDialog(
      'Load the full Chair body? This clears any parts you already added.',
    );
    document.querySelector<HTMLButtonElement>('#confirm-cancel')!.click();
    expect(await result).toBe(false);
  });

  it('resolves false when the dialog is cancelled (Escape)', async () => {
    const result = confirmDialog('Continue?');
    document.querySelector('#confirm-dialog')!.dispatchEvent(new Event('cancel'));
    expect(await result).toBe(false);
  });

  it('uses custom confirm/cancel labels when given', async () => {
    const result = confirmDialog('Switch variant?', 'Switch', 'Keep current');
    expect(document.querySelector('#confirm-ok')!.textContent).toBe('Switch');
    expect(document.querySelector('#confirm-cancel')!.textContent).toBe('Keep current');
    document.querySelector<HTMLButtonElement>('#confirm-ok')!.click();
    expect(await result).toBe(true);
  });
});

describe('alertDialog', () => {
  it('shows the message with no Cancel button, and resolves once dismissed', async () => {
    const result = alertDialog('Export failed: out of memory.');
    expect(document.querySelector('#confirm-message')!.textContent).toBe(
      'Export failed: out of memory.',
    );
    expect(document.querySelector<HTMLButtonElement>('#confirm-cancel')!.style.display).toBe(
      'none',
    );

    document.querySelector<HTMLButtonElement>('#confirm-ok')!.click();

    await expect(result).resolves.toBeUndefined();
  });
});
