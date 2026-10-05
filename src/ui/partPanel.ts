import { clearBaseColor, DEFAULT_BASE_COLOR, MIN_DESIGN_RADIUS_MM, state } from '../state/store';
import { getFilaments } from '../state/filaments';
import { scheduleRebuild } from '../app/scheduler';
import { requestFrame } from '../scene/viewport';
import { ASSEMBLY_KINDS, firstOfferedKind } from '../assembly/kinds';
import { maybeAutoLoadAssembly } from '../assembly/parts';
import { clampArtworkModes, clearArtworkZoneBindings } from '../state/artwork';
import { renderArtworkList } from './artworkListPanel';
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
import { toFiniteNumber } from '../util/number';
import { track } from '../analytics/track';

/** Push state.asmRadius into the DOM — needed by session restore (state/persist.ts), which sets it directly, not via the input's handler. */
export function refreshShapeParamInputs(): void {
  input('#p-asm-radius').value = String(state.asmRadius);
  // The fields now hold the restored values, so the bindings' last-good caches must follow them.
  resyncShapeInputs();
}

/**
 * Populates the single part dropdown: one assembly part per ASSEMBLY_KINDS entry (value "asm:{id}").
 * A `hidden` kind is listed only while selected (reachable solely via `?kind=`, main.ts); otherwise
 * the select would hold a value with no option, render blank, and make the next switch one-way.
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
  // The kind is only settled here, so the dropdown's membership is too — a hidden kind is listed only while selected.
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
 * Base-color fallback picker: neutral default + owned-filament swatches for the body when no artwork
 * color is grouped into the base (done from the color list — "→ base" / drag-onto-Base in
 * colorList.ts). Only one of artwork base or this fallback is active; picking a swatch clears the
 * artwork base (see clearBaseColor).
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
    // Name is hover/aria-label only: this is the user's own small fixed palette, unlike colorList.ts rows, which show the name as text because nobody chose or named those colors.
    b.title = title;
    b.setAttribute('aria-label', `Use ${title} as the body / blank color`);
    // Selection is a ring, not a hue (convention 19), so it must be stated as well as drawn: a ring is nothing to a screen reader.
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
 * A field's HTML `min` is only advisory on a number input: the user can type 0, a negative, or clear
 * it, and numVal()'s NaN fallback turned an emptied field into a silent 0 — a zero-size dimension
 * reaching geometry with no warning (finding E; diameter 0 just deletes the part). Reads the floor
 * from the input's own `min`, not a hardcoded "> 0", so a field like corner radius, legitimately 0, isn't rejected.
 */
const resyncBoundInput: Array<() => void> = [];

/**
 * Resync every bound field from what it holds, and drop any invalid marking.
 *
 * `lastValid` is seeded at init from the HTML default and written back by the blur handler.
 * Session restore pushes state into the fields directly (refreshShapeParamInputs), so a restored
 * radius of 200 left `lastValid` at the markup's 138: clear, tab away, and the panel disagreed with
 * the export. The marking goes too: clearing the field with the restore banner up, then accepting,
 * left the restored value wearing `.invalid` and "the last valid value stays in use".
 */
export function resyncShapeInputs(): void {
  resyncBoundInput.forEach((f) => f());
}

/** Exported for its own unit test: the only live caller (asmRadius) always sets a numeric `min` first, so the non-numeric-`min` guard has no reachable caller now — a future numeric field bound here without that should still get the guard right. */
export function bindShapeInput(sel: string, apply: (v: number) => void): void {
  const el = input(sel);
  // toFiniteNumber, not bare parseFloat: a non-numeric min= (an authoring mistake) parsed to NaN and `v >= NaN` rejects every value.
  const min = toFiniteNumber(el.min) ?? -Infinity;
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
        ? `Needs a number of at least ${min}. The last valid value stays in use.`
        : 'Needs a number. The last valid value stays in use.';
      return; // don't apply a nonsensical dimension — leave the last good value in state
    }
    el.classList.remove('invalid');
    el.title = '';
    lastValid = v;
    apply(v);
    updateOffsetSliderRanges();
    scheduleRebuild('typed');
  });
  // Snap back on blur rather than leave an invalid value in the field; state held at lastValid throughout, this just makes the field agree.
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
      // The new kind's parts are a different mesh — an old zone binding would match nothing or
      // silently a same-named zone on an unrelated part, so every instance goes back to "every zone" to re-target.
      clearArtworkZoneBindings();
    }
    // Every placement message names a part, so a kind switch invalidates all of them; they were cleared only by the next export, leaving pills naming the previous part over the new one.
    clearStalePlacementNotices();
    applyPartKind();
    track('mode_switch', { kind: 'assembly' });
    // Artwork outlives a part switch, so a design left in Fill by the previous kind is re-clamped before a rebuild — hiding the control alone would leave the old mode live and cutting through the withheld path.
    clampArtworkModes();
    // Rendered here, not left to the scheduled rebuild: a cancel inside the debounce window clears
    // the dirty flag and armed timer (app/scheduler.ts), leaving pills WARNINGS no longer holds.
    // After the clamp, which raises the notice naming what it rewrote.
    renderWarnings();
    // Zone bindings and the assembly-only Sticker/Fill control both change with the part, so rows re-render on every switch, not just an assembly kind change.
    renderArtworkList();
  });
  // assembly design radius
  // Through bindShapeInput like every numeric dimension. A radius must be positive: 0 made every cut
  // fail while Export stayed green, and a negative built as if positive (the design circle is only a
  // magnitude). The bound comes off the input's own `min` and the last good value stays in state
  // while invalid — writing it back makes clear-and-retype impossible, as the hand-rolled version
  // did (backspacing 138 left "1", typing "200" after gave a 1200mm radius).
  // The floor is the shared constant so field and restore can't drift; bindShapeInput reads `min`
  // when it binds, so set it first.
  input('#p-asm-radius').min = String(MIN_DESIGN_RADIUS_MM);
  bindShapeInput('#p-asm-radius', (v) => {
    state.asmRadius = v;
  });
  // The kind's build parameter (the hubcap's disc diameter). On `change`, not `input` like the radius: it regenerates the mesh via a CSG union, so per-keystroke would queue a boolean per digit.
  input('#p-asm-buildparam').addEventListener('change', () => {
    void applyBuildParam(numVal('#p-asm-buildparam', NaN));
  });
  input('#p-asm-silhouette').addEventListener('change', (e) => {
    void applyHubcapSilhouette((e.target as HTMLInputElement).checked);
  });

  renderBaseColorSwatches();
}
