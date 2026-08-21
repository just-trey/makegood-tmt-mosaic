import type { DesignSource, RasterState } from '../types';
import { state } from '../state/store';
import {
  addInstanceForSource,
  availableZones,
  isRasterSource,
  removeArtworkInstance,
  requantizeSource,
  setActiveArtwork,
  setArtworkMode,
  setArtworkZone,
} from '../state/artwork';
import { fillModeOffered } from '../assembly/kinds';
import { MAX_COLORS, MIN_COLORS } from '../raster/quantize';
import { rasterCappedMessage } from '../raster/parse';
import { dismissNotice, notice, warn } from '../warnings';
import { renderWarnings } from './warningsView';
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
  const rasterBlocksDrawn = new Set<string>();
  // Fill repeats the design across a zone, which only the assembly-mode cut pipeline implements —
  // a flat plate would show the control and then ignore it. A kind carrying `withholdFill` opts out
  // too; fillModeOffered() covers both.
  const canFill = fillModeOffered();

  state.artworks.forEach((a) => {
    const source = state.sources.find((s) => s.id === a.sourceId);
    const row = document.createElement('div');
    row.className = 'artwork-row' + (a.id === state.activeArtworkId ? ' active' : '');
    row.innerHTML = `
      <span class="artwork-name"></span>
      ${zones.length ? '<span class="artwork-zone-badge"></span>' : ''}
      ${
        canFill
          ? '<select class="artwork-mode" title="Place one copy of this design, or repeat it across the whole design face" aria-label="Placement mode: Sticker or Fill"></select>'
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
      // A capped notice names its image, so it has to go with the last instance of it — otherwise
      // it stands there pointing at a file that is no longer loaded.
      if (source && !state.sources.some((s) => s.id === source.id))
        dismissNotice(rasterCappedMessage(source.name));
      renderWarnings();
      $('#svg-fname').textContent = '';
      renderArtworkList();
      refreshFitInputsFromState();
      refreshGizmo();
      scheduleRebuild();
      track('artwork_removed');
    });
    list.appendChild(row);

    // Colors/Detail belong to the image, not to this placement of it, so the block is emitted once
    // per source however many rows that source backs.
    if (source && isRasterSource(source) && !rasterBlocksDrawn.has(source.id)) {
      rasterBlocksDrawn.add(source.id);
      list.appendChild(rasterControls(source));
    }
  });
}

/**
 * The two per-image controls.
 *
 * Both re-quantize on `change` (drag release), never on `input`: re-tracing an image is far heavier
 * than the fit sliders' arithmetic, and running it per pointer-move would stall the drag. The
 * readout updates live so the slider still feels connected while it's moving.
 */
function rasterControls(source: DesignSource & { raster: RasterState }): HTMLElement {
  const block = document.createElement('div');
  block.className = 'artwork-raster';
  block.innerHTML = `
    <div class="row">
      <label for="raster-colors-${source.id}">Colors</label>
      <input type="range" id="raster-colors-${source.id}" class="raster-colors"
             min="${MIN_COLORS}" max="${MAX_COLORS}" step="1" />
    </div>
    <div class="row">
      <label for="raster-detail-${source.id}">Detail</label>
      <input type="range" id="raster-detail-${source.id}" class="raster-detail"
             min="0" max="100" step="5" />
    </div>
    <div class="raster-readout"></div>
  `;
  block.addEventListener('click', (e) => e.stopPropagation());

  const colors = block.querySelector<HTMLInputElement>('.raster-colors')!;
  const detail = block.querySelector<HTMLInputElement>('.raster-detail')!;
  const readout = block.querySelector<HTMLElement>('.raster-readout')!;
  colors.value = String(source.raster.colors);
  detail.value = String(source.raster.detail);

  // What the image actually resolved to, which is not always what was asked for: a three-color logo
  // stays three colors however high Colors goes, and saying so beats looking broken.
  const describe = () =>
    `${source.raster.palette.length} colors · ${source.raster.regions} regions`;
  readout.textContent = describe();

  /** False when the trace threw and the sliders were put back, so the caller does not log it. */
  const apply = (patch: { colors?: number; detail?: number }): boolean => {
    let result;
    try {
      result = requantizeSource(source.id, patch);
    } catch (e) {
      // A trace can legitimately come back with nothing (see parseRasterImage), and these sliders
      // are the one place that walks into it on purpose. Uncaught, the listener died with the
      // readout stuck on "recomputing on release" and no rebuild, which reads as a frozen app.
      colors.value = String(source.raster.colors);
      detail.value = String(source.raster.detail);
      readout.textContent = describe();
      warn((e as Error).message);
      renderWarnings();
      return false;
    }
    if (!result) return false;
    if (result.capped) notice(rasterCappedMessage(source.name));
    else dismissNotice(rasterCappedMessage(source.name));
    renderWarnings();
    readout.textContent = describe();
    scheduleRebuild();
    return true;
  };

  colors.addEventListener('input', () => {
    readout.textContent = `${colors.value} colors · recomputing on release`;
  });
  colors.addEventListener('change', () => {
    if (apply({ colors: parseInt(colors.value, 10) })) track('raster_adjust', { field: 'colors' });
  });
  detail.addEventListener('change', () => {
    if (apply({ detail: parseInt(detail.value, 10) })) track('raster_adjust', { field: 'detail' });
  });
  return block;
}
