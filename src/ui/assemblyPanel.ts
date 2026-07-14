import type { AssemblyPart } from '../types';
import { state } from '../state/store';
import { scheduleRebuild } from '../app/scheduler';
import { ASSEMBLY_KINDS, asmKindCanAutoLoad, currentAssemblyKind } from '../assembly/kinds';
import {
  applyAsmPatchChoice, asmAddRoleDuplicate, asmAddRolePart, asmLoadFullAssembly,
  asmLoadPartFile, asmRemovePart, onAssemblyPartsChanged,
} from '../assembly/parts';
import { $ } from './dom';

export function renderAssemblyKindSelect(): void {
  const sel = $<HTMLSelectElement>('#p-asm-kind');
  if (!sel) return;
  sel.innerHTML = ASSEMBLY_KINDS.map(k =>
    `<option value="${k.id}" ${k.id === state.assembly.kindId ? 'selected' : ''}>${k.name}</option>`
  ).join('');
}

export function renderAssemblyRoleControls(): void {
  const box = $('#assembly-role-controls');
  if (!box) return;
  const kind = currentAssemblyKind();
  if (!kind) { box.innerHTML = ''; return; }

  // Library reachable: the assembly auto-loads on select, so all we need here is a reload.
  if (asmKindCanAutoLoad(kind)) {
    box.innerHTML = `<div class="btn-row" style="margin-bottom:8px;"><button class="btn small" data-load-full>↻ Reload assembly</button></div>`;
    const b = box.querySelector('[data-load-full]');
    if (b) b.addEventListener('click', () => void asmLoadFullAssembly());
    return;
  }

  // Fallback when the library isn't reachable: manual per-role add buttons.
  const buttons: string[] = [];
  kind.roles.forEach(role => {
    const primary = state.assembly.parts.find(p => p.roleId === role.id && !p.isDuplicateOf);
    if (!primary) buttons.push(`<button class="btn small" data-role-add="${role.id}">+ Add ${role.name}</button>`);
    else if (role.allowRotatedCopies) buttons.push(`<button class="btn small" data-role-dup="${role.id}">+ Add rotated copy of ${role.name}</button>`);
  });
  box.innerHTML = buttons.length
    ? `<div class="hint" style="margin-bottom:6px;">The parts library isn't reachable, so add parts manually:</div><div class="btn-row" style="flex-wrap:wrap;margin-bottom:8px;">${buttons.join('')}</div>`
    : `<div class="hint" style="margin-bottom:8px;">All roles for this assembly are filled.</div>`;
  box.querySelectorAll<HTMLElement>('[data-role-add]').forEach(btn => btn.addEventListener('click', () => {
    const role = kind.roles.find(r => r.id === btn.dataset.roleAdd);
    if (role) asmAddRolePart(role);
  }));
  box.querySelectorAll<HTMLElement>('[data-role-dup]').forEach(btn => btn.addEventListener('click', () => {
    const role = kind.roles.find(r => r.id === btn.dataset.roleDup);
    if (role) asmAddRoleDuplicate(role);
  }));
}

/**
 * Full editable controls for one part (drop zone, face pick, base thickness / pivot+angle,
 * remove). Kept behind an "Advanced" disclosure in the common auto-load case, but still the
 * primary upload UI when the library isn't reachable.
 */
