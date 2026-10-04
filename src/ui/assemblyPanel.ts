import type { AssemblyPart } from '../types';
import { state } from '../state/store';
import { scheduleRebuild } from '../app/scheduler';
import {
  asmKindCanAutoLoad,
  buildParamMax,
  currentAssemblyKind,
  currentVariantId,
} from '../assembly/kinds';
import {
  applyAsmPatchChoice,
  asmLoadFullAssembly,
  asmRebuildGeneratedParts,
  asmRemovePart,
  onAssemblyPartsChanged,
  partsLibrarySettled,
  switchChairVariant,
} from '../assembly/parts';
import { HUBCAP_WHEEL_DIAMETER_MM } from '../geometry/hubcap';
import { WHOLE_CHAIR_ZONE } from '../geometry/zones';
import { availableZones, clampArtworkModes } from '../state/artwork';
import { track } from '../analytics/track';
import { renderArtworkList } from './artworkListPanel';
import { refreshShapeThumb } from './shapeThumb';
import { clearStalePlacementNotices } from './exportPanel';
import { renderWarnings } from './warningsView';
import { $ } from './dom';

/** Show/hide controls that only apply to certain assembly kinds (Design radius is wheel-only). */
export function syncAssemblyKindControls(): void {
  const kind = currentAssemblyKind();
  const radiusRow = $('#asm-radius-row');
  if (radiusRow) radiusRow.style.display = kind?.designFit === 'rect' ? 'none' : '';

  syncTemplateLink();
  // Render synchronously, then correct: leaving it to the clamp (which awaits a rebuild) deferred it a microtask and the panel briefly showed the previous kind's control.
  syncBuildParamControl();
  // Re-clamp on the way in, not just on printer change: that handler reads the kind active *then*, so
  // it does nothing while a kind without a build parameter is selected. A 320mm hubcap on the H2D,
  // then wheel, X1C, back: the diameter survived every step that could have caught it — a 320mm disc on a 256mm bed.
  void clampBuildParamToPrinter();
  renderAssemblyVariantControls();
  renderZoneTemplateLinks();
}

/**
 * Point the per-kind template download at the current template. Also called from the build-parameter
 * path: a generated template is only true-to-size for the size it was built at, and kind-switch
 * alone handed out the 220mm drawing after changing to 180mm — a 1:1 that is silently the wrong 1:1.
 */
function syncTemplateLink(): void {
  const kind = currentAssemblyKind();
  const tplRow = $('#asm-template-row');
  const tplLink = $<HTMLAnchorElement>('#asm-template-link');
  if (!tplRow || !tplLink) return;
  const built = kind?.buildTemplate;
  tplRow.style.display = built || kind?.templateFile ? '' : 'none';
  if (built) tplLink.href = templateObjectUrl(built());
  else if (kind?.templateFile) tplLink.href = `templates/${kind.templateFile}`;
  if (built || kind?.templateFile) tplLink.download = `${kind!.id}-template.svg`;
}

/** Blob URL for a generated template, replacing the previous one. Revoked, not left to GC: it re-runs on every kind switch and diameter edit, so the leak would be unbounded. */
let lastTemplateUrl: string | null = null;
function templateObjectUrl(svg: string): string {
  if (lastTemplateUrl) URL.revokeObjectURL(lastTemplateUrl);
  lastTemplateUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  return lastTemplateUrl;
}

/**
 * The kind's numeric build parameter (AssemblyKind.buildParam) — the hubcap's disc diameter today.
 * Upper bound is the printer's plate, not a constant: dialing past it only to be told at export is the slower way to find out.
 */
