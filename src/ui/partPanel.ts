import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import type { ShapeKind } from '../types';
import { clearBaseColor, DEFAULT_BASE_COLOR, state } from '../state/store';
import { getFilaments } from '../state/filaments';
import { scheduleRebuild } from '../app/scheduler';
import { requestFrame } from '../scene/viewport';
import { ASSEMBLY_KINDS } from '../assembly/kinds';
import { maybeAutoLoadAssembly } from '../assembly/parts';
import { clampArtworkModes, clearArtworkZoneBindings } from '../state/artwork';
import { renderArtworkList } from './artworkListPanel';
import { renderPatternPicker } from './artworkPanel';
import {
  applyBuildParam,
  applyHubcapSilhouette,
  renderAssemblyPartList,
  renderAssemblyRoleControls,
  syncAssemblyKindControls,
} from './assemblyPanel';
import { updateOffsetSliderRanges } from './fitPanel';
import { refreshShapeThumb } from './shapeThumb';
import { $, input, numVal } from './dom';
import { track } from '../analytics/track';
import { confirmDialog } from './dialogs';

/**
 * Thumbnails for the flat primitive modes, which have no mesh to draw from until they are built —
 * their shape IS the glyph, so a circle and a rectangle are descriptions rather than icons.
 * Assembly kinds are not in here: their thumbnail is rendered from the part's own mesh (see
 * ui/shapeThumb.ts), because there is no honest glyph for "the chair".
 */
const SHAPE_THUMBS: Record<string, string> = {
  disc: '<svg viewBox="0 0 32 32"><circle class="fill" cx="16" cy="16" r="12"/></svg>',
  rect: '<svg viewBox="0 0 32 32"><rect class="fill" x="4" y="8" width="24" height="16" rx="1"/></svg>',
  round:
    '<svg viewBox="0 0 32 32"><rect class="fill" x="4" y="8" width="24" height="16" rx="5"/></svg>',
  stl: '<svg viewBox="0 0 32 32"><path class="line" d="M16 4 L28 11 L28 21 L16 28 L4 21 L4 11 Z"/><path class="line" d="M4 11 L16 18 L28 11 M16 18 L16 28"/></svg>',
};

/** Push state.disc/rect/round/asmRadius into the DOM — needed by session restore
 * (state/persist.ts), which sets them directly rather than through these inputs' own handlers.
 * stlPlate isn't included: STL reference mode isn't reachable from the shape-kind dropdown (see
 * renderShapeKindOptions), so a restorable session never has it. */
export function refreshShapeParamInputs(): void {
  input('#p-diameter').value = String(state.disc.diameter);
  input('#p-thickness').value = String(state.disc.thickness);
  input('#p-width').value = String(state.rect.width);
  input('#p-height').value = String(state.rect.height);
  input('#p-thickness-r').value = String(state.rect.thickness);
  input('#p-width-rr').value = String(state.round.width);
  input('#p-height-rr').value = String(state.round.height);
  input('#p-corner').value = String(state.round.corner);
  input('#p-thickness-rr').value = String(state.round.thickness);
  input('#p-asm-radius').value = String(state.asmRadius);
}

function setShapeThumb(kind: string): void {
  if (kind === 'assembly') {
    // Rendered from the loaded mesh, and re-rendered as parts arrive (see initPartPanel).
    refreshShapeThumb();
    return;
  }
  const el = $('#shape-thumb');
  if (el) el.innerHTML = SHAPE_THUMBS[kind] || '';
}

