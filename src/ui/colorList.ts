import { addToBase, removeFromBase, replaceBase, state } from '../state/store';
import { requestedDepth } from '../geometry/depth';
import { scheduleRebuild } from '../app/scheduler';
import { nearestFilamentName } from '../state/filaments';
import { getPrinter } from '../export/printers';
import { refreshSlotBudgetNotice, slotTier } from './slotBudget';
import { $, $all } from './dom';

export interface ColorListEntry {
  color: string;
  key: string;
  members: string[];
  isMergeGroup: boolean;
  areaPct: number;
  isBackground: boolean;
  /** printed in the body instead of cut — a distinct status row, no depth/merge controls */
  isBase?: boolean;
}

export function groupContaining(hex: string): string[] | null {
  return state.mergeGroups.find((g) => g.includes(hex)) || null;
}

/** Merge an explicit set of raw hexes into one group, folding in any existing groups they touch.
 * An explicit (re-)merge is a stronger signal than a earlier pull-out pin, so it clears one. */
export function mergeHexes(hexes: string[]): void {
  const merged = new Set(hexes.filter(Boolean));
  if (merged.size < 2) return;
  state.mergeGroups = state.mergeGroups.filter((g) => {
    if (g.some((h) => merged.has(h))) {
      g.forEach((h) => merged.add(h));
      return false;
    }
    return true;
  });
  state.mergeGroups.push(Array.from(merged));
  merged.forEach((h) => {
    const idx = state.keptApart.indexOf(h);
    if (idx !== -1) state.keptApart.splice(idx, 1);
  });
  scheduleRebuild();
}

/** Pull one color out of whatever group it's in, leaving the rest merged, and pin it so the
 * auto-merge slider won't re-swallow it. Dragging it back onto a group (or clearKeptApart)
 * clears the pin. */
export function pullFromGroup(hex: string): void {
  state.mergeGroups = state.mergeGroups
    .map((g) => g.filter((h) => h !== hex))
    .filter((g) => g.length >= 2); // a group of 1 isn't a merge anymore
  if (!state.keptApart.includes(hex)) state.keptApart.push(hex);
  scheduleRebuild();
}

/** Un-pin a color so the auto-merge slider can consider it again. */
export function clearKeptApart(hex: string): void {
  const idx = state.keptApart.indexOf(hex);
  if (idx !== -1) {
    state.keptApart.splice(idx, 1);
    scheduleRebuild();
  }
}

/** Makes a row a valid drop target for growing the base — dragging a color or merged group onto
 * it calls addToBase instead of mergeHexes, whether the base already has members or is empty. */
function wireBaseDropTarget(row: HTMLElement): void {
  row.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';
    row.classList.add('drop-target');
  });
  row.addEventListener('dragleave', (e) => {
    if (!row.contains(e.relatedTarget as Node)) row.classList.remove('drop-target');
  });
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    row.classList.remove('drop-target');
    const src = (e.dataTransfer!.getData('text/plain') || '').split(',').filter(Boolean);
    addToBase(src);
    scheduleRebuild();
  });
}

/** The Base row: pinned at the top of the list so it never reorders, shows every color grouped
 * into it (dominant = body color) with a "×" to send one back to being cut, and doubles as a
 * drop target so dragging a color/merged group onto it grows the base instead of replacing it. */
function renderBaseRow(list: HTMLElement, c: ColorListEntry): void {
  const row = document.createElement('div');
  row.className = 'color-row is-base';
  const membersHtml = `<div class="merge-members">${c.members
    .map(
      (h) =>
        `<button type="button" class="member-swatch" data-remove-base="${h}" style="background:${h}" title="Cut ${h} as a recess again"><span class="member-x">×</span></button>`,
    )
    .join('')}</div>`;
  row.innerHTML = `
    <div class="top">
      <div class="swatch" style="background:${c.color}" title="Prints as this color (the base's dominant member)"></div>
      <div class="hex">Base — prints as the body</div>
      <div class="area">${c.areaPct.toFixed(1)}%</div>
    </div>
    ${membersHtml}`;
  row.querySelectorAll<HTMLElement>('[data-remove-base]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeFromBase(btn.dataset.removeBase!);
      scheduleRebuild();
    });
  });
  wireBaseDropTarget(row);
  list.appendChild(row);
}