export function syncBuildParamControl(): void {
  const row = $('#asm-buildparam-row');
  const input = $<HTMLInputElement>('#p-asm-buildparam');
  const label = $('#asm-buildparam-label');
  if (!row || !input || !label) return;
  const param = currentAssemblyKind()?.buildParam;
  row.style.display = param ? '' : 'none';
  // The silhouette toggle rides with the size control: both are "what shape is this part", and only a kind generating its own mesh has either.
  const silRow = $('#asm-silhouette-row');
  const silInput = $<HTMLInputElement>('#p-asm-silhouette');
  if (silRow) silRow.style.display = param ? '' : 'none';
  if (silInput) silInput.checked = state.hubcapSilhouette;
  if (!param) return;
  label.textContent = param.label;
  input.min = String(round2(param.minMm));
  input.max = String(round2(buildParamMax(param, state.printerId)));
  // `any`, not a fixed step: `min` is the step base, so a real step puts valid values on a grid
  // offset by a measured constant (32.09mm) and round diameters read :invalid with the spinner
  // walking x.09, x.59. A diameter is a continuous measurement; arrows still step by 1mm.
  input.step = 'any';
  input.value = String(round2(state[param.id]));
}

const round2 = (v: number): number => Number(v.toFixed(2));

/**
 * The part's real footprint, in mm, under the size control. Measured off the built mesh so it can't
 * disagree with what you get: once the shape stops being a circle the size control stops describing
 * it (a hubcap cut to a tall character reads 220 in the field and is 168mm wide), and the gizmo
 * moves both numbers without touching the field.
 */
export function renderBuildParamSize(): void {
  const el = $('#asm-buildparam-size');
  if (!el) return;
  const kind = currentAssemblyKind();
  const role = kind?.roles.find((r) => r.buildMesh);
  const part = role ? state.assembly.parts.find((p) => p.roleId === role.id && p.positions) : null;
  if (!kind?.buildParam || !part?.positions) {
    el.style.display = 'none';
    return;
  }
  const pos = part.positions;
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity,
    reach = 0;
  for (let i = 0; i < pos.length; i += 3) {
    if (pos[i] < minX) minX = pos[i];
    if (pos[i] > maxX) maxX = pos[i];
    if (pos[i + 2] < minZ) minZ = pos[i + 2];
    if (pos[i + 2] > maxZ) maxZ = pos[i + 2];
    // How far the part ACTUALLY reaches from the axis, vertex by vertex, not the bbox corner a shape
    // needn't touch. On a real silhouette that's 240mm against 277mm on a 280mm wheel — the corner
    // reads as nearly overhanging with 40mm to spare and would have someone shrink a part that fit.
    const r = Math.hypot(pos[i], pos[i + 2]);
    if (r > reach) reach = r;
  }
  if (!Number.isFinite(minX)) {
    el.style.display = 'none';
    return;
  }
  const w = maxX - minX;
  const d = maxZ - minZ;
  el.style.display = '';
  el.innerHTML =
    `<b>Actual size ${w.toFixed(1)} × ${d.toFixed(1)} mm</b>` +
    ` (${(reach * 2).toFixed(0)}mm across, on a ${HUBCAP_WHEEL_DIAMETER_MM}mm wheel)`;

  // The unit hint says "mm", which stops being useful once the field is only one of the part's two dimensions.
  const unit = $('#asm-buildparam-unit');
  if (unit) unit.textContent = kind.buildParam && state.hubcapSilhouette ? 'longest side' : 'mm';
}

/**
 * Commit an edit to the kind's build parameter: clamp to the control's bounds, then rebuild the
 * generated parts from cached assets. Clamped here because a typed value bypasses min/max, and out
 * of range means a disc that misses its clips or overhangs the bed — both slice fine-looking.
 */
export async function applyBuildParam(raw: number): Promise<void> {
  const kind = currentAssemblyKind();
  const param = kind?.buildParam;
  if (param && Number.isFinite(raw)) {
    const committed = await commitBuildParam(raw);
    if (committed !== undefined) {
      // Cleared only once the size actually changed. The hubcap's verified arrangement is gated on the
      // diameter and silhouette toggle (buildPlacement), so either can flip the placement notice and
      // blocked-tower warning, but a rejected edit changes nothing and clearing up front wiped warnings
      // that still described the export. Emptying the field at the clamp max, or typing over it, take that path.
      clearStalePlacementNotices();
      renderWarnings();
      // the value that was BUILT, not typed: a typed 9999 clamps to the plate, and reporting it would put a size nothing was generated at in the catalog
      track('build_param_changed', {
        kind: kind.id,
        param: param.id,
        value: Math.round(committed),
      });
      return;
    }
  }
  // nothing changed, or the field was left empty/garbage — put the live value back
  syncBuildParamControl();
}

