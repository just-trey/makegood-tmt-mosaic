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

  // The dialog's table of contents is a list of `#h-…` anchors, so following one pushes a history
  // entry. Pressing Back then returns the URL to `/` and leaves the modal sitting over an app the
  // user believes they have gone back to.
  //
  // Closing on any popstate would be wrong: Back from one section to another is navigation
  // *within* the dialog and has to leave it open. So the test is whether the hash still names a
  // section of this dialog. Landing on no hash at all (the reported case) fails that and closes.
  const sectionIds = new Set([...dialog.querySelectorAll('[id]')].map((el) => el.id));
  addEventListener('popstate', () => {
    if (dialog.open && !sectionIds.has(location.hash.slice(1))) dialog.close();
  });
}