function buildAsmPartRow(part: AssemblyPart): HTMLElement {
  const row = document.createElement('div');
  row.className = 'color-row';
  row.style.marginBottom = '8px';
  if (part.isDuplicateOf) {
    const src = state.assembly.parts.find(p => p.id === part.isDuplicateOf);
    row.innerHTML = `
      <div class="top"><div class="hex">${part.name}</div></div>
      <div class="hint">Reuses ${src ? src.name : '?'}'s geometry, rotated into position for design-fitting purposes. Exported cut is re-oriented back to this part's native (unrotated) print orientation.</div>
      <div class="depth-row"><label>pivot X</label><input type="number" step="0.1" value="${part.pivotX}" data-asm="pivotX" style="width:56px;"></div>
      <div class="depth-row"><label>pivot Z</label><input type="number" step="0.1" value="${part.pivotZ}" data-asm="pivotZ" style="width:56px;"></div>
      <div class="depth-row"><label>angle°</label><input type="number" step="1" value="${part.angleDeg}" data-asm="angleDeg" style="width:56px;"></div>
      <button class="btn small" data-asm-remove style="margin-top:6px;">Remove</button>
    `;
  } else {
    const statusText = part.loaded
      ? `face detected: normal (${part.patchNormal!.map(v => v.toFixed(2)).join(', ')}), plane offset ${part.topZ.toFixed(2)}mm, ${part.boundaryLoop ? part.boundaryLoop.length : 0}-pt boundary`
      : 'no file loaded yet';
    const patchOptions = (part.patches || []).slice(0, 6).map((p, i) =>
      `<option value="${i}" ${i === part.patchIdx ? 'selected' : ''}>#${i + 1}: area ${p.area.toFixed(0)}mm² (normal ${p.normal.map(v => v.toFixed(2)).join(',')})</option>`
    ).join('');
    row.innerHTML = `
      <div class="top"><div class="hex">${part.name}</div></div>
      <div style="border:1.5px dashed var(--line);border-radius:6px;padding:8px;text-align:center;font-size:11px;color:var(--text-dim);cursor:pointer;" data-asm-drop>
        Drop STL/3MF here<input type="file" accept=".stl,.3mf" style="display:none" data-asm-file>
      </div>
      <div class="hint" style="margin-top:4px;">${statusText}</div>
      ${part.patches ? `<div class="depth-row"><label>face</label><select data-asm="patchIdx" style="flex:1;">${patchOptions}</select></div>` : ''}
      <div class="depth-row"><label>base thick.</label><input type="number" step="0.5" min="0.5" value="${part.baseDepth}" data-asm="baseDepth" style="width:56px;"><span class="hint">mm of material behind the face this replaces</span></div>
      <div class="btn-row" style="margin-top:6px;">
        <button class="btn small" data-asm-remove>Remove</button>
      </div>
    `;
  }
  const drop = row.querySelector<HTMLElement>('[data-asm-drop]');
  const fileInput = row.querySelector<HTMLInputElement>('[data-asm-file]');
  if (drop && fileInput) {
    drop.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) void asmLoadPartFile(part, f);
    });
    ['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => e.preventDefault()));
    drop.addEventListener('drop', e => {
      e.preventDefault();
      const f = (e as DragEvent).dataTransfer?.files[0];
      if (f) void asmLoadPartFile(part, f);
    });
  }
  row.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-asm]').forEach(inp => {
    inp.addEventListener('change', e => {
      const t = e.target as HTMLInputElement;
      const field = t.dataset.asm as 'pivotX' | 'pivotZ' | 'angleDeg' | 'baseDepth' | 'patchIdx';
      const val = (field === 'patchIdx') ? parseInt(t.value) : parseFloat(t.value);
      part[field] = val;
      if (field === 'patchIdx') applyAsmPatchChoice(part);
      scheduleRebuild();
    });
  });
  const rmBtn = row.querySelector<HTMLElement>('[data-asm-remove]');
  if (rmBtn) rmBtn.addEventListener('click', () => asmRemovePart(part.id));
  return row;
}

export function renderAssemblyPartList(): void {
  const box = $('#assembly-part-list');
  if (!box) return;
  box.innerHTML = '';
  const kind = currentAssemblyKind();
  const parts = state.assembly.parts;

  // Auto-load case: a clean one-line-per-part summary with the detailed face/alignment/remove
  // controls tucked behind an "Advanced" disclosure, so the default view is just "the wheel
  // loaded" instead of a wall of options.
  if (kind && asmKindCanAutoLoad(kind)) {
    if (!parts.length) { box.innerHTML = '<div class="hint">Loading assembly…</div>'; return; }
    const summary = document.createElement('div');
    summary.className = 'asm-summary';
    summary.innerHTML = parts.map(p =>
      `<div class="asm-sum-row"><span class="ok">${p.loaded ? '✓' : '…'}</span>${p.name}</div>`
    ).join('');
    box.appendChild(summary);

    const det = document.createElement('details');
    det.className = 'asm-adv';
    det.appendChild(Object.assign(document.createElement('summary'), { textContent: 'Advanced: per-part face & alignment' }));
    const inner = document.createElement('div');
    inner.style.marginTop = '8px';
    parts.forEach(p => inner.appendChild(buildAsmPartRow(p)));
    det.appendChild(inner);
    box.appendChild(det);
    return;
  }

  // Manual case: the full editable rows, since parts must be dragged in by hand.
  parts.forEach(p => box.appendChild(buildAsmPartRow(p)));
}

export function initAssemblyPanel(): void {
  onAssemblyPartsChanged(() => {
    renderAssemblyRoleControls();
    renderAssemblyPartList();
  });

  $<HTMLSelectElement>('#p-asm-kind').addEventListener('change', e => {
    const sel = e.target as HTMLSelectElement;
    const newKindId = sel.value;
    if (state.assembly.parts.length > 0 && !confirm('Switching assembly type will clear all current parts. Continue?')) {
      sel.value = state.assembly.kindId || '';
      return;
    }
    state.assembly.kindId = newKindId;
    state.assembly.parts = [];
    renderAssemblyRoleControls();
    renderAssemblyPartList();
    scheduleRebuild();
  });
}
