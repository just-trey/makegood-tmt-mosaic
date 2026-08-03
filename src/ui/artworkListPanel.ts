import { state } from '../state/store';
import {
  addInstanceForSource,
  availableZones,
  removeArtworkInstance,
  setActiveArtwork,
  setArtworkMode,
  setArtworkZone,
} from '../state/artwork';
import { scheduleRebuild } from '../app/scheduler';
import { refreshFitInputsFromState } from './fitPanel';
import { refreshGizmo } from '../scene/designGizmo';
import { track } from '../analytics/track';
import { $ } from './dom';

/**
 * The loaded-artwork list under the dropzone: one row per ArtworkInstance (not per source — a
 * source can back more than one instance once it's placed on a second zone). Clicking a row makes
 * it active, which repoints the fit sliders/gizmo at it (see setActiveArtwork). The zone dropdown
 * only appears once the current part actually offers pickable zones (availableZones() is empty for
 * a single-face part like the wheel or footrest, where there's nothing to choose between).
 */
export function renderArtworkList(): void {
  const list = $('#artwork-list');
  list.innerHTML = '';
  if (!state.artworks.length) {
    list.style.display = 'none';
    return;
  }
  list.style.display = '';
  const zones = availableZones();
  // Fill repeats the design across a zone, which only the assembly-mode cut pipeline implements —
  // a flat plate would show the control and then ignore it.
  const canFill = state.shapeKind === 'assembly';

  state.artworks.forEach((a) => {
    const source = state.sources.find((s) => s.id === a.sourceId);
    const row = document.createElement('div');
    row.className = 'artwork-row' + (a.id === state.activeArtworkId ? ' active' : '');
    row.innerHTML = `
      <span class="artwork-name"></span>
      ${zones.length ? '<span class="artwork-zone-badge"></span>' : ''}
      ${
        canFill
          ? '<select class="artwork-mode" title="Place one copy of this design, or repeat it across the whole surface" aria-label="Placement mode: Sticker or Fill"></select>'
          : ''
      }
      ${zones.length ? '<select class="artwork-zone" aria-label="Target zone"></select>' : ''}
      ${
        zones.length
          ? '<button type="button" class="btn small artwork-add-zone" title="Place this design on another zone" aria-label="Place this design on another zone">+zone</button>'
          : ''
      }
      <button type="button" class="btn small artwork-remove" title="Remove this artwork" aria-label="Remove this artwork">×</button>
    `;
    // set via textContent, not innerHTML — the source name is a user-supplied filename
    row.querySelector<HTMLElement>('.artwork-name')!.textContent = source?.name ?? '(missing)';

    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('select, button')) return;
      if (a.id === state.activeArtworkId) return;
      setActiveArtwork(a.id);
      renderArtworkList();
      refreshFitInputsFromState();
      refreshGizmo();
    });

    const modeSel = row.querySelector<HTMLSelectElement>('.artwork-mode');
    if (modeSel) {
      modeSel.innerHTML =
        '<option value="sticker">Sticker</option><option value="fill">Fill</option>';
      modeSel.value = a.mode;
      modeSel.addEventListener('click', (e) => e.stopPropagation());
      modeSel.addEventListener('change', () => {
        const mode = modeSel.value === 'fill' ? 'fill' : 'sticker';
        setArtworkMode(a.id, mode);
        scheduleRebuild();
        track('artwork_mode_changed', { mode });
      });
    }

    const zoneBadge = row.querySelector<HTMLElement>('.artwork-zone-badge');
    const updateZoneBadge = (): void => {
      if (!zoneBadge) return;
      const zoneName = zones.find((z) => z.zoneId === a.zone?.zoneId)?.name;
      zoneBadge.textContent = '→ ' + (zoneName ?? 'All zones');
    };
    updateZoneBadge();

    const zoneSel = row.querySelector<HTMLSelectElement>('.artwork-zone');
    if (zoneSel) {
      zoneSel.innerHTML =
        '<option value="">All zones</option>' +
        zones.map((z) => `<option value="${z.zoneId}">${z.name}</option>`).join('');
      zoneSel.value = a.zone?.zoneId ?? '';
      zoneSel.addEventListener('click', (e) => e.stopPropagation());
      zoneSel.addEventListener('change', () => {
        setArtworkZone(a.id, zoneSel.value || null);
        updateZoneBadge();
        scheduleRebuild();
        track('artwork_instance_zone_changed', { zone: zoneSel.value || 'all' });
      });
    }

    const addZoneBtn = row.querySelector<HTMLButtonElement>('.artwork-add-zone');
    if (addZoneBtn)
      addZoneBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Land the new placement on the first zone nothing from this source is already bound to,
        // falling back to "all zones" if every zone already has one — a reasonable starting guess
        // the user can immediately retarget from the new row's own dropdown.
        const used = new Set(
          state.artworks.filter((x) => x.sourceId === a.sourceId).map((x) => x.zone?.zoneId),
        );
        const next = zones.find((z) => !used.has(z.zoneId));
        addInstanceForSource(a.sourceId, next?.zoneId ?? null);
        renderArtworkList();
        refreshFitInputsFromState();
        refreshGizmo();
        scheduleRebuild();
        track('artwork_instance_added');
      });

    row.querySelector<HTMLButtonElement>('.artwork-remove')!.addEventListener('click', (e) => {
      e.stopPropagation();
      removeArtworkInstance(a.id);
      $('#svg-fname').textContent = '';
      renderArtworkList();
      refreshFitInputsFromState();
      refreshGizmo();
      scheduleRebuild();
      track('artwork_removed');
    });
    list.appendChild(row);
  });
}
