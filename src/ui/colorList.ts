import { addToBase, removeFromBase, replaceBase, state } from '../state/store';
import { scheduleRebuild } from '../app/scheduler';
import { nearestFilamentName } from '../state/filaments';
import { $, $all } from './dom';

export interface ColorListEntry {
  color: string;
  key: string;
  members: string[];
  isMergeGroup: boolean;
  depth: number;
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
  opts: { rawColorCount?: number } = {},
): void {
  const list = $('#color-list');
  if (!colorMeshes || !colorMeshes.length) {
    list.innerHTML = '<div class="empty-hint">No colors detected yet.</div>';
    $('#slot-count').textContent = '';
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
  rows.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'color-row';

    if (!state.colorSettings[c.key]) state.colorSettings[c.key] = { depth: c.depth };

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

    row.innerHTML = `
      <div class="top">
        ${swatchHtml}
        <div class="hex">${labelHtml}</div>
        <div class="area">${c.areaPct.toFixed(1)}%</div>
        ${rightControlHtml}
      </div>
      ${membersRowHtml}
      <div class="depth-row">
        <label>depth</label>
        <input type="number" class="depth-input" step="0.05" min="0.05" value="${state.colorSettings[c.key].depth.toFixed(2)}">
        <span class="hint">mm</span>
        <span class="preset">${c.isBackground ? '—' : '≈ ' + nearestFilamentName(c.color)}</span>
      </div>`;
    row.querySelector<HTMLInputElement>('.depth-input')!.addEventListener('change', (e) => {
      state.colorSettings[c.key] = {
        depth: parseFloat((e.target as HTMLInputElement).value) || 0.1,
      };
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
  const cutColors = rows.length;
  const slots = cutColors + 1;
  const raw = opts.rawColorCount;
  $('#slot-count').textContent =
    raw && raw !== slots
      ? `${raw} colors → ${slots} AMS slot${slots === 1 ? '' : 's'} needed`
      : slots + ' AMS slot' + (slots === 1 ? '' : 's') + ' needed';
  $('#stat-colors').textContent = cutColors + ' colors';
  $('#stat-colors').style.display = '';
}

function updateAutoMergeLabels(level: number): void {
  $all('#automerge-labels span').forEach((el, i) => el.classList.toggle('active', i === level));
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