/** Shown instead of the Base row when nothing's grouped into it yet, so the empty state — using
 * the plain Body / blank color picker up in Part — reads as a normal, common choice rather than a
 * gap. Still a drop target: dragging a color onto it starts the base the same way "→ base" would. */
function renderEmptyBaseRow(list: HTMLElement): void {
  const row = document.createElement('div');
  row.className = 'color-row is-base is-base-empty';
  row.innerHTML = `
    <div class="top">
      <div class="hex hint">Base — empty; body uses the blank color set in Part</div>
    </div>`;
  wireBaseDropTarget(row);
  list.appendChild(row);
}

export function renderColorList(
  colorMeshes: ColorListEntry[] | null,
  opts: { rawColorCount?: number; slotsNeeded?: number } = {},
): void {
  const list = $('#color-list');
  if (!colorMeshes || !colorMeshes.length) {
    list.innerHTML = '<div class="empty-hint">No colors detected yet.</div>';
    lastSlotsNeeded = 0;
    lastRawColorCount = 0;
    renderSlotCount();
    $('#stat-colors').textContent = '0 colors';
    $('#stat-colors').style.display = 'none';
    return;
  }
  list.innerHTML = '';
  const baseEntry = colorMeshes.find((c) => c.isBase) || null;
  const rows = colorMeshes.filter((c) => !c.isBase);
  rows.sort((a, b) => b.areaPct - a.areaPct);
  if (baseEntry) renderBaseRow(list, baseEntry);
  else renderEmptyBaseRow(list);
  // Labels for the "merge with…" dropdown below, keyed by the same joined-hex string each row
  // uses as its own drag payload (row.dataset.hexes) — so a row's own entry can be excluded and
  // picking another produces exactly what dragging one onto the other would.
  const mergeTargets = rows
    .filter((c) => !c.isBackground)
    .map((c) => ({
      key: c.members.join(','),
      label: c.isMergeGroup ? `Merged (${c.members.length})` : c.color,
    }));
  rows.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'color-row';

    // Show what was asked for, and don't write it back. Seeding colorSettings from the build's
    // depth pinned every row to the *clamped* value on the first render: the second build then
    // compared 3.95 against 3.95, went quiet, and kept cutting the wrong depth — and lowering the
    // global Depth field, the fix the warning tells you to apply, no longer reached rows that now
    // carried an explicit override. colorSettings holds deliberate per-row overrides only.
    const shownDepth = requestedDepth(state.colorSettings, state.globalDepth, c.key);

    let swatchHtml: string,
      labelHtml: string,
      rightControlHtml: string,
      membersRowHtml = '';
    if (c.isBackground) {
      swatchHtml = `<div class="swatch" style="background:${c.color}"></div>`;
      labelHtml = `Background`;
      rightControlHtml = '';
    } else if (c.isMergeGroup) {
      swatchHtml = `<div class="swatch" style="background:${c.color}" title="Prints as this color (the group's dominant member)"></div>`;
      membersRowHtml = `<div class="merge-members">${c.members
        .map(
          (h) =>
            `<button type="button" class="member-swatch" data-pull="${h}" style="background:${h}" title="Pull ${h} out of this group"><span class="member-x">×</span></button>`,
        )
        .join('')}</div>`;
      labelHtml = `Merged (${c.members.length})`;
      rightControlHtml = `<button class="btn small" data-add-base="${c.members.join(',')}" title="Print this group in the body instead of cutting it (replaces the current base — drag onto the Base row to add alongside instead)">→ base</button>`;
    } else {
      const pinned = state.keptApart.includes(c.color);
      swatchHtml = `<div class="swatch${pinned ? ' pinned' : ''}" style="background:${c.color}" ${pinned ? 'title="Pulled out of auto-merge — click to re-allow merging"' : ''}></div>`;
      labelHtml = c.color;
      rightControlHtml = `<button class="btn small" data-add-base="${c.color}" title="Print this color in the body instead of cutting it (replaces the current base — drag onto the Base row to add alongside instead)">→ base</button>`;
    }

    // Keyboard/non-drag alternative to the drag-to-merge gesture below — same effect, listed by
    // the same label a target row shows itself. Only offered when there's something else to
    // merge with, and never on Background (it isn't a mergeable color).
    const ownKey = c.members.join(',');
    const otherTargets = c.isBackground ? [] : mergeTargets.filter((t) => t.key !== ownKey);
    const mergeSelectHtml = otherTargets.length
      ? `<select class="merge-with" title="Merge this color with another — same as dragging one onto the other" aria-label="Merge ${c.isMergeGroup ? `Merged (${c.members.length})` : c.color} with another color">
          <option value="">Merge with…</option>
          ${otherTargets.map((t) => `<option value="${t.key}">${t.label}</option>`).join('')}
        </select>`
      : '';

    row.innerHTML = `
      <div class="top">
        ${c.isBackground ? '' : '<span class="drag-grip" aria-hidden="true" title="Drag to merge with another color">⠿</span>'}
        ${swatchHtml}
        <div class="hex">${labelHtml}</div>
        <div class="area">${c.areaPct.toFixed(1)}%</div>
        ${rightControlHtml}
      </div>
      ${membersRowHtml}
      <div class="depth-row">
        <label>depth</label>
        <input type="number" class="depth-input" step="0.05" value="${shownDepth.toFixed(2)}" aria-label="Depth for ${c.isBackground ? 'Background' : labelHtml}">
        <span class="hint">mm</span>
        <span class="preset">${c.isBackground ? '—' : '≈ ' + nearestFilamentName(c.color)}</span>
      </div>
      ${mergeSelectHtml ? `<div class="merge-row">${mergeSelectHtml}</div>` : ''}`;

    const mergeSelect = row.querySelector<HTMLSelectElement>('.merge-with');
    if (mergeSelect) {
      mergeSelect.addEventListener('click', (e) => e.stopPropagation());
      mergeSelect.addEventListener('change', () => {
        const targetKey = mergeSelect.value;
        if (!targetKey) return;
        mergeHexes([...ownKey.split(','), ...targetKey.split(',')].filter(Boolean));
      });
    }
    row.querySelector<HTMLInputElement>('.depth-input')!.addEventListener('change', (e) => {
      // A typed 0 or a negative used to land here as 0.1, so the build never saw the number that
      // was actually asked for and couldn't say it had been overridden. Pass anything numeric
      // through and let the geometry clamp be the one place that reports the override. Clearing
      // the field drops the override entirely, so the row goes back to following the global Depth
      // rather than sticking at a magic 0.1 nobody asked for.
      const typed = parseFloat((e.target as HTMLInputElement).value);
      if (Number.isFinite(typed)) state.colorSettings[c.key] = { depth: typed };
      else delete state.colorSettings[c.key];
      scheduleRebuild();
    });
    row.querySelectorAll<HTMLElement>('[data-pull]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        pullFromGroup(btn.dataset.pull!);
      });
    });
    const addBase = row.querySelector<HTMLElement>('[data-add-base]');
    if (addBase)
      addBase.addEventListener('click', () => {
        replaceBase(addBase.dataset.addBase!.split(','));
        scheduleRebuild();
      });
    const pinnedSwatch = row.querySelector<HTMLElement>('.swatch.pinned');
    if (pinnedSwatch) pinnedSwatch.addEventListener('click', () => clearKeptApart(c.color));

    // Drag-and-drop merge: drag one color onto another (or onto a merged group) to fuse them.
    // The draggable handle is the row's top strip so the depth field stays freely editable.
    if (!c.isBackground) {
      row.dataset.hexes = c.members.join(',');
      const handle = row.querySelector<HTMLElement>('.top')!;
      handle.setAttribute('draggable', 'true');
      handle.style.cursor = 'grab';
      handle.addEventListener('dragstart', (e) => {
        e.dataTransfer!.setData('text/plain', row.dataset.hexes!);
        e.dataTransfer!.effectAllowed = 'move';
        row.classList.add('dragging');
      });
      handle.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        $all('.color-row.drop-target').forEach((r) => r.classList.remove('drop-target'));
      });
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'move';
        row.classList.add('drop-target');
      });
      row.addEventListener('dragleave', (e) => {
        if (!row.contains(e.relatedTarget as Node)) row.classList.remove('drop-target');
      });
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drop-target');
        const src = (e.dataTransfer!.getData('text/plain') || '').split(',').filter(Boolean);
        const tgt = row.dataset.hexes!.split(',').filter(Boolean);
        if (src.join(',') === tgt.join(',')) return; // dropped onto itself
        mergeHexes([...src, ...tgt]);
      });
    }

    list.appendChild(row);
  });
  // +1 for AMS slots: the body itself always occupies one physical filament slot (materials[0] in
  // both export paths — see exportPanel.ts), on top of every cut color/group listed below the Base
  // row. The colors stat stays rows.length — it counts cut regions, not filament slots.
  //
  // slotsNeeded is passed explicitly because rows.length isn't always the export's material count:
  // in assembly mode a palette color whose inlay fits on no part is dropped from this list
  // (rebuild.ts skips area === 0) yet still ships as a 3MF material. Reporting fewer slots than the
  // export warns about is the worse failure, so the caller's number wins where it has one.
  const cutColors = rows.length;
  lastSlotsNeeded = opts.slotsNeeded ?? cutColors + 1;
  lastRawColorCount = opts.rawColorCount ?? cutColors;
  renderSlotCount();
  $('#stat-colors').textContent = cutColors + ' colors';
  $('#stat-colors').style.display = '';
}

