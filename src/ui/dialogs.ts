import { $ } from './dom';

/**
 * Themed replacements for window.confirm()/alert() — same pattern helpPanel.ts already
 * establishes for #help-dialog: a native <dialog> styled to match the app instead of the
 * browser's own jarring, unstyled prompt. One shared <dialog> element covers both cases (the
 * Cancel button just hides itself for an alert) since these are always sequential, never
 * concurrent, user-triggered actions.
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
  // Escape fires the dialog's native 'cancel' event and closes it on its own — just resolve the
  // promise to match, same as window.confirm()'s Escape-means-Cancel behavior.
  dialog.addEventListener('cancel', () => {
    resolveFn?.(false);
    resolveFn = null;
  });
}
