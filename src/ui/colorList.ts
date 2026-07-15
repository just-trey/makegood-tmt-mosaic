import { state } from '../state/store';
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
}

export function groupContaining(hex: string): string[] | null {
  return state.mergeGroups.find((g) => g.includes(hex)) || null;
}

/** Merge an explicit set of raw hexes into one group, folding in any existing groups they touch. */
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
  state.selectedForMerge.clear();
  scheduleRebuild();
}

export function mergeSelected(): void {
  mergeHexes(Array.from(state.selectedForMerge));
}

export function unmergeGroup(members: string[]): void {
  state.mergeGroups = state.mergeGroups.filter((g) => g.join(',') !== members.join(','));
  scheduleRebuild();
}

export function updateMergeButton(): void {
  const btn = $('#btn-merge');
  const n = state.selectedForMerge.size;
  if (n >= 2) {
    btn.style.display = 'block';
    btn.textContent = `Merge ${n} selected into one recess`;
  } else btn.style.display = 'none';
}

export function renderColorList(colorMeshes: ColorListEntry[] | null): void {
  const list = $('#color-list');
  if (!colorMeshes || !colorMeshes.length) {
    list.innerHTML = '<div class="empty-hint">No colors detected yet.</div>';
    $('#slot-count').textContent = '';
    $('#stat-colors').textContent = '0 colors';
    $('#stat-colors').style.display = 'none';
    $('#btn-merge').style.display = 'none';
    return;
  }
  list.innerHTML = '';
  colorMeshes.sort((a, b) => b.areaPct - a.areaPct);
  colorMeshes.forEach((c) => {
    if (!state.colorSettings[c.key]) state.colorSettings[c.key] = { depth: c.depth };
    const row = document.createElement('div');
    row.className = 'color-row';

    let swatchHtml: string, labelHtml: string, rightControlHtml: string;
    if (c.isBackground) {
      swatchHtml = `<div class="swatch" style="background:${c.color}"></div>`;
      labelHtml = `Background`;
      rightControlHtml = '';
    } else if (c.isMergeGroup) {
      swatchHtml = `<div style="display:flex;gap:2px;">${c.members.map((h) => `<div class="swatch" style="background:${h};width:10px;"></div>`).join('')}</div>`;
      labelHtml = `Merged (${c.members.length})`;
      rightControlHtml = `<button class="btn small" data-unmerge="${c.members.join(',')}" title="Split back into separate colors">unmerge</button>`;
    } else {
      const checked = state.selectedForMerge.has(c.color) ? 'checked' : '';
      swatchHtml = `<div class="swatch" style="background:${c.color}"></div>`;
      labelHtml = c.color;
      rightControlHtml = `<input type="checkbox" data-select-hex="${c.color}" ${checked} title="Select to merge with another color into one recess">`;
    }

    row.innerHTML = `
      <div class="top">
        ${swatchHtml}
        <div class="hex">${labelHtml}</div>
        <div class="area">${c.areaPct.toFixed(1)}%</div>
        ${rightControlHtml}
      </div>
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
    const sel = row.querySelector<HTMLInputElement>('[data-select-hex]');
    if (sel)
      sel.addEventListener('change', (e) => {
        const t = e.target as HTMLInputElement;
        const hex = t.dataset.selectHex!;
        if (t.checked) state.selectedForMerge.add(hex);
        else state.selectedForMerge.delete(hex);
        updateMergeButton();
      });
    const unmerge = row.querySelector<HTMLElement>('[data-unmerge]');
    if (unmerge)
      unmerge.addEventListener('click', () => unmergeGroup(unmerge.dataset.unmerge!.split(',')));

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
  updateMergeButton();
  $('#slot-count').textContent =
    colorMeshes.length + ' AMS slot' + (colorMeshes.length === 1 ? '' : 's') + ' needed';
  $('#stat-colors').textContent = colorMeshes.length + ' colors';
  $('#stat-colors').style.display = '';
}

export function initColorListPanel(): void {
  $('#btn-merge').addEventListener('click', mergeSelected);
}
