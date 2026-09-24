import { clearBaseColor, DEFAULT_BASE_COLOR, MIN_DESIGN_RADIUS_MM, state } from '../state/store';
import { getFilaments } from '../state/filaments';
import { scheduleRebuild } from '../app/scheduler';
import { requestFrame } from '../scene/viewport';
import { ASSEMBLY_KINDS, firstOfferedKind } from '../assembly/kinds';
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
import { refreshDepthControls } from './depthPanel';
import { refreshShapeThumb } from './shapeThumb';
import { clearStalePlacementNotices } from './exportPanel';
import { renderWarnings } from './warningsView';
import { $, input, numVal } from './dom';
import { track } from '../analytics/track';

/** Push state.asmRadius into the DOM — needed by session restore (state/persist.ts), which sets it
 * directly rather than through the input's own handler. */
export function refreshShapeParamInputs(): void {
  input('#p-asm-radius').value = String(state.asmRadius);
  // The fields now hold the restored values, so the bindings' last-good caches must follow them.
  resyncShapeInputs();
}

/**
 * Populates the single part dropdown: one real assembly part per ASSEMBLY_KINDS entry (value
 * "asm:{id}").
 *
 * A `hidden` kind is listed only while it's the one already selected, which is reachable solely
 * through `?kind=` (main.ts). Without that the select would hold a value with no matching option
 * and render blank, and the next switch away from it would be one-way.
 */
function renderShapeKindOptions(): void {
  const sel = $<HTMLSelectElement>('#shape-kind');
  sel.innerHTML = ASSEMBLY_KINDS.filter((k) => !k.hidden || k.id === state.assembly.kindId)
    .map((k) => `<option value="asm:${k.id}">${k.name}</option>`)
    .join('');
  sel.value = currentAsmOptionValue() || 'asm:' + firstOfferedKind().id;
}

/**
 * Settle the part controls on `state.assembly.kindId` (the first offered kind when none is set):
 * the dropdown, the part's own controls and thumbnail, and the auto-load of its parts.
 */
