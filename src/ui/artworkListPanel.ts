import { state } from '../state/store';
import { clearArtwork } from '../state/artwork';
import { scheduleRebuild } from '../app/scheduler';
import { track } from '../analytics/track';
import { $ } from './dom';

/**
 * The loaded-artwork list under the dropzone: one row per DesignSource. Today there's always at
 * most one (multi-source loading lands with the pattern library / multi-zone parts), so this
 * mostly reads as a single "currently loaded" row with a remove button — the one capability this
 * adds today that didn't exist before. Row targeting (which zone an instance is placed on) will
 * light up once a part can declare more than its one implicit zone (see the chair-body plan).
 */
export function renderArtworkList(): void {
  const list = $('#artwork-list');
  list.innerHTML = '';
  if (!state.sources.length) {
    list.style.display = 'none';
    return;
  }
  list.style.display = '';
  state.sources.forEach((source) => {
    const row = document.createElement('div');
    row.className = 'artwork-row';
    row.innerHTML = `
      <span class="artwork-name"></span>
      <button type="button" class="btn small artwork-remove" title="Remove this artwork">×</button>
    `;
    // set via textContent, not innerHTML — the source name is a user-supplied filename
    row.querySelector<HTMLElement>('.artwork-name')!.textContent = source.name;
    row.querySelector<HTMLButtonElement>('.artwork-remove')!.addEventListener('click', () => {
      clearArtwork();
      $('#svg-fname').textContent = '';
      renderArtworkList();
      scheduleRebuild();
      track('artwork_removed');
    });
    list.appendChild(row);
  });
}