// Cached across renders so refreshSlotCountCapacity() (called when the printer picker changes,
// which doesn't itself trigger a rebuild) can redraw the slot line without rebuilding the list.
let lastSlotsNeeded = 0;
let lastRawColorCount = 0;

function renderSlotCount(): void {
  const el = $('#slot-count');
  refreshSlotBudgetNotice(lastSlotsNeeded);
  if (!lastSlotsNeeded) {
    el.textContent = '';
    el.classList.remove('over-capacity', 'multi-unit');
    el.removeAttribute('title');
    return;
  }
  // Always shown together, even when raw === cut colors (the common unmerged case) — seeing the
  // slot count alone reads as a bug the first time the +1-for-body offset shows up; the arrow
  // makes the relationship self-explanatory every time, not just after a merge changes the count.
  el.textContent =
    `${lastRawColorCount} color${lastRawColorCount === 1 ? '' : 's'} → ` +
    `${lastSlotsNeeded} AMS slot${lastSlotsNeeded === 1 ? '' : 's'} needed`;
  // Same slotTier() the pill above is posted from, so the line's color and the pill can't disagree
  const printer = getPrinter(state.printerId);
  const tier = slotTier(lastSlotsNeeded, printer);
  el.classList.toggle('over-capacity', tier === 'over-max');
  el.classList.toggle('multi-unit', tier === 'multi-unit');
  el.title =
    tier === 'over-max'
      ? `More than the ${printer.amsSlotsMax} slots this printer can print in one go.`
      : tier === 'multi-unit'
        ? `More than the ${printer.amsSlotsPerUnit} slots in a single AMS unit — printable, but ` +
          `needs more than one unit (up to ${printer.amsSlotsMax}) or manual filament swaps.`
        : `Fits a single ${printer.amsSlotsPerUnit}-slot AMS unit.`;
}

