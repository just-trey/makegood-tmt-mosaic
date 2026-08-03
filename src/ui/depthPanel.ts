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

export function initDepthPanel(): void {
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
