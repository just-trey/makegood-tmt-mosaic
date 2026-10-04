import { $ } from './dom';

/**
 * Themed replacements for window.confirm()/alert(), the pattern helpPanel.ts sets for #help-dialog:
 * a native <dialog> styled to the app. One shared element covers both (Cancel hides itself for an
 * alert) since these are always sequential, never concurrent.
 */

let resolveFn: ((confirmed: boolean) => void) | null = null;

function getDialog(): HTMLDialogElement {
  return $<HTMLDialogElement>('#confirm-dialog');
}

function show(message: string, okLabel: string, cancelLabel: string | null): Promise<boolean> {
  const dialog = getDialog();
  $('#confirm-message').textContent = message;
  $<HTMLButtonElement>('#confirm-ok').textContent = okLabel;
  const cancelBtn = $<HTMLButtonElement>('#confirm-cancel');
  cancelBtn.style.display = cancelLabel ? '' : 'none';
  if (cancelLabel) cancelBtn.textContent = cancelLabel;

  return new Promise<boolean>((resolve) => {
    resolveFn = resolve;
    dialog.showModal();
  });
}

/** Replaces `confirm(message)` — resolves true on OK, false on Cancel or Escape. */
export function confirmDialog(
  message: string,
  confirmLabel = 'Continue',
  cancelLabel = 'Cancel',
): Promise<boolean> {
  return show(message, confirmLabel, cancelLabel);
}

/** Replaces `alert(message)` — resolves once the user dismisses it. */
export async function alertDialog(message: string, okLabel = 'OK'): Promise<void> {
  await show(message, okLabel, null);
}

export function initConfirmDialog(): void {
  const dialog = getDialog();
  const settle = (confirmed: boolean): void => {
    dialog.close();
    resolveFn?.(confirmed);
    resolveFn = null;
  };
  $('#confirm-ok').addEventListener('click', () => settle(true));
  $('#confirm-cancel').addEventListener('click', () => settle(false));
  // Escape fires the dialog's native 'cancel' and closes it; resolve the promise to match (window.confirm()'s Escape-means-Cancel).
  dialog.addEventListener('cancel', () => {
    resolveFn?.(false);
    resolveFn = null;
  });
}