/** Redraw the slot-count line against the current printer's AMS capacity — the counterpart to
 * refreshAutoMergeControl() etc. for this control. Needed because changing the printer picker
 * doesn't schedule a rebuild (it doesn't affect geometry), so nothing else would refresh this. */
export function refreshSlotCountCapacity(): void {
  renderSlotCount();
}

function updateAutoMergeLabels(level: number): void {
  $all('#automerge-labels span').forEach((el, i) => el.classList.toggle('active', i === level));
}

/** Push state.autoMergeLevel into the slider + label DOM — the counterpart to
 * refreshFitInputsFromState() for this control, needed by session restore (state/persist.ts),
 * which sets autoMergeLevel directly rather than through the slider's own input handler. */
export function refreshAutoMergeControl(): void {
  $<HTMLInputElement>('#p-automerge').value = String(state.autoMergeLevel);
  updateAutoMergeLabels(state.autoMergeLevel);
}

export function initColorListPanel(): void {
  const slider = $<HTMLInputElement>('#p-automerge');
  slider.value = String(state.autoMergeLevel);
  updateAutoMergeLabels(state.autoMergeLevel);
  slider.addEventListener('input', () => {
    state.autoMergeLevel = parseInt(slider.value, 10) || 0;
    updateAutoMergeLabels(state.autoMergeLevel);
    scheduleRebuild();
  });
}