/**
 * Populates the single part dropdown: one real assembly part per ASSEMBLY_KINDS entry (value
 * "asm:{id}"), then "disc" — a plain flat-plate insert kept as a quick reference shape. Rect/
 * round/stl remain in the codebase (their param blocks + bindings are untouched) but aren't
 * offered here; picking a real part shouldn't require navigating a second nested dropdown.
 *
 * So three complete UI panels (`#shape-params-rect|round|stl`, their bindings, and the `ShapeKind`
 * branches in state/store.ts) ship in the bundle and nothing renders them — no test drives them
 * either. That is deliberate and was re-confirmed by review (2026-08-02), not something that broke
 * — it is a maintenance question (why keep them compiling), not a bug. If a future part genuinely
 * wants a rect/round/plate flat mode again, the option list below is what to touch: the kinds are
 * excluded by never being written into `sel.innerHTML`, not by the `hidden` filter above it.
 *
 * A `hidden` kind is listed only while it's the one already selected, which is reachable solely
 * through `?kind=` (main.ts). Without that the select would hold a value with no matching option
 * and render blank, and the next switch away from it would be one-way.
 */
function renderShapeKindOptions(): void {
  const sel = $<HTMLSelectElement>('#shape-kind');
  const asmOptions = ASSEMBLY_KINDS.filter((k) => !k.hidden || k.id === state.assembly.kindId)
    .map((k) => `<option value="asm:${k.id}">${k.name}</option>`)
    .join('');
  sel.innerHTML = asmOptions + '<option value="disc">Disc (reference)</option>';
  sel.value = currentAsmOptionValue() || 'disc';
}

export function setShapeKind(kind: ShapeKind): void {
  state.shapeKind = kind;
  (['disc', 'rect', 'round', 'stl', 'assembly'] as const).forEach((k) => {
    const el = $('#shape-params-' + k);
    if (el) el.style.display = k === kind ? 'block' : 'none';
  });
  if (kind === 'assembly') {
    if (!state.assembly.kindId) state.assembly.kindId = ASSEMBLY_KINDS[0].id;
    // The kind is only settled here, so the dropdown's membership is too — a hidden kind is
    // listed only while it's the selected one.
    renderShapeKindOptions();
    syncAssemblyKindControls();
    renderAssemblyRoleControls();
    renderAssemblyPartList();
    maybeAutoLoadAssembly(); // just load the wheel — no separate "Load full …" click needed
  }
  $('#btn-export-stl').style.display = kind === 'assembly' ? 'none' : 'block';
  $('#export-hint').innerHTML =
    kind === 'assembly'
      ? 'Exports a Bambu Studio project 3MF: parts spread across build plates, recesses pre-assigned to filament slots.'
      : '3MF is print-ready for Bambu Studio with colors pre-assigned to filament slots; the STL set is the fallback for other slicers.';
  setShapeThumb(kind);
  updateOffsetSliderRanges();
  requestFrame();
  scheduleRebuild();
}

/**
 * Base-color fallback picker: the neutral default + owned-filament swatches used for the body
 * when no artwork color is grouped into the base (grouping artwork colors into the base is done
 * from the color list below — see "→ base" / drag-onto-Base in colorList.ts). Only one of an
 * artwork base or this fallback is active at a time — picking a swatch here clears any artwork
 * base (see clearBaseColor).
 */
export function renderBaseColorSwatches(): void {
  const box = $('#base-color-swatches');
  if (!box) return;
  box.innerHTML = '';

  const mk = (hex: string, title: string, selected: boolean, onClick: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'base-swatch' + (selected ? ' selected' : '');
    b.style.background = hex;
    b.title = title;
    b.setAttribute('aria-label', `Use ${title} as the body / blank color`);
    b.addEventListener('click', () => {
      onClick();
      renderBaseColorSwatches();
      scheduleRebuild();
    });
    return b;
  };

  box.appendChild(
    mk(
      DEFAULT_BASE_COLOR,
      'Default (neutral grey)',
      !state.baseColorKey && state.baseFilamentId === null,
      () => {
        clearBaseColor();
        state.baseFilamentId = null;
      },
    ),
  );
  getFilaments().forEach((f) =>
    box.appendChild(
      mk(f.hex, f.name, !state.baseColorKey && state.baseFilamentId === f.id, () => {
        clearBaseColor();
        state.baseFilamentId = f.id;
      }),
    ),
  );
}

