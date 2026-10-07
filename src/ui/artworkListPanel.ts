import type { DesignSource, RasterState } from '../types';
import { state } from '../state/store';
import {
  addInstanceForSource,
  announceTrace,
  availableZones,
  isRasterSource,
  netZones,
  removeArtworkInstance,
  requantizeSource,
  setActiveArtwork,
  setArtworkMirror,
  setArtworkMode,
  setArtworkZone,
  fillClampKey,
} from '../state/artwork';
import { WHOLE_CHAIR_ZONE } from '../geometry/zones';
import { fillModeOffered } from '../assembly/kinds';
import { MAX_COLORS, MIN_COLORS } from '../raster/quantize';
import { DETAIL_MAX, DETAIL_MIN } from '../raster/stats';
import { rasterCappedMessage, rasterColorLossKey } from '../raster/parse';
import { dismissNotice, warn } from '../warnings';
import { renderWarnings } from './warningsView';
import { scheduleRebuild } from '../app/scheduler';
import { refreshNetYieldOverlays } from '../app/rebuild';
import { refreshFitInputsFromState } from './fitPanel';
import { refreshGizmo } from '../scene/designGizmo';
import { track } from '../analytics/track';
import { $ } from './dom';

/** Retract a source's dropped-color notice. Text is passed empty because the key decides which entry goes (warnings.ts); the count it named isn't known at either call site. */
function dismissColorLoss(sourceId: string): void {
  dismissNotice('', rasterColorLossKey(sourceId));
}

/** Makes `id` the edited row and brings every panel that follows the active artwork along. */
export function selectArtwork(id: string): void {
  setActiveArtwork(id);
  renderArtworkList();
  refreshFitInputsFromState();
  refreshGizmo();
  // The yielded-canvas hatch is true only while a whole-part row is edited, and selecting is the only change of that row that schedules no rebuild.
  refreshNetYieldOverlays();
}

/**
 * The loaded-artwork list under the dropzone: one row per ArtworkInstance (not per source — a source
 * can back several once placed on a second zone). Clicking a row makes it active, repointing the fit
 * sliders/gizmo (setActiveArtwork). The zone dropdown appears only when the part offers pickable
 * zones (availableZones() is empty for a single-face wheel or footrest).
 */