/**
 * Re-clamp the build parameter against the *current* printer and regenerate if that moved it. The
 * plate is the upper bound, so a smaller bed can leave a disc wider than the machine prints. Separate
 * from applyBuildParam: not a user edit, and per docs/analytics.md events fire on user intent, not
 * on corrections the app made.
 */
export async function clampBuildParamToPrinter(): Promise<void> {
  const param = currentAssemblyKind()?.buildParam;
  if (param) await commitBuildParam(state[param.id]);
  syncBuildParamControl();
}

/**
 * Turn the silhouette toggle on or off and rebuild the part around it. Its own entry point: it
 * changes what the shape IS, not how big, and has no value to clamp. Same rebuild, since the mesh depends on it like the size.
 */
export async function applyHubcapSilhouette(on: boolean): Promise<void> {
  if (on === state.hubcapSilhouette) return;
  state.hubcapSilhouette = on;
  // After the no-op guard, like applyBuildParam's clear: this toggle gates the hubcap's verified arrangement (buildPlacement), so it flips the placement notice and blocked-tower warning only when it changes something.
  clearStalePlacementNotices();
  const kind = currentAssemblyKind();
  // Fill is withheld while the part follows the artwork, so a chosen Fill is rewritten — the clamp a
  // Fill-withholding kind applies on a part switch. The list re-renders too: the clamp rewrites the
  // stored mode but the dropdown's options were built with the toggle off and still offer it.
  // Ahead of renderWarnings, since the clamp raises a notice a render run first wouldn't paint.
  clampArtworkModes();
  renderWarnings();
  renderArtworkList();
  syncBuildParamControl();
  syncTemplateLink();
  await asmRebuildGeneratedParts();
  if (kind) track('hubcap_silhouette_toggled', { kind: kind.id, on });
}

/** Clamp, store and regenerate. Returns the committed value, or undefined if nothing moved. */
async function commitBuildParam(raw: number): Promise<number | undefined> {
  const param = currentAssemblyKind()?.buildParam;
  if (!param) return undefined;
  const next = Math.min(buildParamMax(param, state.printerId), Math.max(param.minMm, raw));
  const previous = state[param.id];
  if (next === previous) return undefined;
  state[param.id] = next;
  // show the clamped value and re-issue the template before the rebuild, not after it
  syncBuildParamControl();
  syncTemplateLink();
  if (await asmRebuildGeneratedParts()) return next;
  // Put it back: the scene's mesh is still the previous size and this value is what the app uses to
  // *describe* that mesh — the verified-plate lookup would pin a 250mm disc at the arrangement
  // checked for 220mm (off the plate, tower inside the part) and the template re-issue at a size nothing was built at.
  state[param.id] = previous;
  syncBuildParamControl();
  syncTemplateLink();
  return undefined;
}

