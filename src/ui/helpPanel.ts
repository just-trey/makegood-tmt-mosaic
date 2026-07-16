import { $ } from './dom';

const SEEN_KEY = 'tmt-mosaic:help-seen';

function hasSeenHelp(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function markHelpSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // Storage unavailable (private browsing, disabled) — badge just re-shows next visit.
  }
}

export function initHelpPanel(): void {
  const dialog = $<HTMLDialogElement>('#help-dialog');
  const badge = $('#btn-help-badge');

  if (!hasSeenHelp()) badge.classList.add('show');

  $('#btn-help').addEventListener('click', () => {
    dialog.showModal();
    badge.classList.remove('show');
    markHelpSeen();
  });
  $('#btn-help-close').addEventListener('click', () => dialog.close());

  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
}