export function renderArtworkList(): void {
  const list = $('#artwork-list');
  list.innerHTML = '';
  const active = state.artworks.find((x) => x.id === state.activeArtworkId);
  // Derived here, not written per action: restore and remove both left it stale when each set it themselves.
  $('#svg-fname').textContent = state.sources.find((s) => s.id === active?.sourceId)?.name ?? '';
  if (!state.artworks.length) {
    list.style.display = 'none';
    return;
  }
  list.style.display = '';
  const zones = availableZones();
  const rasterBlocksDrawn = new Set<string>();
  // A kind carrying `withholdFill` doesn't offer Fill; fillModeOffered() says which.
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
      ${zones.length ? '<span class="artwork-mirror"></span>' : ''}
      <button type="button" class="btn small artwork-remove" title="Remove this artwork" aria-label="Remove this artwork">×</button>
    `;
    // set via textContent, not innerHTML — the source name is a user-supplied filename
    row.querySelector<HTMLElement>('.artwork-name')!.textContent = source?.name ?? '(missing)';

    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('select, button')) return;
      if (a.id === state.activeArtworkId) return;
      selectArtwork(a.id);
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
      const zoneInfo = zones.find((z) => z.zoneId === a.zone?.zoneId);
      const zoneName = zoneInfo?.name ?? 'All zones';
      if (a.mirror && zoneInfo?.mirror) {
        const mirror = zoneInfo.mirror;
        const twinName =
          'twin' in mirror ? zones.find((z) => z.zoneId === mirror.twin)?.name : undefined;
        zoneBadge.textContent =
          twinName !== undefined
            ? `→ ${zoneName} + ${twinName} (mirrored)`
            : `→ ${zoneName} (mirrored)`;
      } else {
        zoneBadge.textContent = '→ ' + zoneName;
      }
    };
    updateZoneBadge();

    const mirrorWrap = row.querySelector<HTMLElement>('.artwork-mirror');
    const updateMirrorControl = (): void => {
      if (!mirrorWrap) return;
      const zoneInfo = zones.find((z) => z.zoneId === a.zone?.zoneId);
      const mirror = zoneInfo?.mirror;
      if (!mirror) {
        mirrorWrap.innerHTML = '';
        return;
      }
      const kind: 'twin' | 'centre' = 'twin' in mirror ? 'twin' : 'centre';
      const title =
        'twin' in mirror
          ? `Also cut this design on the ${zones.find((z) => z.zoneId === mirror.twin)?.name ?? 'twin zone'}, mirrored`
          : `Mirror this design across the centre line of the ${zoneInfo!.name}`;
      mirrorWrap.innerHTML =
        '<label class="artwork-mirror-label"><input type="checkbox" class="artwork-mirror-check" /> Mirror</label>';
      const check = mirrorWrap.querySelector<HTMLInputElement>('.artwork-mirror-check')!;
      // Properties, not interpolation: the title carries a zone name (same reason `.artwork-name` uses textContent above).
      check.title = title;
      check.setAttribute('aria-label', title);
      check.checked = !!a.mirror;
      check.addEventListener('click', (e) => e.stopPropagation());
      check.addEventListener('change', () => {
        setArtworkMirror(a.id, check.checked);
        updateZoneBadge();
        scheduleRebuild();
        track('artwork_mirror_toggled', { on: check.checked, kind });
      });
    };
    updateMirrorControl();

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
        updateMirrorControl();
        scheduleRebuild();
        // The reserved id is plumbing, not for analytics — same reason it's "Whole chair" wherever a user reads it.
        track('artwork_instance_zone_changed', {
          zone: zoneSel.value === WHOLE_CHAIR_ZONE ? 'whole' : zoneSel.value || 'all',
        });
      });
    }

    const addZoneBtn = row.querySelector<HTMLButtonElement>('.artwork-add-zone');
    if (addZoneBtn)
      addZoneBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Land the new placement on the first zone nothing from this source is bound to, else "all
        // zones" — a starting guess retargetable from the new row. A mirrored instance already cuts on
        // its twin, so that counts as used, or +zone would offer a zone the source is on. A whole-part
        // instance cuts on every zone the net places (zoneCoverage), using up all of them.
        const used = new Set<string | undefined>();
        const netZoneList = netZones()?.zones ?? [];
        state.artworks
          .filter((x) => x.sourceId === a.sourceId)
          .forEach((x) => {
            used.add(x.zone?.zoneId);
            if (x.zone?.zoneId === WHOLE_CHAIR_ZONE)
              for (const z of netZoneList) used.add(z.zoneId);
            if (x.mirror && x.zone) {
              const mirror = zones.find((z) => z.zoneId === x.zone!.zoneId)?.mirror;
              if (mirror && 'twin' in mirror) used.add(mirror.twin);
            }
          });
        // Never auto-picked, like the initial load (setArtworkZone's default): Whole chair would stamp every net zone at once, the opposite of "another zone". Still reachable from the new row's dropdown.
        const next = zones.find((z) => z.zoneId !== WHOLE_CHAIR_ZONE && !used.has(z.zoneId));
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
      // A capped/traced notice names its image, so it goes with the last instance, or it points at an unloaded file. One dismiss keyed on the source id removes whichever it holds; the passed text is irrelevant once keyed.
      if (source && !state.sources.some((s) => s.id === source.id)) {
        dismissNotice(rasterCappedMessage(source.name), source.id);
        dismissColorLoss(source.id);
        dismissNotice('', fillClampKey(source.id));
      }
      renderWarnings();
      renderArtworkList();
      refreshFitInputsFromState();
      refreshGizmo();
      scheduleRebuild();
      track('artwork_removed');
    });
    list.appendChild(row);

    // Colors/Detail belong to the image, not a placement of it, so the block is emitted once per source however many rows it backs.
    if (source && isRasterSource(source) && !rasterBlocksDrawn.has(source.id)) {
      rasterBlocksDrawn.add(source.id);
      list.appendChild(rasterControls(source));
    }
  });
}

/**
 * The two per-image controls. Both re-quantize on `change` (drag release), never `input`:
 * re-tracing is far heavier than the fit sliders' arithmetic and would stall the drag. The readout
 * updates live so the slider still feels connected.
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
             min="${DETAIL_MIN}" max="${DETAIL_MAX}" step="5" />
    </div>
    <div class="raster-readout"></div>
  `;
  block.addEventListener('click', (e) => e.stopPropagation());

  const colors = block.querySelector<HTMLInputElement>('.raster-colors')!;
  const detail = block.querySelector<HTMLInputElement>('.raster-detail')!;
  const readout = block.querySelector<HTMLElement>('.raster-readout')!;
  colors.value = String(source.raster.colors);
  detail.value = String(source.raster.detail);

  // What the image resolved to, not always what was asked: a three-color logo stays three however high Colors goes, and saying so beats looking broken.
  const describe = () =>
    `${source.raster.palette.length} colors · ${source.raster.regions} regions`;
  readout.textContent = describe();

  /** False when the trace threw and the sliders were put back, so the caller does not log it. */
  const apply = (patch: { colors?: number; detail?: number }): boolean => {
    let result;
    try {
      result = requantizeSource(source.id, patch);
    } catch (e) {
      // A trace can legitimately come back empty (parseRasterImage) and these sliders walk into it on
      // purpose. Uncaught, the listener died with the readout stuck on "recomputing on release" and
      // no rebuild — a frozen-looking app.
      colors.value = String(source.raster.colors);
      detail.value = String(source.raster.detail);
      readout.textContent = describe();
      // Same key as the capped/traced notices, so the warn takes over whichever of them stands.
      dismissColorLoss(source.id);
      warn((e as Error).message, source.id);
      renderWarnings();
      return false;
    }
    if (!result) return false;
    announceTrace(source.id, source.name, result);
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
