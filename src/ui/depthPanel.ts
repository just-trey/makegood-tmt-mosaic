import { state } from '../state/store';
import { scheduleRebuild } from '../app/scheduler';
import { $, input, numVal } from './dom';

/** Push state.globalDepth/recessBg into the DOM — needed by session restore (state/persist.ts),
 * which sets them directly rather than through these controls' own handlers. */
export function refreshDepthControls(): void {
  input('#p-depth').value = String(state.globalDepth);
  input('#p-recess-bg').checked = state.recessBg;
  $('#bg-depth-hint').style.display = state.recessBg ? 'inline' : 'none';
}

/**
 * How many colors are ignoring the Default depth, shown beside the field that sets it.
 *
 * Convention 4: the override lives in Colors detected, so typing in Default depth could appear to
 * do nothing with no visible cause. The panel used to point at the other panel ("override below"),
 * which is the symptom that convention names; this shows the state instead, and offers the way
 * back that previously existed only per row.
 *
 * Counted from the rows on screen rather than from state.colorSettings, which can hold keys for
 * colors no longer in the artwork until the next prune: a count including those would name
 * overrides the user cannot see.
 */
let namedOverrides: string[] = [];

export function refreshDepthOverrides(overriddenKeys: string[]): void {
  namedOverrides = overriddenKeys.slice();
  const box = document.querySelector<HTMLElement>('#depth-overrides');
  if (!box) return;
  const n = overriddenKeys.length;
  if (!n) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.innerHTML =
    `<span>${n} color${n === 1 ? ' uses its' : 's use their'} own depth</span>` +
    `<button type="button" class="btn small" id="depth-reset-all">Reset all</button>`;
  box.hidden = false;
}

export function initDepthPanel(): void {
  const overrides = $('#depth-overrides');
  // The same gesture contract as the per-row "↺" (wireDepthReset in colorList.ts). This one is
  // bulk and unundoable, so it needs every guard that one has, not fewer.
  //
  // Delegated to the container rather than bound to the button: refreshDepthOverrides replaces
  // innerHTML on every rebuild, and the rebuild a pending depth edit schedules detaches the button
  // mid-gesture, so a listener on the button itself never fires.
  const resetBtn = (e: Event): HTMLElement | null => {
    const btn = (e.target as HTMLElement | null)?.closest?.(
      '#depth-reset-all',
    ) as HTMLElement | null;
    // Primary button only, or the press that opens a context menu wipes every override, with the
    // menu drawn over the change and nothing to undo it.
    return !btn || (e as MouseEvent).button > 0 ? null : btn;
  };
  let pressed = false;
  let mouseHandled = false;

  const clearAll = () => {
    // Commit any half-typed depth first, in this same tick. The mousedown guard below only defers
    // that field's blur-`change`; without this it fires *after* the clear and re-stores the very
    // override being removed. Measured: typing 3.5 then clicking Reset all left 3.5 in place.
    const focused = document.activeElement;
    if (focused instanceof HTMLInputElement && focused.classList.contains('depth-input'))
      focused.blur();
    // Only what the readout named. state.colorSettings can also hold keys this count never
    // included: flat-mode entries that survive a switch to an assembly kind, and colors the
    // shipped filter dropped. Clearing those would make the button do more than it says.
    namedOverrides.forEach((k) => delete state.colorSettings[k]);
    scheduleRebuild();
  };

  overrides.addEventListener('mousedown', (e) => {
    pressed = !!resetBtn(e);
    if (!pressed) return;
    e.preventDefault();
    e.stopPropagation();
  });
  overrides.addEventListener('mouseup', (e) => {
    const started = pressed;
    pressed = false;
    mouseHandled = true;
    // Press must have started on the button: otherwise a mousedown on the label, dragged onto it
    // and released, fires the wipe.
    if (!resetBtn(e) || !started) return;
    e.stopPropagation();
    clearAll();
  });
  // A release anywhere else never reaches the listener above, which would leave `pressed` naming an
  // abandoned press for the next unrelated gesture that happens to end on the button.
  document.addEventListener('mouseup', () => {
    pressed = false;
  });
  overrides.addEventListener('click', (e) => {
    // Enter and Space dispatch only `click`, so without this the button is dead to the keyboard.
    // A real mouseup already decided the pointer case one listener above; the synthetic click that
    // follows it must not decide again.
    if (mouseHandled) {
      mouseHandled = false;
      return;
    }
    if (!resetBtn(e)) return;
    clearAll();
  });

  input('#p-depth').addEventListener('input', () => {
    state.globalDepth = numVal('#p-depth', 1.0);
    scheduleRebuild('typed');
  });
  input('#p-recess-bg').addEventListener('change', () => {
    state.recessBg = input('#p-recess-bg').checked;
    $('#bg-depth-hint').style.display = state.recessBg ? 'inline' : 'none';
    scheduleRebuild();
  });
}