export function applyPartKind(): void {
  if (!state.assembly.kindId) state.assembly.kindId = firstOfferedKind().id;
  // The kind is only settled here, so the dropdown's membership is too — a hidden kind is
  // listed only while it's the selected one.
  renderShapeKindOptions();
  syncAssemblyKindControls();
  renderAssemblyRoleControls();
  renderAssemblyPartList();
  maybeAutoLoadAssembly(); // just load the wheel — no separate "Load full …" click needed
  // Rendered from the loaded mesh, and re-rendered as parts arrive (assemblyPanel's parts hook).
  refreshShapeThumb();
  updateOffsetSliderRanges();
  refreshDepthControls();
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
    // Name is hover/aria-label only here, deliberately: this is the user's own small fixed
    // palette (unlike the per-artwork rows in colorList.ts, which show the name as visible
    // text because those colors were never chosen or named by anyone).
    b.title = title;
    b.setAttribute('aria-label', `Use ${title} as the body / blank color`);
    // Selection is a ring rather than a hue (convention 19), so it has to be stated as well as
    // drawn: a ring is nothing to a screen reader.
    b.setAttribute('aria-pressed', String(selected));
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
 * A field's HTML `min` (already set per-input in index.html) is only
 * advisory on a number input — the browser doesn't stop the user from typing 0, a negative value,
 * or clearing it entirely, and numVal()'s NaN fallback used to turn an emptied field into a
 * silent 0. That reached the geometry as a zero-size dimension with no warning (finding E) —
 * diameter 0 doesn't error, it just deletes the part. Reads the floor from the input's own `min`
 * rather than hardcoding "> 0" so a field like corner radius, which is legitimately 0, isn't
 * rejected at its own valid floor.
 */
const resyncBoundInput: Array<() => void> = [];

/**
 * Resync every bound field from what it currently holds, and drop any invalid marking.
 *
 * `lastValid` is seeded once at init from the HTML default, and the blur handler writes it back
 * when the field is invalid. Session restore pushes state into these fields directly
 * (refreshShapeParamInputs), so without this a restored radius of 200 left `lastValid` at the
 * markup's 138: clear the field, tab away, and the panel silently disagreed with the export.
 *
 * The marking has to go with it. Clearing the field while the restore banner is up, then
 * accepting the restore, left a field showing the restored value and still wearing `.invalid`
 * plus "the last valid value stays in use until this is fixed", about a value now in use.
 */
export function resyncShapeInputs(): void {
  resyncBoundInput.forEach((f) => f());
}

function bindShapeInput(sel: string, apply: (v: number) => void): void {
  const el = input(sel);
  const min = el.min !== '' ? parseFloat(el.min) : -Infinity;
  const isValid = (v: number) => Number.isFinite(v) && v >= min;
  let lastValid = numVal(sel, min > 0 ? min : 0);
  resyncBoundInput.push(() => {
    const v = numVal(sel, NaN);
    if (!isValid(v)) return;
    lastValid = v;
    el.classList.remove('invalid');
    el.title = '';
  });

  el.addEventListener('input', () => {
    const v = numVal(sel, NaN);
    if (!isValid(v)) {
      el.classList.add('invalid');
      el.title = Number.isFinite(min)
        ? `Needs a number of at least ${min}. The last valid value stays in use until this is fixed.`
        : 'Needs a number. The last valid value stays in use until this is fixed.';
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

/** The "asm:{id}" the shape-kind select should show for the current state (empty if none set). */
function currentAsmOptionValue(): string {
  return state.assembly.kindId ? 'asm:' + state.assembly.kindId : '';
}

export function initPartPanel(): void {
  renderShapeKindOptions();
  $<HTMLSelectElement>('#shape-kind').addEventListener('change', (e) => {
    const sel = e.target as HTMLSelectElement;
    const newKindId = sel.value.slice(4);
    const switchingKind = state.assembly.kindId !== newKindId;
    if (switchingKind) {
      state.assembly.kindId = newKindId;
      state.assembly.parts = [];
      // The new kind's parts are an entirely different mesh — a zone binding from the old kind
      // would either match nothing or (worse) silently match a same-named zone on an unrelated
      // part, so every instance goes back to "every zone the part offers" for the user to
      // re-target from the list.
      clearArtworkZoneBindings();
    }
    // Every placement message names a part, so switching kinds invalidates all of them. They
    // used to be cleared only by the next export, which left pills naming the previous part
    // standing over the new one.
    clearStalePlacementNotices();
    applyPartKind();
    track('mode_switch', { kind: 'assembly' });
    // Artwork outlives a part switch, so a design left in Fill by the previous kind has to be
    // re-clamped against the new one before it reaches a rebuild — hiding the control alone would
    // leave the old mode live and still cut through the withheld path.
    clampArtworkModes();
    // Rendered here, not left to the rebuild this schedules: a cancel honoured inside the
    // debounce window clears both the dirty flag and the armed timer (app/scheduler.ts), which
    // would leave pills on screen that WARNINGS no longer holds. After the clamp, not before it —
    // the clamp raises a notice naming what it rewrote, and a render ahead of it paints nothing.
    renderWarnings();
    // Zone bindings above, and the assembly-only Sticker/Fill control, both change with the
    // part — so the rows re-render on every switch, not just when the assembly kind changed.
    renderArtworkList();
    renderPatternPicker();
  });
  // assembly design radius
  // Through bindShapeInput like every other numeric dimension, rather than its own handler. A
  // radius has to be positive: 0 made every cut fail while Export stayed green, and a negative
  // built as if it were positive, since the design circle is only ever used as a magnitude. The
  // bound comes off the input's own `min`, and the last good value stays in state while the field
  // is invalid — writing it back into the field instead makes clear-and-retype impossible, which
  // is what a hand-rolled version of this did: backspacing 138 left "1" in the box and typing
  // "200" after it gave a 1200mm radius.
  // The floor comes from the shared constant rather than the markup, so the field and the restore
  // path cannot drift apart. bindShapeInput reads `min` when it binds, so this must be set first.
  input('#p-asm-radius').min = String(MIN_DESIGN_RADIUS_MM);
  bindShapeInput('#p-asm-radius', (v) => {
    state.asmRadius = v;
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

  renderBaseColorSwatches();
}