/**
 * A field's HTML `min` (already set per-input in index.html, e.g. diameter=1, corner=0) is only
 * advisory on a number input — the browser doesn't stop the user from typing 0, a negative value,
 * or clearing it entirely, and numVal()'s NaN fallback used to turn an emptied field into a
 * silent 0. That reached the geometry as a zero-size dimension with no warning (finding E) —
 * diameter 0 doesn't error, it just deletes the part. Reads the floor from the input's own `min`
 * rather than hardcoding "> 0" so a field like corner radius, which is legitimately 0, isn't
 * rejected at its own valid floor.
 */
function bindShapeInput(sel: string, apply: (v: number) => void): void {
  const el = input(sel);
  const min = el.min !== '' ? parseFloat(el.min) : -Infinity;
  const isValid = (v: number) => Number.isFinite(v) && v >= min;
  let lastValid = numVal(sel, min > 0 ? min : 0);

  el.addEventListener('input', () => {
    const v = numVal(sel, NaN);
    if (!isValid(v)) {
      el.classList.add('invalid');
      el.title = Number.isFinite(min)
        ? `Needs a number of at least ${min} — the last valid value stays in use until this is fixed.`
        : 'Needs a number — the last valid value stays in use until this is fixed.';
      return; // don't apply a nonsensical dimension — leave the last good value in state
    }
    el.classList.remove('invalid');
    el.title = '';
    lastValid = v;
    apply(v);
    updateOffsetSliderRanges();
    scheduleRebuild('typed');
  });
  // Snap back on blur rather than leaving an invalid value sitting in the field once the user
  // moves on — state already held at lastValid the whole time, this just makes the field agree.
  el.addEventListener('blur', () => {
    if (!isValid(numVal(sel, NaN))) {
      el.value = String(lastValid);
      el.classList.remove('invalid');
    }
  });
}

function loadSTLReference(file: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    const geo = new STLLoader().parse(reader.result as ArrayBuffer);
    geo.computeBoundingBox();
    const bb = geo.boundingBox!;
    const mat = new THREE.MeshStandardMaterial({
      color: 0x3a4650,
      transparent: true,
      opacity: 0.35,
      roughness: 0.9,
    });
    state.stlRefMesh?.geometry.dispose();
    (state.stlRefMesh?.material as THREE.Material | undefined)?.dispose();
    state.stlRefMesh = new THREE.Mesh(geo, mat);
    $('#stl-fname').textContent = file.name;
    input('#p-facez').value = bb.max.z.toFixed(2);
    input('#p-width-stl').value = (bb.max.x - bb.min.x).toFixed(1);
    input('#p-height-stl').value = (bb.max.y - bb.min.y).toFixed(1);
    state.stlPlate.faceZ = +bb.max.z.toFixed(2);
    state.stlPlate.width = +(bb.max.x - bb.min.x).toFixed(1);
    state.stlPlate.height = +(bb.max.y - bb.min.y).toFixed(1);
    scheduleRebuild();
  };
  reader.readAsArrayBuffer(file);
}

/** The "asm:{id}" the shape-kind select should show for the current state (empty if flat shape). */
function currentAsmOptionValue(): string {
  return state.shapeKind === 'assembly' && state.assembly.kindId
    ? 'asm:' + state.assembly.kindId
    : '';
}

