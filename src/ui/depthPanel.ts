import { state } from '../state/store';
import { scheduleRebuild } from '../app/scheduler';
import { $, input, numVal } from './dom';

/** Push state.globalDepth into the DOM — needed by session restore (state/persist.ts), which sets it directly, not via the control's handler. */
export function refreshDepthControls(): void {
  input('#p-depth').value = String(state.globalDepth);
}

/**
 * How many colors are ignoring the Default depth, shown beside the field that sets it. Convention 4:
 * the override lives in Colors detected, so typing in Default depth could appear to do nothing with
 * no visible cause; the panel's "override below" pointer was the symptom that convention names.
 * This shows the state and offers the way back that existed only per row.
 *
 * Counted from rows on screen, not state.colorSettings, which can hold keys for colors no longer in
 * the artwork until the next prune — a count including those names overrides the user can't see.
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
  // Same gesture contract as the per-row "↺" (wireDepthReset in colorList.ts); this one is bulk and
  // unundoable, so it needs every guard that one has. Delegated to the container: refreshDepthOverrides
  // replaces innerHTML every rebuild, and the rebuild a pending depth edit schedules detaches the
  // button mid-gesture, so a listener on the button never fires.
  const resetBtn = (e: Event): HTMLElement | null => {
    const btn = (e.target as HTMLElement | null)?.closest?.(
      '#depth-reset-all',
    ) as HTMLElement | null;
    // Primary button only: a context-menu press would wipe every override with the menu over the change and nothing to undo it.
    return !btn || (e as MouseEvent).button > 0 ? null : btn;
  };
  let pressed = false;
  let mouseHandled = false;

  const clearAll = () => {
    // Commit any half-typed depth first, this tick. The mousedown guard below only defers that field's blur-`change`, which would fire *after* the clear and re-store the override being removed. Measured: typing 3.5 then clicking Reset all left 3.5.
    const focused = document.activeElement;
    if (focused instanceof HTMLInputElement && focused.classList.contains('depth-input'))
      focused.blur();
    // Only what the readout named. state.colorSettings can hold keys the count never included (unprefixed keys from a session saved in a retired flat mode, colors the shipped filter dropped); clearing those would do more than the button says.
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
    // The press must have started on the button, or a mousedown on the label dragged onto it fires the wipe.
    if (!resetBtn(e) || !started) return;
    e.stopPropagation();
    clearAll();
  });
  // A release elsewhere never reaches the listener above, which would leave `pressed` naming an abandoned press for the next unrelated gesture ending on the button.
  document.addEventListener('mouseup', () => {
    pressed = false;
  });
  overrides.addEventListener('click', (e) => {
    // Enter and Space dispatch only `click`, so without this the button is dead to the keyboard. A real mouseup already decided the pointer case; the synthetic click after it mustn't decide again.
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
}
