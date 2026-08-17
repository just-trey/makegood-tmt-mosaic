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
export function refreshDepthOverrides(overriddenKeys: string[]): void {
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
  // Bound once on the container, not on the button: refreshDepthOverrides replaces innerHTML on
  // every rebuild, and a listener on the button itself is detached mid-gesture by the very rebuild
  // a pending depth edit schedules, so the click never lands.
  overrides.addEventListener('mousedown', (e) => {
    if (!(e.target as HTMLElement).closest('#depth-reset-all')) return;
    // Same guard as the per-row "↺" (see wireDepthReset in colorList.ts): hold the depth field's
    // blur-`change` off until the press completes, or it re-stores the override this is clearing
    // and schedules the rebuild that replaces this button.
    e.preventDefault();
    e.stopPropagation();
  });
  overrides.addEventListener('mouseup', (e) => {
    if (!(e.target as HTMLElement).closest('#depth-reset-all')) return;
    // Commit any half-typed depth first, in this same tick, then clear. The mousedown guard above
    // only defers that field's blur-`change`; without this it fires *after* the clear and re-stores
    // the very override the user just asked to remove. Measured: typing 3.5 and clicking Reset all
    // left 3.5 in place. Same reason and same fix as the per-row "↺" in colorList.ts.
    const focused = document.activeElement;
    if (focused instanceof HTMLInputElement && focused.classList.contains('depth-input'))
      focused.blur();
    // Every entry, read now rather than from a snapshot taken at render time: a depth typed
    // between the two would not be in that snapshot and would survive. Clearing a stale key costs
    // nothing, since the next prune would drop it anyway.
    Object.keys(state.colorSettings).forEach((k) => delete state.colorSettings[k]);
    scheduleRebuild();
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
