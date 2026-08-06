import type { AssemblyPart } from '../types';
import { state } from '../state/store';
import { scheduleRebuild } from '../app/scheduler';
import { asmKindCanAutoLoad, currentAssemblyKind, currentVariantId } from '../assembly/kinds';
import {
  applyAsmPatchChoice,
  asmAddRoleDuplicate,
  asmAddRolePart,
  asmLoadFullAssembly,
  asmLoadPartFile,
  asmRebuildGeneratedParts,
  asmRemovePart,
  onAssemblyPartsChanged,
  switchChairVariant,
} from '../assembly/parts';
import { getPrinter } from '../export/printers';
import { availableZones } from '../state/artwork';
import { track } from '../analytics/track';
import { renderArtworkList } from './artworkListPanel';
import { $ } from './dom';

/** Show/hide controls that only apply to certain assembly kinds (Design radius is wheel-only). */
export function syncAssemblyKindControls(): void {
  const kind = currentAssemblyKind();
  const radiusRow = $('#asm-radius-row');
  if (radiusRow) radiusRow.style.display = kind?.designFit === 'rect' ? 'none' : '';

  // Design template download — per-kind, so it follows the part selection.
  const tplRow = $('#asm-template-row');
  const tplLink = $<HTMLAnchorElement>('#asm-template-link');
  if (tplRow && tplLink) {
    const built = kind?.buildTemplate;
    tplRow.style.display = built || kind?.templateFile ? '' : 'none';
    // A generated kind's template is rebuilt from current state every time this runs, so the link
    // can never hand out a drawing for the size the part used to be.
    if (built) tplLink.href = templateObjectUrl(built());
    else if (kind?.templateFile) tplLink.href = `templates/${kind.templateFile}`;
    if (built || kind?.templateFile) tplLink.download = `${kind!.id}-template.svg`;
  }

  syncBuildParamControl();
  renderAssemblyVariantControls();
  renderZoneTemplateLinks();
}

/**
 * Blob URL for a generated template, replacing the previous one. Revoked rather than left to the
 * GC: this is re-run on every kind switch and every diameter edit, so the leak would be unbounded
 * over a long session.
 */
let lastTemplateUrl: string | null = null;
function templateObjectUrl(svg: string): string {
  if (lastTemplateUrl) URL.revokeObjectURL(lastTemplateUrl);
  lastTemplateUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  return lastTemplateUrl;
}

/**
 * The kind's numeric build parameter, if it has one (AssemblyKind.buildParam) — the hubcap's disc
 * diameter today. The upper bound is the selected printer's plate rather than a constant: a disc
 * that doesn't fit the bed isn't a part, and letting someone dial past it only to be told at
 * export time is the slower way to find out.
 */
export function syncBuildParamControl(): void {
  const row = $('#asm-buildparam-row');
  const input = $<HTMLInputElement>('#p-asm-buildparam');
  const label = $('#asm-buildparam-label');
  if (!row || !input || !label) return;
  const param = currentAssemblyKind()?.buildParam;
  row.style.display = param ? '' : 'none';
  if (!param) return;
  const plate = getPrinter(state.printerId).plate;
  label.textContent = param.label;
  input.min = String(round2(param.minMm));
  input.max = String(round2(Math.min(param.maxMm ?? Infinity, plate.w, plate.d)));
  input.step = String(param.step);
  input.value = String(round2(state[param.id]));
}

const round2 = (v: number): number => Number(v.toFixed(2));

/**
 * Commit an edit to the kind's build parameter: clamp to the control's own bounds, then rebuild
 * the generated parts from their cached assets.
 *
 * Clamping here rather than trusting the input's min/max because a typed value bypasses them —
 * and out of range means a disc that misses its clips or overhangs the bed, both of which slice
 * into something that looks fine on screen.
 */