/**
 * Per-zone template downloads, for a kind whose parts carry several design surfaces (the chair) —
 * the counterpart to the single `#asm-template-link`. Filled from the zones the loaded parts offer,
 * so it populates once the async zone charts resolve (onAssemblyPartsChanged below), not at kind-select.
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
      // The reserved id is plumbing, not for analytics — same as artwork_instance_zone_changed in src/ui/artworkListPanel.ts.
      const zone = zones[i].zoneId === WHOLE_CHAIR_ZONE ? 'whole' : zones[i].zoneId;
      if (kind) track('template_download', { kind: kind.id, zone });
    }),
  );
}

/**
 * The hardware-variant radio (Standard/Kit) for a kind declaring `variants`, hidden otherwise.
 * Re-rendered after every switch attempt, not just a successful one, so a cancelled confirmDialog()
 * snaps the radio back to the current variant.
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
    box.innerHTML = `<div class="btn-row" style="margin-bottom:var(--space-row);"><button class="btn small" data-load-full>↻ Reload assembly</button></div>`;
    const b = box.querySelector('[data-load-full]');
    if (b) b.addEventListener('click', () => void asmLoadFullAssembly());
    return;
  }

  // Still waiting on stl/parts.json: says nothing rather than a failure that hasn't happened.
  // `main.ts` calls applyPartKind() a line before loadPartsLibrary(), so every healthy boot passes through here.
  if (!partsLibrarySettled()) {
    box.innerHTML = '';
    return;
  }

  // The manifest is back and this kind still can't load: unreachable, or missing an entry a role
  // names. Both are a broken deployment. This used to offer per-role add buttons and a mesh drop
  // target, but the app can't check an arbitrary mesh is the part it claims and every verified export
  // pose is keyed to the shipped one. So say so and stop. No kind name in the message:
  // `AssemblyKind.name` ("Wheel (Top ×2 + Cap)") reads as a parts list mid-sentence.
  box.innerHTML = `<div class="hint" data-asm-load-error>Couldn't load this part. Reload the page to try again.</div>`;
}

/** What the detected design face is, as the row states it. Recomputed, not re-rendered: re-running the row's innerHTML from its own change handler destroys the firing <select> and collapses the Advanced disclosure. */
function faceStatusText(part: AssemblyPart): string {
  if (!part.loaded) return 'no file loaded yet';
  const normal = part.patchNormal!.map((v) => v.toFixed(2)).join(', ');
  const pts = (part.boundaryLoops || []).reduce((n, l) => n + l.length, 0);
  return `face detected: normal (${normal}), plane offset ${part.topZ.toFixed(2)}mm, ${pts}-pt boundary`;
}