export function initPartPanel(): void {
  renderShapeKindOptions();
  $<HTMLSelectElement>('#shape-kind').addEventListener('change', (e) => {
    void (async () => {
      const sel = e.target as HTMLSelectElement;
      const val = sel.value;
      if (val.startsWith('asm:')) {
        const newKindId = val.slice(4);
        const switchingKind = state.assembly.kindId !== newKindId;
        if (
          switchingKind &&
          state.assembly.parts.length > 0 &&
          !(await confirmDialog('Switching parts will clear the currently loaded ones. Continue?'))
        ) {
          sel.value = currentAsmOptionValue() || 'disc';
          return;
        }
        if (switchingKind) {
          state.assembly.kindId = newKindId;
          state.assembly.parts = [];
          // The new kind's parts are an entirely different mesh — a zone binding from the old kind
          // would either match nothing or (worse) silently match a same-named zone on an unrelated
          // part, so every instance goes back to "every zone the part offers" for the user to
          // re-target from the list.
          clearArtworkZoneBindings();
        }
        setShapeKind('assembly');
        track('mode_switch', { kind: 'assembly' });
      } else {
        setShapeKind(val as ShapeKind);
        track('mode_switch', { kind: val as ShapeKind });
      }
      // Artwork outlives a part switch, so a design left in Fill by the previous kind has to be
      // re-clamped against the new one before it reaches a rebuild — hiding the control alone would
      // leave the old mode live and still cut through the withheld path.
      clampArtworkModes();
      // Zone bindings above, and the assembly-only Sticker/Fill control, both change with the
      // part — so the rows re-render on every switch, not just when the assembly kind changed.
      renderArtworkList();
      renderPatternPicker();
    })();
  });
  setShapeThumb(state.shapeKind); // reflect the initial selection

  // disc
  bindShapeInput('#p-diameter', (v) => {
    state.disc.diameter = v;
  });
  bindShapeInput('#p-thickness', (v) => {
    state.disc.thickness = v;
  });
  // rect
  bindShapeInput('#p-width', (v) => {
    state.rect.width = v;
  });
  bindShapeInput('#p-height', (v) => {
    state.rect.height = v;
  });
  bindShapeInput('#p-thickness-r', (v) => {
    state.rect.thickness = v;
  });
  // rounded rect
  bindShapeInput('#p-width-rr', (v) => {
    state.round.width = v;
  });
  bindShapeInput('#p-height-rr', (v) => {
    state.round.height = v;
  });
  bindShapeInput('#p-corner', (v) => {
    state.round.corner = v;
  });
  bindShapeInput('#p-thickness-rr', (v) => {
    state.round.thickness = v;
  });
  // stl reference plate
  bindShapeInput('#p-width-stl', (v) => {
    state.stlPlate.width = v;
  });
  bindShapeInput('#p-height-stl', (v) => {
    state.stlPlate.height = v;
  });
  bindShapeInput('#p-thickness-stl', (v) => {
    state.stlPlate.thickness = v;
  });
  bindShapeInput('#p-facez', (v) => {
    state.stlPlate.faceZ = v;
  });
  // assembly design radius
  input('#p-asm-radius').addEventListener('input', () => {
    state.asmRadius = numVal('#p-asm-radius', 138);
    updateOffsetSliderRanges();
    scheduleRebuild('typed');
  });
  // The kind's build parameter (the hubcap's disc diameter). On `change`, not `input`, unlike the
  // radius above: this one regenerates the part's mesh through a CSG union, so firing it per
  // keystroke would queue a boolean for each digit typed.
  input('#p-asm-buildparam').addEventListener('change', () => {
    void applyBuildParam(numVal('#p-asm-buildparam', NaN));
  });
  input('#p-asm-silhouette').addEventListener('change', (e) => {
    void applyHubcapSilhouette((e.target as HTMLInputElement).checked);
  });

  // STL reference upload
  const stlDrop = $('#stl-dropzone');
  stlDrop.addEventListener('click', () => input('#stl-input').click());
  input('#stl-input').addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) loadSTLReference(f);
  });
  $('#btn-autoz').addEventListener('click', () => {
    if (state.stlRefMesh) {
      state.stlRefMesh.geometry.computeBoundingBox();
      const z = state.stlRefMesh.geometry.boundingBox!.max.z;
      input('#p-facez').value = z.toFixed(2);
      state.stlPlate.faceZ = +z.toFixed(2);
      scheduleRebuild();
    }
  });

  renderBaseColorSwatches();
}