export async function applyBuildParam(raw: number): Promise<void> {
  const kind = currentAssemblyKind();
  const param = kind?.buildParam;
  if (param && Number.isFinite(raw) && (await commitBuildParam(raw))) {
    track('build_param_changed', { kind: kind!.id, param: param.id, value: Math.round(raw) });
    return;
  }
  // nothing changed, or the field was left empty/garbage — put the live value back
  syncBuildParamControl();
}

/**
 * Re-clamp the build parameter against the *current* printer and regenerate if that moved it.
 *
 * Called when the printer changes: the plate is the parameter's upper bound, so switching to a
 * smaller bed can leave a disc wider than the machine can print. Separate from applyBuildParam
 * because this is not the user editing the value — per docs/analytics.md, events fire on real
 * user intent, not on state the app corrected on their behalf.
 */
export async function clampBuildParamToPrinter(): Promise<void> {
  const param = currentAssemblyKind()?.buildParam;
  if (param) await commitBuildParam(state[param.id]);
  syncBuildParamControl();
}

/** Clamp, store and regenerate. Returns whether the value actually moved. */
async function commitBuildParam(raw: number): Promise<boolean> {
  const param = currentAssemblyKind()?.buildParam;
  if (!param) return false;
  const plate = getPrinter(state.printerId).plate;
  const max = Math.min(param.maxMm ?? Infinity, plate.w, plate.d);
  const next = Math.min(max, Math.max(param.minMm, raw));
  if (next === state[param.id]) return false;
  state[param.id] = next;
  syncBuildParamControl(); // show the clamped value before the rebuild, not after it
  await asmRebuildGeneratedParts();
  return true;
}

/**
 * Per-zone template downloads, for a kind whose parts carry more than one design surface (the
 * chair) — the multi-zone counterpart to the single `#asm-template-link` above, which only makes
 * sense for a kind with exactly one design face. Populated from whatever zones the currently
 * loaded parts actually offer, so it fills in once the async zone charts resolve (see the
 * onAssemblyPartsChanged hook below) rather than at kind-select time.
 */
export function renderZoneTemplateLinks(): void {
  const row = $('#asm-zone-template-row');
  const box = $('#asm-zone-template-links');
  if (!row || !box) return;
  const zones = availableZones().filter((z) => z.templateFile);
  if (!zones.length) {
    row.style.display = 'none';
    box.innerHTML = '';
    return;
  }
  row.style.display = '';
  box.innerHTML = zones
    .map((z, i) => `${i ? ' · ' : ''}<a href="templates/${z.templateFile}" download>${z.name}</a>`)
    .join('');
  box.querySelectorAll<HTMLAnchorElement>('a').forEach((a, i) =>
    a.addEventListener('click', () => {
      const kind = currentAssemblyKind();
      if (kind) track('template_download', { kind: kind.id, zone: zones[i].zoneId });
    }),
  );
}

/**
 * The hardware-variant radio (Standard/Kit) for a kind that declares `variants` — hidden for every
 * other kind. Re-rendered after every switch attempt (not just a successful one) so a cancelled
 * confirmDialog() snaps the radio back to the still-current variant instead of leaving it showing
 * the click the user backed out of.
 */
export function renderAssemblyVariantControls(): void {
  const row = $('#asm-variant-row');
  const box = $('#asm-variant-options');
  if (!row || !box) return;
  const kind = currentAssemblyKind();
  if (!kind?.variants?.length) {
    row.style.display = 'none';
    box.innerHTML = '';
    return;
  }
  row.style.display = '';
  const active = currentVariantId();
  box.innerHTML = kind.variants
    .map(
      (v) =>
        `<label class="variant-option"><input type="radio" name="asm-variant" value="${v.id}" ${
          v.id === active ? 'checked' : ''
        }> ${v.name}</label>`,
    )
    .join('');
  box.querySelectorAll<HTMLInputElement>('input[name="asm-variant"]').forEach((r) =>
    r.addEventListener('change', () => {
      if (!r.checked) return;
      void switchChairVariant(r.value).finally(renderAssemblyVariantControls);
    }),
  );
}

