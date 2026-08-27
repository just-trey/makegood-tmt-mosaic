import { $ } from './dom';
import { track } from '../analytics/track';

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
    track('help_opened');
  });
  $('#btn-help-close').addEventListener('click', () => dialog.close());

  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });

  // One delegated listener over the TOC rather than one per anchor: the set is fixed at eight,
  // but a per-anchor listener would be the one place in this file that doesn't scale with it.
  $('.help-toc').addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('a[href^="#h-"]');
    if (a) track('help_topic_selected', { topic: a.getAttribute('href')!.slice(3) });
  });

  // The dialog's table of contents is a list of `#h-…` anchors, so following one pushes a history
  // entry. Pressing Back then returns the URL to `/` and leaves the modal sitting over an app the
  // user believes they have gone back to.
  //
  // Closing on any popstate would be wrong: Back from one section to another is navigation
  // *within* the dialog and has to leave it open. So the test is whether the hash still names a
  // section of this dialog. Landing on no hash at all (the reported case) fails that and closes.
  // `section[id]`, not `[id]` — the latter also collected the close button, so a hash of
  // `#btn-help-close` would have counted as "still in the dialog". Not reachable from any link the
  // dialog renders, but the set is meant to be its sections and it may as well be.
  const sectionIds = new Set([...dialog.querySelectorAll('section[id]')].map((el) => el.id));
  addEventListener('popstate', () => {
    if (dialog.open && !sectionIds.has(location.hash.slice(1))) dialog.close();
  });
}