/** Full editable controls for one part: face pick, base thickness / pivot+angle, remove. */
function buildAsmPartRow(part: AssemblyPart): HTMLElement {
  const row = document.createElement('div');
  row.className = 'color-row';
  row.style.marginBottom = 'var(--space-row)';
  if (part.isDuplicateOf) {
    const src = state.assembly.parts.find((p) => p.id === part.isDuplicateOf);
    row.innerHTML = `
      <div class="top"><div class="hex">${part.name}</div></div>
      <div class="hint">Reuses ${src ? src.name : '?'}'s geometry, rotated into place for fitting. The exported cut is rotated back to this part's own print orientation.</div>
      <div class="depth-row"><label>pivot X</label><input type="number" step="0.1" value="${part.pivotX}" data-asm="pivotX" style="width:56px;" aria-label="Pivot X for ${part.name}"></div>
      <div class="depth-row"><label>pivot Z</label><input type="number" step="0.1" value="${part.pivotZ}" data-asm="pivotZ" style="width:56px;" aria-label="Pivot Z for ${part.name}"></div>
      <div class="depth-row"><label>angle°</label><input type="number" step="1" value="${part.angleDeg}" data-asm="angleDeg" style="width:56px;" aria-label="Rotation angle for ${part.name}"></div>
      <button class="btn small" data-asm-remove style="margin-top:var(--space-tight);" aria-label="Remove ${part.name}">Remove</button>
    `;
  } else {
    const statusText = faceStatusText(part);
    const patchOptions = (part.patches || [])
      .slice(0, 6)
      .map(
        (p, i) =>
          `<option value="${i}" ${i === part.patchIdx ? 'selected' : ''}>#${i + 1}: area ${p.area.toFixed(0)}mm² (normal ${p.normal.map((v) => v.toFixed(2)).join(',')})</option>`,
      )
      .join('');
    row.innerHTML = `
      <div class="top"><div class="hex">${part.name}</div></div>
      <div class="hint" style="margin-top:var(--space-tight);" data-asm-face-status>${statusText}</div>
      ${part.patches ? `<div class="depth-row"><label>design face</label><select data-asm="patchIdx" style="flex:1;" aria-label="Design face for ${part.name}">${patchOptions}</select></div>` : ''}
      <div class="depth-row"><label>base thick.</label><input type="number" step="0.5" min="0.5" value="${part.baseDepth}" data-asm="baseDepth" style="width:56px;" aria-label="Base thickness for ${part.name}"><span class="hint">mm of material behind the face this replaces</span></div>
      <div class="btn-row" style="margin-top:var(--space-tight);">
        <button class="btn small" data-asm-remove aria-label="Remove ${part.name}">Remove</button>
      </div>
    `;
  }
  row.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-asm]').forEach((inp) => {
    inp.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      const field = t.dataset.asm as 'pivotX' | 'pivotZ' | 'angleDeg' | 'baseDepth' | 'patchIdx';
      const val = field === 'patchIdx' ? parseInt(t.value, 10) : parseFloat(t.value);
      if (!Number.isFinite(val)) {
        // A cleared field yields '' -> NaN, which reaches three.js as a NaN transform and blanks the viewport (Box3.isEmpty() is false on NaN bounds) — snap back instead.
        t.value = String(part[field]);
        return;
      }
      part[field] = val;
      if (field === 'patchIdx') {
        applyAsmPatchChoice(part);
        // Else the line keeps the face the part loaded with above a dropdown naming another (measured on the footrest, docs/findings/2026-08-24-placement-frame-angle.md).
        const status = row.querySelector('[data-asm-face-status]');
        if (status) status.textContent = faceStatusText(part);
      }
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

  if (!kind) return;
  if (!asmKindCanAutoLoad(kind)) {
    // Two states, one a failure: while stl/parts.json is in flight this is the "Loading assembly…" a selected kind shows before its meshes arrive; once failed, renderAssemblyRoleControls has already said so above.
    if (!partsLibrarySettled()) box.innerHTML = '<div class="hint">Loading assembly…</div>';
    return;
  }

  // One line per part, with face/alignment/remove tucked behind "Advanced", so the default view is "the wheel loaded", not a wall of options.
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
  inner.style.marginTop = 'var(--space-row)';
  parts.forEach((p) => inner.appendChild(buildAsmPartRow(p)));
  det.appendChild(inner);
  box.appendChild(det);
}

export function initAssemblyPanel(): void {
  onAssemblyPartsChanged(() => {
    renderAssemblyRoleControls();
    renderAssemblyPartList();
    // Every placement message names a part, so the parts changing makes one stale. Hooked here, not
    // per caller: the per-caller version sat in `.finally()`, so cancelling "Load the full …?" or
    // "Switch to Kit?" (no change) still wiped the pill telling the user to check their prime tower.
    clearStalePlacementNotices();
    renderWarnings();
    // The thumbnail is the loaded mesh's silhouette: drawn once the mesh is here, re-drawn when a variant swap replaces one.
    refreshShapeThumb();
    // Zone charts resolve asynchronously, so the per-instance zone dropdown and per-zone template links (empty until availableZones() offers something) re-render here too.
    renderArtworkList();
    renderZoneTemplateLinks();
    // The footprint is measured off the built mesh, so it's only right once the part has been (re)built.
    renderBuildParamSize();
    // As is the generated template: a cut-to-artwork hubcap is drawn from the build's outline.
    // Re-issuing only where the shape's INPUTS change (toggle, diameter) misses Scale, Rotate, a
    // flip, an offset or a re-trace, which left a disc template on a silhouette part.
    syncTemplateLink();
  });
  // The href is re-pointed per kind in syncAssemblyKindControls; bind the click once so syncs don't stack handlers.
  const tplLink = $('#asm-template-link');
  if (tplLink)
    tplLink.addEventListener('click', () => {
      const kind = currentAssemblyKind();
      if (kind) track('template_download', { kind: kind.id });
    });
}