export function renderAssemblyRoleControls(): void {
  const box = $('#assembly-role-controls');
  if (!box) return;
  const kind = currentAssemblyKind();
  if (!kind) {
    box.innerHTML = '';
    return;
  }

  // Library reachable: the assembly auto-loads on select, so all we need here is a reload.
  if (asmKindCanAutoLoad(kind)) {
    box.innerHTML = `<div class="btn-row" style="margin-bottom:8px;"><button class="btn small" data-load-full>↻ Reload assembly</button></div>`;
    const b = box.querySelector('[data-load-full]');
    if (b) b.addEventListener('click', () => void asmLoadFullAssembly());
    return;
  }

  // Fallback when the library isn't reachable: manual per-role add buttons.
  const buttons: string[] = [];
  kind.roles.forEach((role) => {
    const primary = state.assembly.parts.find((p) => p.roleId === role.id && !p.isDuplicateOf);
    if (!primary)
      buttons.push(
        `<button class="btn small" data-role-add="${role.id}">+ Add ${role.name}</button>`,
      );
    else if (role.allowRotatedCopies)
      buttons.push(
        `<button class="btn small" data-role-dup="${role.id}">+ Add rotated copy of ${role.name}</button>`,
      );
  });
  box.innerHTML = buttons.length
    ? `<div class="hint" style="margin-bottom:6px;">The parts library isn't reachable, so add parts manually:</div><div class="btn-row" style="flex-wrap:wrap;margin-bottom:8px;">${buttons.join('')}</div>`
    : `<div class="hint" style="margin-bottom:8px;">All roles for this assembly are filled.</div>`;
  box.querySelectorAll<HTMLElement>('[data-role-add]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const role = kind.roles.find((r) => r.id === btn.dataset.roleAdd);
      if (role) asmAddRolePart(role);
    }),
  );
  box.querySelectorAll<HTMLElement>('[data-role-dup]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const role = kind.roles.find((r) => r.id === btn.dataset.roleDup);
      if (role) asmAddRoleDuplicate(role);
    }),
  );
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
    const src = state.assembly.parts.find((p) => p.id === part.isDuplicateOf);
    row.innerHTML = `
      <div class="top"><div class="hex">${part.name}</div></div>
      <div class="hint">Reuses ${src ? src.name : '?'}'s geometry, rotated into position for design-fitting purposes. Exported cut is re-oriented back to this part's native (unrotated) print orientation.</div>
      <div class="depth-row"><label>pivot X</label><input type="number" step="0.1" value="${part.pivotX}" data-asm="pivotX" style="width:56px;" aria-label="Pivot X for ${part.name}"></div>
      <div class="depth-row"><label>pivot Z</label><input type="number" step="0.1" value="${part.pivotZ}" data-asm="pivotZ" style="width:56px;" aria-label="Pivot Z for ${part.name}"></div>
      <div class="depth-row"><label>angle°</label><input type="number" step="1" value="${part.angleDeg}" data-asm="angleDeg" style="width:56px;" aria-label="Rotation angle for ${part.name}"></div>
      <button class="btn small" data-asm-remove style="margin-top:6px;" aria-label="Remove ${part.name}">Remove</button>
    `;
  } else {
    const statusText = part.loaded
      ? `face detected: normal (${part.patchNormal!.map((v) => v.toFixed(2)).join(', ')}), plane offset ${part.topZ.toFixed(2)}mm, ${part.boundaryLoop ? part.boundaryLoop.length : 0}-pt boundary`
      : 'no file loaded yet';
    const patchOptions = (part.patches || [])
      .slice(0, 6)
      .map(
        (p, i) =>
          `<option value="${i}" ${i === part.patchIdx ? 'selected' : ''}>#${i + 1}: area ${p.area.toFixed(0)}mm² (normal ${p.normal.map((v) => v.toFixed(2)).join(',')})</option>`,
      )
      .join('');
    row.innerHTML = `
      <div class="top"><div class="hex">${part.name}</div></div>
      <div style="border:1.5px dashed var(--line);border-radius:6px;padding:8px;text-align:center;font-size:11px;color:var(--text-dim);cursor:pointer;" data-asm-drop>
        Drop STL/3MF here<input type="file" accept=".stl,.3mf" style="display:none" data-asm-file aria-label="Upload STL/3MF for ${part.name}">
      </div>
      <div class="hint" style="margin-top:4px;">${statusText}</div>
      ${part.patches ? `<div class="depth-row"><label>face</label><select data-asm="patchIdx" style="flex:1;" aria-label="Design face for ${part.name}">${patchOptions}</select></div>` : ''}
      <div class="depth-row"><label>base thick.</label><input type="number" step="0.5" min="0.5" value="${part.baseDepth}" data-asm="baseDepth" style="width:56px;" aria-label="Base thickness for ${part.name}"><span class="hint">mm of material behind the face this replaces</span></div>
      <div class="btn-row" style="margin-top:6px;">
        <button class="btn small" data-asm-remove aria-label="Remove ${part.name}">Remove</button>
      </div>
    `;
  }
  const drop = row.querySelector<HTMLElement>('[data-asm-drop]');
  const fileInput = row.querySelector<HTMLInputElement>('[data-asm-file]');
  if (drop && fileInput) {
    drop.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) void asmLoadPartFile(part, f);
    });
    ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => e.preventDefault()));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = (e as DragEvent).dataTransfer?.files[0];
      if (f) void asmLoadPartFile(part, f);
    });
  }
  row.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-asm]').forEach((inp) => {
    inp.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      const field = t.dataset.asm as 'pivotX' | 'pivotZ' | 'angleDeg' | 'baseDepth' | 'patchIdx';
      const val = field === 'patchIdx' ? parseInt(t.value) : parseFloat(t.value);
      if (!Number.isFinite(val)) {
        // A cleared field yields '' -> NaN, which reaches three.js as a NaN transform and
        // blanks the whole viewport (Box3.isEmpty() is false on NaN bounds) — snap back instead.
        t.value = String(part[field]);
        return;
      }
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
    if (!parts.length) {
      box.innerHTML = '<div class="hint">Loading assembly…</div>';
      return;
    }
    const summary = document.createElement('div');
    summary.className = 'asm-summary';
    summary.innerHTML = parts
      .map(
        (p) =>
          `<div class="asm-sum-row"><span class="ok">${p.loaded ? '✓' : '…'}</span>${p.name}</div>`,
      )
      .join('');
    box.appendChild(summary);

    const det = document.createElement('details');
    det.className = 'asm-adv';
    det.appendChild(
      Object.assign(document.createElement('summary'), {
        textContent: 'Advanced: per-part face & alignment',
      }),
    );
    const inner = document.createElement('div');
    inner.style.marginTop = '8px';
    parts.forEach((p) => inner.appendChild(buildAsmPartRow(p)));
    det.appendChild(inner);
    box.appendChild(det);
    return;
  }

  // Manual case: the full editable rows, since parts must be dragged in by hand.
  parts.forEach((p) => box.appendChild(buildAsmPartRow(p)));
}

export function initAssemblyPanel(): void {
  onAssemblyPartsChanged(() => {
    renderAssemblyRoleControls();
    renderAssemblyPartList();
    // Zone charts resolve asynchronously as parts load, so the list's per-instance zone dropdown
    // and the per-zone template links (both empty until availableZones() has something to offer)
    // need a re-render here too.
    renderArtworkList();
    renderZoneTemplateLinks();
  });
  // The link's href is re-pointed per kind in syncAssemblyKindControls; bind the click once here
  // so repeated syncs don't stack handlers.
  const tplLink = $('#asm-template-link');
  if (tplLink)
    tplLink.addEventListener('click', () => {
      const kind = currentAssemblyKind();
      if (kind) track('template_download', { kind: kind.id });
    });
}
